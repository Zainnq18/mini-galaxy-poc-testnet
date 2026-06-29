// File: relayer/server.js
// Production-style local relayer/API for GUI deployment, role workspaces, register management, gasless voting, and audit export.

require("dotenv").config();

const cors = require("cors");
const crypto = require("crypto");
const express = require("express");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { ethers } = require("ethers");
const { getNetworkProfile } = require("../shared/networkConfig");

const ROOT = path.resolve(__dirname, "..");
const FRONT_DEPLOY = path.join(ROOT, "frontend", "src", "contracts", "proxyDeployment.json");
const RELAY_DEPLOY = path.join(__dirname, "deployment.json");
const EXPORT_DEPLOY = path.join(ROOT, "exports", "deployment.json");
const ACCESS_ART = path.join(ROOT, "artifacts", "contracts", "AccessList.sol", "AccessList.json");
const TOKEN_ART = path.join(ROOT, "artifacts", "contracts", "CompanyToken.sol", "CompanyToken.json");
const VOTING_ART = path.join(ROOT, "artifacts", "contracts", "ProxyVoting.sol", "ProxyVoting.json");
const REGISTRY_ART = path.join(ROOT, "artifacts", "contracts", "DeploymentRegistry.sol", "DeploymentRegistry.json");

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const network = getNetworkProfile();
const provider = new ethers.JsonRpcProvider(network.rpcUrl);
const relayerKey = process.env.RELAYER_PRIVATE_KEY;
if (!relayerKey) {
  console.error("RELAYER_PRIVATE_KEY missing. Copy .env.example to .env.");
  process.exit(1);
}
const wallet = new ethers.Wallet(relayerKey, provider);
const deployNetworkName = resolveDeployNetwork();
let registryDeploymentCache = null;

const app = express();
app.use(cors());
app.use(express.json({ limit: "8mb" }));

const passwords = {
  admin: process.env.ADMIN_PASSWORD || "broadridge-admin",
  issuer: process.env.ISSUER_PASSWORD || "broadridge-issuer",
  transferAgent: process.env.TRANSFER_AGENT_PASSWORD || "broadridge-ta",
  inspector: process.env.INSPECTOR_PASSWORD || "broadridge-inspector",
  solicitor: process.env.SOLICITOR_PASSWORD || "broadridge-solicitor"
};
const sessionSecret = process.env.SESSION_SECRET || "local-demo-secret-change-me";
let txQueue = Promise.resolve();
let deploying = false;

function now() {
  return Math.floor(Date.now() / 1000);
}

function resolveDeployNetwork() {
  const configured = process.env.HARDHAT_DEPLOY_NETWORK || process.env.HARDHAT_NETWORK_NAME || process.env.DEPLOY_NETWORK;
  const value = configured || (network.chainId === 80002 ? "polygonAmoy" : "localhost");
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`Unsafe Hardhat network name: ${value}`);
  return value;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_error) {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

function artifact(file) {
  if (!fs.existsSync(file)) throw new Error(`Missing artifact ${path.relative(ROOT, file)}. Compile or deploy first.`);
  return readJson(file);
}

function baseDeployment() {
  return {
    deployed: false,
    network,
    contracts: {},
    event: null
  };
}

function loadDeploymentFromEnv() {
  if (!process.env.DEPLOYMENT_JSON) return null;
  try {
    return JSON.parse(process.env.DEPLOYMENT_JSON);
  } catch (error) {
    console.warn("DEPLOYMENT_JSON is not valid JSON:", error.message);
    return null;
  }
}

function loadDeployment() {
  const envDeployment = loadDeploymentFromEnv();
  if (registryDeploymentCache) return registryDeploymentCache;
  if (process.env.DEPLOYMENT_REGISTRY_ADDRESS) return envDeployment || baseDeployment();
  return envDeployment || readJson(RELAY_DEPLOY, null) || readJson(FRONT_DEPLOY, null) || baseDeployment();
}

function saveDeployment(deployment) {
  writeJson(RELAY_DEPLOY, deployment);
  writeJson(FRONT_DEPLOY, deployment);
  writeJson(EXPORT_DEPLOY, deployment);
}

function getRegistryAddress() {
  const value = process.env.DEPLOYMENT_REGISTRY_ADDRESS;
  if (!value) return null;
  return ethers.getAddress(value);
}

function registryContract() {
  const address = getRegistryAddress();
  if (!address) return null;
  return new ethers.Contract(address, artifact(REGISTRY_ART).abi, wallet);
}

function registryRecordToDeployment(record) {
  if (!record || !record.deployed) return null;
  const accessList = ethers.getAddress(record.accessList);
  const zynToken = ethers.getAddress(record.zynToken);
  const voting = ethers.getAddress(record.voting);
  if ([accessList, zynToken, voting].includes(ZERO_ADDRESS)) return null;
  const updatedAt = Number(record.updatedAt || 0n);
  return {
    deployed: true,
    deployedAt: updatedAt ? new Date(updatedAt * 1000).toISOString() : new Date().toISOString(),
    deployer: ethers.getAddress(record.deployer),
    network: { ...network, chainId: Number(record.chainId || network.chainId) },
    source: "deployment-registry",
    contracts: { accessList, zynToken, voting },
    event: null
  };
}

async function loadDeploymentFromRegistry() {
  const registry = registryContract();
  if (!registry) return null;
  try {
    const record = await registry.latestDeployment();
    const deployment = registryRecordToDeployment(record);
    if (deployment) registryDeploymentCache = deployment;
    return deployment;
  } catch (error) {
    console.warn("Could not load deployment from registry:", error.shortMessage || error.message);
    return null;
  }
}

async function persistDeploymentToRegistry(deployment) {
  const registry = registryContract();
  if (!registry) return null;
  const tx = await registry.saveDeployment(
    deployment.network?.chainId || network.chainId,
    deployment.deployer || wallet.address,
    deployment.contracts.accessList,
    deployment.contracts.zynToken,
    deployment.contracts.voting,
    { gasLimit: 600_000 }
  );
  const receipt = await tx.wait();
  registryDeploymentCache = { ...deployment, source: "deployment-registry" };
  return { txHash: receipt.hash, blockNumber: receipt.blockNumber, registry: getRegistryAddress() };
}

async function persistDeployment(deployment) {
  const registryReceipt = await persistDeploymentToRegistry(deployment);
  const enriched = registryReceipt
    ? { ...deployment, persistence: { deploymentRegistry: registryReceipt } }
    : deployment;
  if (registryReceipt) registryDeploymentCache = { ...enriched, source: "deployment-registry" };
  saveDeployment(enriched);
  return enriched;
}

async function codeExists(value) {
  return Boolean(value && ethers.isAddress(value) && (await provider.getCode(value)) !== "0x");
}

async function validateDeployment(deployment = loadDeployment()) {
  if (!deployment?.deployed) return { ok: false, reason: "No voting event deployed." };
  for (const address of [deployment.contracts.accessList, deployment.contracts.zynToken, deployment.contracts.voting]) {
    if (!(await codeExists(address))) return { ok: false, reason: `Stale deployment address: ${address}` };
  }
  return { ok: true };
}

function units(value) {
  return ethers.parseEther(String(value || "0"));
}

function display(value) {
  try {
    return ethers.formatEther(value || 0n);
  } catch (_error) {
    return "0.0";
  }
}

function toAddress(value) {
  return ethers.getAddress(value);
}

function cleanEnv(input) {
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== null) output[key] = String(value);
  }
  return output;
}

function runCommand(command, env = process.env) {
  return new Promise((resolve, reject) => {
    exec(command, { cwd: ROOT, env: cleanEnv(env), windowsHide: true, maxBuffer: 1024 * 1024 * 16 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error([stdout, stderr, error.message].filter(Boolean).join("\n").trim()));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function normalizeProposal(proposal) {
  const question = String(proposal?.question || "").trim();
  const options = Array.isArray(proposal?.options)
    ? proposal.options.map((option) => String(option || "").trim()).filter(Boolean)
    : String(proposal?.optionsText || "")
        .split(/\r?\n|\|/)
        .map((option) => option.trim())
        .filter(Boolean);
  if (!question) throw new Error("Every proposal requires a question.");
  if (options.length < 2) throw new Error(`Proposal '${question}' requires at least two options.`);
  return { question, options };
}

function validateEventBody(body) {
  const start = Number(body.votingStartTimestamp || now() + 60);
  const end = Number(body.votingEndTimestamp || start + 7 * 24 * 60 * 60);
  const event = {
    issuerName: String(body.issuerName || "").trim(),
    eventTitle: String(body.eventTitle || "").trim(),
    eventCode: String(body.eventCode || "").trim(),
    tokenName: String(body.tokenName || "").trim(),
    tokenSymbol: String(body.tokenSymbol || "").trim().toUpperCase(),
    votingStartTimestamp: start,
    votingEndTimestamp: end,
    quorumBps: Number(body.quorumBps || 5000),
    proposals: (body.proposals || []).map(normalizeProposal)
  };
  for (const [key, label] of [
    ["issuerName", "Issuer name"],
    ["eventTitle", "Event title"],
    ["eventCode", "Event code"],
    ["tokenName", "Token name"],
    ["tokenSymbol", "Token symbol"]
  ]) {
    if (!event[key]) throw new Error(`${label} is required.`);
  }
  if (event.votingEndTimestamp <= event.votingStartTimestamp) throw new Error("Voting end must be after voting start.");
  if (event.quorumBps < 0 || event.quorumBps > 10000) throw new Error("Quorum must be between 0 and 10000 bps.");
  if (!event.proposals.length) throw new Error("At least one proposal is required.");
  return event;
}

async function runGuiDeploy(body) {
  const event = validateEventBody(body || {});
  await runCommand("npx hardhat compile");
  await runCommand(`npx hardhat run scripts/deploy.js --network ${deployNetworkName}`, {
    ...process.env,
    EVENT_CONFIG_JSON: JSON.stringify(event)
  });
  const deployment = readJson(RELAY_DEPLOY, null) || readJson(FRONT_DEPLOY, null) || loadDeployment();
  const validation = await validateDeployment(deployment);
  if (!validation.ok) throw new Error(validation.reason);
  return await persistDeployment(deployment);
}

function makeToken(role) {
  const exp = Date.now() + 8 * 60 * 60 * 1000;
  const body = Buffer.from(JSON.stringify({ role, exp })).toString("base64url");
  const sig = crypto.createHmac("sha256", sessionSecret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function readToken(token) {
  try {
    const [body, sig] = String(token || "").split(".");
    const expected = crypto.createHmac("sha256", sessionSecret).update(body).digest("base64url");
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch (_error) {
    return null;
  }
}

function requireRole(roles) {
  const allowed = Array.isArray(roles) ? roles : [roles];
  return (req, res, next) => {
    const payload = readToken(req.header("x-role-token") || req.body?.roleToken);
    if (!payload || !allowed.includes(payload.role)) {
      res.status(401).json({ error: "Access denied." });
      return;
    }
    req.role = payload.role;
    next();
  };
}

async function enqueue(work) {
  const run = txQueue.then(work, work);
  txQueue = run.catch(() => undefined);
  return run;
}

async function sendTx(contract, method, args = []) {
  return enqueue(async () => {
    const tx = await contract[method](...args, { gasLimit: 8_000_000 });
    const receipt = await tx.wait();
    return { txHash: receipt.hash, blockNumber: receipt.blockNumber };
  });
}

async function getContracts(strict = true) {
  let deployment = loadDeployment();
  let validation = await validateDeployment(deployment);
  if (!validation.ok && process.env.DEPLOYMENT_REGISTRY_ADDRESS) {
    const registryDeployment = await loadDeploymentFromRegistry();
    if (registryDeployment) {
      deployment = registryDeployment;
      validation = await validateDeployment(deployment);
    }
  }
  if (!validation.ok) {
    if (strict) throw new Error(validation.reason);
    return { deployed: false, reason: validation.reason, deployment };
  }
  return {
    deployed: true,
    deployment,
    access: new ethers.Contract(deployment.contracts.accessList, artifact(ACCESS_ART).abi, wallet),
    token: new ethers.Contract(deployment.contracts.zynToken, artifact(TOKEN_ART).abi, wallet),
    voting: new ethers.Contract(deployment.contracts.voting, artifact(VOTING_ART).abi, wallet)
  };
}

async function getProposals(voting, includeResults = false) {
  const count = Number(await voting.proposalCount());
  const proposals = [];
  for (let i = 0; i < count; i++) {
    const [question, options] = await voting.getProposal(i);
    const proposal = { id: i, question, options };
    if (includeResults) proposal.result = (await voting.getResultForProposal(i)).map(display);
    proposals.push(proposal);
  }
  return proposals;
}

async function getRegisterRows(access, token, voting) {
  const wallets = await access.getShareholderWallets();
  const rows = [];
  for (const walletAddress of wallets) {
    const record = await access.getShareholderRecord(walletAddress);
    const [balance, snapshotBalance, hasVoted, delegateTo, delegatedPower, effectivePower] = await Promise.all([
      token.balanceOf(walletAddress),
      token.snapshotBalanceOf(walletAddress),
      voting.hasVoted(walletAddress),
      voting.delegateOf(walletAddress),
      voting.delegatedPowerTo(walletAddress),
      voting.effectiveVotingPower(walletAddress)
    ]);
    rows.push({
      wallet: walletAddress,
      exists: record.exists,
      whitelisted: record.whitelisted,
      blacklisted: record.blacklisted,
      recordedShares: display(record.shares),
      label: record.label,
      beneficialOwner: record.beneficialOwner,
      custodian: record.custodian,
      tokenBalance: display(balance),
      snapshotBalance: display(snapshotBalance),
      delegatedPower: display(delegatedPower),
      effectiveVotingPower: display(effectivePower),
      delegateTo: delegateTo === ZERO_ADDRESS ? null : delegateTo,
      hasTokenEntitlement: balance > 0n,
      hasSnapshotVotingPower: snapshotBalance > 0n,
      hasVoted
    });
  }
  return rows;
}

async function getConfig() {
  const deployment = loadDeployment();
  const contracts = await getContracts(false);
  if (!contracts.deployed) {
    return {
      deployed: false,
      reason: contracts.reason,
      network,
      latestBlock: { number: await provider.getBlockNumber() },
      contracts: {},
      event: null,
      token: null,
      tokenSnapshot: null,
      voting: null,
      shareholderRegister: [],
      proposals: []
    };
  }

  const { access, token, voting } = contracts;
  const [
    latestBlock,
    tokenName,
    tokenSymbol,
    totalSupply,
    snapshotCreated,
    snapshotTimestamp,
    totalSnapshotSupply,
    start,
    end,
    ballots,
    cast,
    quorumBps,
    quorumAchieved,
    issuerName,
    eventTitle,
    eventCode
  ] = await Promise.all([
    provider.getBlockNumber(),
    token.name(),
    token.symbol(),
    token.totalSupply(),
    token.recordDateSnapshotCreated(),
    token.recordDateSnapshotTimestamp(),
    token.totalSnapshotSupply(),
    voting.votingStartTimestamp(),
    voting.votingEndTimestamp(),
    voting.totalBallots(),
    voting.totalVotingPowerCast(),
    voting.quorumBps(),
    voting.quorumAchieved(),
    voting.issuerName(),
    voting.eventTitle(),
    voting.eventCode()
  ]);
  const resultsAvailable = now() >= Number(end);
  return {
    deployed: true,
    deployedAt: deployment.deployedAt,
    network: deployment.network || network,
    latestBlock: { number: latestBlock },
    contracts: deployment.contracts,
    event: { issuerName, eventTitle, eventCode, tokenName, tokenSymbol },
    token: { name: tokenName, symbol: tokenSymbol, totalSupply: display(totalSupply) },
    tokenSnapshot: {
      created: snapshotCreated,
      createdAt: Number(snapshotTimestamp),
      totalSnapshotSupply: display(totalSnapshotSupply)
    },
    voting: {
      startTimestamp: Number(start),
      endTimestamp: Number(end),
      resultsAvailable,
      totalBallots: Number(ballots),
      totalVotingPowerCast: display(cast),
      quorumBps: Number(quorumBps),
      quorumAchieved
    },
    shareholderRegister: await getRegisterRows(access, token, voting),
    proposals: await getProposals(voting, false)
  };
}

async function getEligibility(value) {
  const voter = toAddress(value);
  const contracts = await getContracts(false);
  if (!contracts.deployed) {
    return {
      address: voter,
      deployed: false,
      eligible: false,
      accessMode: "view-only",
      viewOnlyReason: "No voting event deployed."
    };
  }
  const { deployment, access, token, voting } = contracts;
  const [record, balance, snapshotBalance, snapshotCreated, hasVoted, nonce, symbol, name, start, end, delegateTo, delegatedPower, effectivePower] = await Promise.all([
    access.getShareholderRecord(voter),
    token.balanceOf(voter),
    token.snapshotBalanceOf(voter),
    token.recordDateSnapshotCreated(),
    voting.hasVoted(voter),
    voting.nonces(voter),
    token.symbol(),
    token.name(),
    voting.votingStartTimestamp(),
    voting.votingEndTimestamp(),
    voting.delegateOf(voter),
    voting.delegatedPowerTo(voter),
    voting.effectiveVotingPower(voter)
  ]);

  const current = now();
  const votingOpen = current >= Number(start) && current < Number(end);
  const delegatedOut = delegateTo !== ZERO_ADDRESS;
  let accessMode = "view-only";
  let viewOnlyReason = "View-only";

  if (record.blacklisted) {
    accessMode = "blocked";
    viewOnlyReason = "Blocked";
  } else if (hasVoted) {
    accessMode = "submitted";
    viewOnlyReason = "Submitted";
  } else if (delegatedOut) {
    accessMode = "delegated";
    viewOnlyReason = "Delegated";
  } else if (!snapshotCreated) {
    viewOnlyReason = balance > 0n ? "Record date pending" : "View-only";
  } else if (effectivePower === 0n) {
    viewOnlyReason = "View-only";
  } else if (!votingOpen) {
    viewOnlyReason = current < Number(start) ? "Pending" : "Closed";
  } else {
    accessMode = "vote";
    viewOnlyReason = "Ready";
  }

  return {
    address: voter,
    deployed: true,
    exists: record.exists,
    whitelisted: record.whitelisted,
    blacklisted: record.blacklisted,
    recordedShares: display(record.shares),
    label: record.label,
    beneficialOwner: record.beneficialOwner,
    custodian: record.custodian,
    balance: display(balance),
    snapshotBalance: display(snapshotBalance),
    delegatedPower: display(delegatedPower),
    effectiveVotingPower: display(effectivePower),
    delegateTo: delegatedOut ? delegateTo : null,
    hasDelegated: delegatedOut,
    hasTokenEntitlement: balance > 0n,
    snapshotCreated,
    hasSnapshotVotingPower: snapshotBalance > 0n,
    hasVoted,
    nonce: Number(nonce),
    votingOpen,
    eligible: accessMode === "vote",
    accessMode,
    viewOnlyReason,
    tokenAddress: deployment.contracts.zynToken,
    tokenSymbol: symbol,
    tokenName: name,
    decimals: 18
  };
}

function parseCsv(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error("CSV requires header and rows.");
  const headers = lines[0].split(",").map((header) => header.trim().toLowerCase());
  const idx = (name) => headers.indexOf(name.toLowerCase());
  if (idx("wallet") < 0 || idx("shares") < 0) throw new Error("CSV requires Wallet and Shares columns.");

  return lines.slice(1).map((line, index) => {
    const cols = line.split(",").map((cell) => cell.trim());
    return {
      wallet: toAddress(cols[idx("wallet")]),
      shares: cols[idx("shares")],
      label: idx("label") >= 0 ? cols[idx("label")] || `Holder ${index + 1}` : `Holder ${index + 1}`,
      beneficialOwner: idx("beneficialowner") >= 0 ? cols[idx("beneficialowner")] || "" : "",
      custodian: idx("custodian") >= 0 ? cols[idx("custodian")] || "" : ""
    };
  });
}

function normalizeChoices(choices) {
  return (choices || []).map((choice) => {
    const numeric = Number(choice);
    if (!Number.isInteger(numeric) || numeric < 0 || numeric > 255) throw new Error("Invalid ballot choice.");
    return numeric;
  });
}

function sameChoices(a, b) {
  const left = normalizeChoices(a);
  const right = normalizeChoices(b);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function choicesText(choices) {
  return JSON.stringify(normalizeChoices(choices));
}

function packChoices(choices) {
  return ethers.hexlify(Uint8Array.from(normalizeChoices(choices)));
}

function choicesHash(choices) {
  return ethers.keccak256(packChoices(choices));
}

function walletBallotMessage(message) {
  return {
    voter: message.voter,
    votingId: message.votingId,
    choices: message.choices,
    choicesHash: message.choicesHash,
    nonce: message.nonce,
    deadline: message.deadline
  };
}

const ballotTypes = {
  Ballot: [
    { name: "voter", type: "address" },
    { name: "votingId", type: "uint256" },
    { name: "choices", type: "string" },
    { name: "choicesHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" }
  ]
};

const delegationTypes = {
  Delegation: [
    { name: "delegator", type: "address" },
    { name: "delegatee", type: "address" },
    { name: "votingId", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" }
  ]
};

async function typedDomain(deployment) {
  const chain = await provider.getNetwork();
  return {
    name: "Broadridge Proxy Voting",
    version: "1",
    chainId: Number(chain.chainId),
    verifyingContract: deployment.contracts.voting
  };
}

app.get("/api/health", async (_req, res) => {
  res.json({ ok: true, relayer: wallet.address, network, deployNetworkName, deploymentRegistry: getRegistryAddress(), block: await provider.getBlockNumber() });
});

app.post("/api/auth/login", (req, res) => {
  const role = String(req.body?.role || "");
  const password = String(req.body?.password || "");
  if (!passwords[role] || passwords[role] !== password) {
    res.status(401).json({ error: "Invalid password." });
    return;
  }
  res.json({ role, token: makeToken(role) });
});

app.get("/api/config", async (_req, res) => {
  try {
    res.json(await getConfig());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/eligibility/:address", async (req, res) => {
  try {
    res.json(await getEligibility(req.params.address));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/admin/deploy", requireRole("admin"), async (req, res) => {
  if (deploying) {
    res.status(409).json({ error: "Deployment already in progress." });
    return;
  }
  deploying = true;
  try {
    const deployment = await runGuiDeploy(req.body || {});
    res.json({ ok: true, deployment });
  } catch (error) {
    console.error("GUI deployment failed:", error);
    res.status(500).json({ error: error.message || "Deployment failed." });
  } finally {
    deploying = false;
  }
});

app.post("/api/transfer-agent/import-register", requireRole(["admin", "transferAgent"]), async (req, res) => {
  try {
    const { access } = await getContracts();
    const rows = parseCsv(req.body?.csvText);
    const receipt = await sendTx(access, "setShareholders", [
      rows.map((row) => row.wallet),
      rows.map((row) => units(row.shares)),
      rows.map((row) => row.label),
      rows.map((row) => row.beneficialOwner),
      rows.map((row) => row.custodian)
    ]);
    res.json({ ok: true, imported: rows.length, ...receipt });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/transfer-agent/register", requireRole(["admin", "transferAgent", "inspector", "issuer", "solicitor"]), async (_req, res) => {
  try {
    const { access, token, voting } = await getContracts();
    res.json({ rows: await getRegisterRows(access, token, voting) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/admin/finalize-record-date", requireRole(["admin", "transferAgent"]), async (_req, res) => {
  try {
    const { token } = await getContracts();
    res.json({ ok: true, ...(await sendTx(token, "finalizeRecordDate")) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/admin/snapshot", requireRole(["admin", "transferAgent"]), async (_req, res) => {
  try {
    const { token } = await getContracts();
    res.json({ ok: true, ...(await sendTx(token, "finalizeRecordDate")) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/admin/end-now", requireRole(["admin", "issuer"]), async (_req, res) => {
  try {
    const { voting } = await getContracts();
    res.json({ ok: true, ...(await sendTx(voting, "endVotingNow")) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});


app.post("/api/build-delegation", async (req, res) => {
  try {
    const delegator = toAddress(req.body?.delegator);
    const delegatee = toAddress(req.body?.delegatee);
    if (delegator === delegatee) throw new Error("Delegate wallet must be different.");

    const { deployment, token, voting } = await getContracts();
    const [snapshotCreated, snapshotBalance, hasVoted, delegateTo, delegateeVoted, nonce] = await Promise.all([
      token.recordDateSnapshotCreated(),
      token.snapshotBalanceOf(delegator),
      voting.hasVoted(delegator),
      voting.delegateOf(delegator),
      voting.hasVoted(delegatee),
      voting.nonces(delegator)
    ]);
    if (!snapshotCreated) throw new Error("Record date has not been finalized.");
    if (snapshotBalance === 0n) throw new Error("No record-date voting power.");
    if (hasVoted) throw new Error("Ballot already submitted.");
    if (delegateTo !== ZERO_ADDRESS) throw new Error("Voting rights already delegated.");
    if (delegateeVoted) throw new Error("Delegate wallet has already voted.");

    const deadline = now() + 900;
    const message = {
      delegator,
      delegatee,
      votingId: "1",
      nonce: nonce.toString(),
      deadline: String(deadline)
    };
    res.json({
      message,
      typedDataForWallet: {
        domain: await typedDomain(deployment),
        types: delegationTypes,
        primaryType: "Delegation",
        message
      }
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/relay-delegation", async (req, res) => {
  try {
    const delegator = toAddress(req.body?.delegator);
    const delegatee = toAddress(req.body?.delegatee);
    const { deployment, voting } = await getContracts();
    const message = req.body?.message;
    const signature = req.body?.signature;
    if (toAddress(message?.delegator) !== delegator || toAddress(message?.delegatee) !== delegatee) {
      throw new Error("Delegation does not match signed message.");
    }
    const typed = {
      domain: await typedDomain(deployment),
      types: delegationTypes,
      primaryType: "Delegation",
      message
    };
    if (toAddress(ethers.verifyTypedData(typed.domain, typed.types, typed.message, signature)) !== delegator) {
      throw new Error("Signature does not match delegator.");
    }
    res.json({ ok: true, ...(await sendTx(voting, "delegateBySig", [delegator, delegatee, BigInt(message.deadline), signature])) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/build-ballot", async (req, res) => {
  try {
    const voter = toAddress(req.body?.voter);
    const choices = normalizeChoices(req.body?.choices);
    const { deployment, voting } = await getContracts();
    const elig = await getEligibility(voter);
    if (!elig.eligible) throw new Error(elig.viewOnlyReason);
    if (choices.length !== Number(await voting.proposalCount())) throw new Error("Choice count mismatch.");

    const nonce = await voting.nonces(voter);
    const deadline = now() + 900;
    const message = {
      voter,
      votingId: "1",
      choices: choicesText(choices),
      choicesArray: choices,
      choicesHash: choicesHash(choices),
      nonce: nonce.toString(),
      deadline: String(deadline)
    };
    res.json({
      message,
      typedDataForWallet: {
        domain: await typedDomain(deployment),
        types: ballotTypes,
        primaryType: "Ballot",
        message: walletBallotMessage(message)
      }
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/relay-vote", async (req, res) => {
  try {
    const voter = toAddress(req.body?.voter);
    const choices = normalizeChoices(req.body?.choices);
    const { deployment, voting } = await getContracts();
    const message = req.body?.message || {};
    const signature = req.body?.signature;
    if (toAddress(message?.voter) !== voter) throw new Error("Ballot voter does not match signed message.");

    let signedChoicesArray = message?.choicesArray;
    if (!Array.isArray(signedChoicesArray)) {
      try { signedChoicesArray = JSON.parse(message?.choices || "[]"); } catch (_error) { signedChoicesArray = []; }
    }
    if (!sameChoices(signedChoicesArray, choices)) throw new Error("Choices do not match signed ballot.");

    const expectedChoicesText = choicesText(choices);
    const expectedChoicesHash = choicesHash(choices);
    const packedChoices = packChoices(choices);
    if (String(message?.choices) !== expectedChoicesText) throw new Error("Choices do not match signed ballot.");
    if (String(message?.choicesHash || "").toLowerCase() !== expectedChoicesHash.toLowerCase()) {
      throw new Error("Choices hash does not match signed ballot.");
    }

    const typed = {
      domain: await typedDomain(deployment),
      types: ballotTypes,
      primaryType: "Ballot",
      message: walletBallotMessage(message)
    };
    const recovered = toAddress(ethers.verifyTypedData(typed.domain, typed.types, typed.message, signature));
    if (recovered !== voter) {
      throw new Error(`Signature does not match voter. Signed by ${recovered}, expected ${voter}.`);
    }
    try {
      res.json({
        ok: true,
        ...(await sendTx(voting, "submitVoteBySig", [
          voter,
          packedChoices,
          message.choices,
          message.choicesHash,
          BigInt(message.deadline),
          signature
        ]))
      });
    } catch (contractError) {
      throw new Error(contractError.shortMessage || contractError.reason || contractError.message || "Ballot rejected by voting contract.");
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/results", async (_req, res) => {
  try {
    const { voting } = await getContracts();
    const end = Number(await voting.votingEndTimestamp());
    if (now() < end) {
      res.json({ available: false, secondsRemaining: end - now(), proposals: [] });
      return;
    }
    res.json({ available: true, proposals: await getProposals(voting, true) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/inspector/audit", requireRole(["admin", "inspector"]), async (_req, res) => {
  try {
    res.json({ audit: await getConfig() });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/solicitor/participation", requireRole(["admin", "solicitor", "issuer"]), async (_req, res) => {
  try {
    const config = await getConfig();
    const supply = Number(config.tokenSnapshot?.totalSnapshotSupply || 0);
    const cast = Number(config.voting?.totalVotingPowerCast || 0);
    const rows = config.shareholderRegister || [];
    res.json({
      participationPct: supply ? (cast / supply) * 100 : 0,
      quorumBps: config.voting?.quorumBps || 0,
      quorumAchieved: Boolean(config.voting?.quorumAchieved),
      voted: rows.filter((row) => row.hasVoted).length,
      pending: rows.filter((row) => row.whitelisted && !row.blacklisted && !row.hasVoted).length,
      rows
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/export-state", requireRole(["admin", "issuer", "inspector"]), async (_req, res) => {
  try {
    const payload = await getConfig();
    const fileName = `proxy-vote-audit-${Date.now()}.json`;
    writeJson(path.join(ROOT, "exports", fileName), payload);
    res.json({ fileName, payload });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

const port = Number(process.env.PORT || process.env.RELAYER_PORT || 4000);

async function start() {
  if (process.env.DEPLOYMENT_REGISTRY_ADDRESS) {
    await loadDeploymentFromRegistry();
  }
  app.listen(port, () => {
    console.log(`Broadridge proxy voting API running on port ${port}`);
    console.log(`Network: ${network.name} (${network.chainId})`);
    console.log(`Hardhat deploy network: ${deployNetworkName}`);
    console.log(`Relayer wallet: ${wallet.address}`);
    if (process.env.DEPLOYMENT_REGISTRY_ADDRESS) console.log(`Deployment registry: ${getRegistryAddress()}`);
  });
}

start().catch((error) => {
  console.error("API failed to start:", error);
  process.exit(1);
});
