// File: relayer/server.js
// Production-style relayer/API with independent, event-scoped voting deployments.

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
const EVENT_SUMMARY_TTL_MS = Number(process.env.EVENT_SUMMARY_TTL_MS || 5000);
const CATALOG_REFRESH_TTL_MS = Number(process.env.EVENT_CATALOG_TTL_MS || 5000);
const CATALOG_BOOTSTRAP_TIMEOUT_MS = Number(
  process.env.EVENT_CATALOG_BOOTSTRAP_TIMEOUT_MS || 8000
);
const CATALOG_LOOKUP_WAIT_MS = Number(process.env.EVENT_CATALOG_LOOKUP_WAIT_MS || 12000);
const VOTE_TRANSACTION_LOOKUP_TIMEOUT_MS = Number(
  process.env.VOTE_TRANSACTION_LOOKUP_TIMEOUT_MS || 8000
);
const REGISTRY_LOG_INITIAL_SPAN = Number(process.env.REGISTRY_LOG_BLOCK_SPAN || 100000);
const REGISTRY_LOG_MAX_SPAN = Number(process.env.REGISTRY_LOG_MAX_BLOCK_SPAN || 500000);
const REGISTRY_LOG_MIN_SPAN = Number(process.env.REGISTRY_LOG_MIN_BLOCK_SPAN || 500);
const REGISTRY_DISCOVERY_LOOKBACK = Number(process.env.REGISTRY_DISCOVERY_LOOKBACK_BLOCKS || 5000000);
const EVENT_LOG_INITIAL_SPAN = Number(process.env.EVENT_LOG_BLOCK_SPAN || 100000);
const EVENT_LOG_MAX_SPAN = Number(process.env.EVENT_LOG_MAX_BLOCK_SPAN || 500000);
const EVENT_LOG_MIN_SPAN = Number(process.env.EVENT_LOG_MIN_BLOCK_SPAN || 500);

const network = getNetworkProfile();
const provider = new ethers.JsonRpcProvider(network.rpcUrl);

const relayerKey = process.env.RELAYER_PRIVATE_KEY;
if (!relayerKey) {
  console.error("RELAYER_PRIVATE_KEY missing. Copy .env.example to .env.");
  process.exit(1);
}

const wallet = new ethers.Wallet(normalizePrivateKey(relayerKey), provider);
const deployNetworkName = resolveDeployNetwork();
const deployerAddress = addressFromPrivateKey(process.env.DEPLOYER_PRIVATE_KEY);
const deploymentUsesRelayerSigner = Boolean(
  deployerAddress && deployerAddress.toLowerCase() === wallet.address.toLowerCase()
);

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

let relayerTxQueue = Promise.resolve();
let deploymentQueue = Promise.resolve();
let deploymentQueueDepth = 0;

const deploymentCatalog = new Map();
const eventSummaryCache = new Map();
const voteTransactionCache = new Map();
let catalogReady = false;
let catalogScannedThrough = null;
let catalogStartBlock = null;
let catalogLastRefreshAt = 0;
let catalogBootstrapPromise = null;
let catalogRefreshPromise = null;
let catalogWarning = null;

function now() {
  return Math.floor(Date.now() / 1000);
}

function withTimeout(promise, milliseconds, message) {
  const timeoutMs = Math.max(1, Number(milliseconds) || 1);
  let timer;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function currentDeployments() {
  return sortDeployments(deploymentCatalog.values());
}

function normalizePrivateKey(key) {
  const trimmed = String(key || "").trim();
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}

function addressFromPrivateKey(key) {
  if (!key) return null;
  try {
    return new ethers.Wallet(normalizePrivateKey(key)).address;
  } catch (_error) {
    return null;
  }
}

function resolveDeployNetwork() {
  const configured =
    process.env.HARDHAT_DEPLOY_NETWORK ||
    process.env.HARDHAT_NETWORK_NAME ||
    process.env.DEPLOY_NETWORK;
  const value = configured || (network.chainId === 80002 ? "polygonAmoy" : "localhost");
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`Unsafe Hardhat network name: ${value}`);
  }
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
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function artifact(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`Missing artifact ${path.relative(ROOT, file)}. Compile or deploy first.`);
  }
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

function cleanEnv(input) {
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value !== null) output[key] = String(value);
  }
  return output;
}

function runCommand(command, env = process.env) {
  return new Promise((resolve, reject) => {
    exec(
      command,
      {
        cwd: ROOT,
        env: cleanEnv(env),
        windowsHide: true,
        maxBuffer: 1024 * 1024 * 16
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error([stdout, stderr, error.message].filter(Boolean).join("\n").trim()));
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
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

function eventKey(value) {
  return toAddress(value).toLowerCase();
}

function eventIdForDeployment(deployment) {
  return toAddress(deployment.contracts.voting);
}

function normalizeDeployment(input, overrides = {}) {
  if (!input?.deployed || !input?.contracts) return null;

  const accessList = toAddress(input.contracts.accessList);
  const zynToken = toAddress(input.contracts.zynToken);
  const voting = toAddress(input.contracts.voting);
  if ([accessList, zynToken, voting].includes(ZERO_ADDRESS)) return null;

  const deployedAt = input.deployedAt || overrides.deployedAt || new Date().toISOString();
  const normalized = {
    ...input,
    ...overrides,
    deployed: true,
    deployedAt,
    network: {
      ...network,
      ...(input.network || {}),
      ...(overrides.network || {})
    },
    contracts: {
      accessList,
      zynToken,
      voting
    }
  };

  normalized.eventId = voting;
  return normalized;
}

function safeNormalizeDeployment(input, overrides = {}) {
  try {
    return normalizeDeployment(input, overrides);
  } catch (_error) {
    return null;
  }
}

function sourcePriority(source) {
  switch (source) {
    case "deployment-registry-log":
      return 4;
    case "deployment-registry-latest":
      return 3;
    case "runtime":
      return 2;
    default:
      return 1;
  }
}

function upsertDeployment(input) {
  const deployment = safeNormalizeDeployment(input);
  if (!deployment) return null;

  const key = eventKey(deployment.eventId);
  const existing = deploymentCatalog.get(key);
  const incomingPriority = sourcePriority(deployment.source);
  const existingPriority = sourcePriority(existing?.source);

  const merged = {
    ...(existing || {}),
    ...deployment,
    event: deployment.event || existing?.event || null,
    deployedAt: deployment.deployedAt || existing?.deployedAt,
    persistence: deployment.persistence || existing?.persistence,
    source: incomingPriority >= existingPriority ? deployment.source : existing?.source
  };

  deploymentCatalog.set(key, merged);
  return merged;
}

function deploymentTimestamp(deployment) {
  const registryTimestamp = Number(deployment.registryTimestamp || 0);
  if (registryTimestamp) return registryTimestamp;
  const parsed = Date.parse(deployment.deployedAt || "");
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

function sortDeployments(deployments) {
  return [...deployments].sort((left, right) => {
    const blockDifference = Number(right.registryBlockNumber || 0) - Number(left.registryBlockNumber || 0);
    if (blockDifference) return blockDifference;
    const logDifference = Number(right.registryLogIndex || 0) - Number(left.registryLogIndex || 0);
    if (logDifference) return logDifference;
    return deploymentTimestamp(right) - deploymentTimestamp(left);
  });
}

function parseDeploymentJsonValue(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.events)) return value.events;
  if (Array.isArray(value.deployments)) return value.deployments;
  return [value];
}

function loadStaticDeployments() {
  const candidates = [];

  if (process.env.DEPLOYMENT_JSON) {
    try {
      candidates.push(...parseDeploymentJsonValue(JSON.parse(process.env.DEPLOYMENT_JSON)));
    } catch (error) {
      console.warn("DEPLOYMENT_JSON is not valid JSON:", error.message);
    }
  }

  for (const file of [RELAY_DEPLOY, FRONT_DEPLOY, EXPORT_DEPLOY]) {
    candidates.push(...parseDeploymentJsonValue(readJson(file, null)));
  }

  for (const candidate of candidates) {
    const normalized = safeNormalizeDeployment(candidate, {
      source: candidate?.source || "legacy-deployment-file"
    });
    if (normalized && Number(normalized.network?.chainId) === Number(network.chainId)) {
      upsertDeployment(normalized);
    }
  }
}

function saveLatestDeployment(deployment) {
  writeJson(RELAY_DEPLOY, deployment);
  writeJson(FRONT_DEPLOY, deployment);
  writeJson(EXPORT_DEPLOY, deployment);
}

function getRegistryAddress() {
  const value = String(process.env.DEPLOYMENT_REGISTRY_ADDRESS || "").trim();
  if (!value) return null;

  if (!ethers.isAddress(value)) {
    catalogWarning =
      "DEPLOYMENT_REGISTRY_ADDRESS is invalid. Fix it in Render to recover all voting events.";
    return null;
  }

  return toAddress(value);
}

function registryContract(signerOrProvider = wallet) {
  const address = getRegistryAddress();
  if (!address) return null;
  return new ethers.Contract(address, artifact(REGISTRY_ART).abi, signerOrProvider);
}

function registryRecordToDeployment(record) {
  if (!record) return null;

  const deployed = Boolean(record.deployed ?? record[0]);
  if (!deployed) return null;

  const updatedAt = Number(record.updatedAt ?? record[1] ?? 0n);
  const chainId = Number(record.chainId ?? record[2] ?? network.chainId);
  const deployer = toAddress(record.deployer ?? record[3]);
  const accessList = toAddress(record.accessList ?? record[4]);
  const zynToken = toAddress(record.zynToken ?? record[5]);
  const voting = toAddress(record.voting ?? record[6]);

  return normalizeDeployment(
    {
      deployed: true,
      deployedAt: updatedAt ? new Date(updatedAt * 1000).toISOString() : new Date().toISOString(),
      deployer,
      network: { ...network, chainId },
      contracts: { accessList, zynToken, voting },
      event: null
    },
    {
      source: "deployment-registry-latest",
      registryTimestamp: updatedAt
    }
  );
}

function deploymentFromRegistryLog(log, parsed) {
  const args = parsed.args;
  const chainId = Number(args.chainId ?? args[0]);
  const voting = toAddress(args.voting ?? args[1]);
  const deployer = toAddress(args.deployer ?? args[2]);
  const accessList = toAddress(args.accessList ?? args[3]);
  const zynToken = toAddress(args.zynToken ?? args[4]);
  const updatedAt = Number(args.updatedAt ?? args[5] ?? 0n);

  return normalizeDeployment(
    {
      deployed: true,
      deployedAt: updatedAt ? new Date(updatedAt * 1000).toISOString() : new Date().toISOString(),
      deployer,
      network: { ...network, chainId },
      contracts: { accessList, zynToken, voting },
      event: null
    },
    {
      source: "deployment-registry-log",
      registryTimestamp: updatedAt,
      registryBlockNumber: Number(log.blockNumber || 0),
      registryLogIndex: Number(log.index ?? log.logIndex ?? 0),
      registryTxHash: log.transactionHash,
      registryAddress: getRegistryAddress()
    }
  );
}

async function discoverRegistryStartBlock(latestBlock) {
  const configured = Number(process.env.DEPLOYMENT_REGISTRY_FROM_BLOCK);
  if (Number.isInteger(configured) && configured >= 0) return configured;

  const address = getRegistryAddress();
  if (!address) return 0;

  try {
    const currentCode = await provider.getCode(address, latestBlock);
    if (currentCode === "0x") throw new Error("Deployment registry has no bytecode on the configured network.");

    let low = 0;
    let high = latestBlock;

    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const code = await provider.getCode(address, middle);
      if (code && code !== "0x") high = middle;
      else low = middle + 1;
    }

    return low;
  } catch (error) {
    const fallback = Math.max(0, latestBlock - REGISTRY_DISCOVERY_LOOKBACK);
    catalogWarning =
      `Historical registry creation-block discovery failed (${error.shortMessage || error.message}). ` +
      `Scanning from block ${fallback}. Set DEPLOYMENT_REGISTRY_FROM_BLOCK to the registry deployment block ` +
      "if older events are missing.";
    console.warn(catalogWarning);
    return fallback;
  }
}

async function scanRegistryLogs(fromBlock, toBlock) {
  const registry = registryContract(provider);
  if (!registry || fromBlock > toBlock) return;

  const eventFragment = registry.interface.getEvent("DeploymentSaved");
  const topic = eventFragment.topicHash;
  let cursor = fromBlock;
  let span = Math.max(REGISTRY_LOG_MIN_SPAN, REGISTRY_LOG_INITIAL_SPAN);

  while (cursor <= toBlock) {
    const end = Math.min(toBlock, cursor + span - 1);
    let logs;

    try {
      logs = await provider.getLogs({
        address: getRegistryAddress(),
        topics: [topic],
        fromBlock: cursor,
        toBlock: end
      });
    } catch (error) {
      if (span <= REGISTRY_LOG_MIN_SPAN) throw error;
      span = Math.max(REGISTRY_LOG_MIN_SPAN, Math.floor(span / 2));
      continue;
    }

    for (const log of logs) {
      try {
        const parsed = registry.interface.parseLog(log);
        const deployment = deploymentFromRegistryLog(log, parsed);
        if (deployment.network.chainId === Number(network.chainId)) upsertDeployment(deployment);
      } catch (error) {
        console.warn("Ignoring malformed DeploymentSaved log:", error.shortMessage || error.message);
      }
    }

    catalogScannedThrough = end;
    catalogLastRefreshAt = Date.now();
    cursor = end + 1;
    if (logs.length === 0 && span < REGISTRY_LOG_MAX_SPAN) {
      span = Math.min(REGISTRY_LOG_MAX_SPAN, span * 2);
    }
  }
}

async function findLatestMatchingLog({ address, topics, fromBlock = 0, toBlock = null }) {
  const latestBlock = toBlock === null ? await provider.getBlockNumber() : Number(toBlock);
  const minimumBlock = Math.max(0, Number(fromBlock) || 0);
  let cursor = latestBlock;
  let span = Math.max(EVENT_LOG_MIN_SPAN, EVENT_LOG_INITIAL_SPAN);

  while (cursor >= minimumBlock) {
    const start = Math.max(minimumBlock, cursor - span + 1);
    let logs;

    try {
      logs = await provider.getLogs({ address, topics, fromBlock: start, toBlock: cursor });
    } catch (error) {
      if (span <= EVENT_LOG_MIN_SPAN) throw error;
      span = Math.max(EVENT_LOG_MIN_SPAN, Math.floor(span / 2));
      continue;
    }

    if (logs.length) {
      return logs.sort((left, right) => {
        const blockDifference = Number(right.blockNumber || 0) - Number(left.blockNumber || 0);
        if (blockDifference) return blockDifference;
        return Number(right.index ?? right.logIndex ?? 0) - Number(left.index ?? left.logIndex ?? 0);
      })[0];
    }

    cursor = start - 1;
    if (span < EVENT_LOG_MAX_SPAN) span = Math.min(EVENT_LOG_MAX_SPAN, span * 2);
  }

  return null;
}

function voteTransactionCacheKey(eventId, voter) {
  return `${eventKey(eventId)}:${toAddress(voter).toLowerCase()}`;
}

async function getVoteTransactionHash(voting, voter, deployment, hasVoted) {
  if (!hasVoted) return null;

  const key = voteTransactionCacheKey(deployment.eventId, voter);
  const cached = voteTransactionCache.get(key);
  if (cached) return cached;

  const latestBlock = await provider.getBlockNumber();
  const configuredFromBlock = Number(process.env.VOTE_EVENT_FROM_BLOCK);
  const registryBlock = Number(deployment.registryBlockNumber || 0);
  const hasConfiguredStart =
    Number.isInteger(configuredFromBlock) && configuredFromBlock >= 0;

  // Do not make wallet loading wait for a multi-million-block vote-log scan.
  // The event's DeploymentSaved log supplies registryBlockNumber as the catalog scan progresses.
  if (!hasConfiguredStart && registryBlock <= 0) return null;

  const fromBlock = hasConfiguredStart
    ? configuredFromBlock
    : Math.max(0, registryBlock - 100);

  const voteEvent = voting.interface.getEvent("VoteSubmitted");
  const voterTopic = ethers.zeroPadValue(toAddress(voter), 32);
  const log = await withTimeout(
    findLatestMatchingLog({
      address: deployment.contracts.voting,
      topics: [voteEvent.topicHash, voterTopic],
      fromBlock,
      toBlock: latestBlock
    }),
    VOTE_TRANSACTION_LOOKUP_TIMEOUT_MS,
    "Vote transaction lookup timed out."
  );

  const txHash = log?.transactionHash || null;
  if (txHash) voteTransactionCache.set(key, txHash);
  return txHash;
}

async function loadLatestRegistryDeployment() {
  const registry = registryContract(provider);
  if (!registry) return null;

  try {
    const record = await registry.latestDeployment();
    const deployment = registryRecordToDeployment(record);
    if (deployment && deployment.network.chainId === Number(network.chainId)) {
      return upsertDeployment(deployment);
    }
  } catch (error) {
    const detail = error.shortMessage || error.message;
    catalogWarning = `Could not load the latest deployment from the registry: ${detail}`;
    console.warn(catalogWarning);
  }

  return null;
}

async function bootstrapDeploymentCatalog({ force = false } = {}) {
  loadStaticDeployments();

  if (!getRegistryAddress()) {
    if (!catalogWarning) {
      catalogWarning =
        "DEPLOYMENT_REGISTRY_ADDRESS is not configured. Multiple events work until this Render process restarts, " +
        "but only the latest deployment file can be recovered afterward.";
    }
    catalogReady = true;
    catalogLastRefreshAt = Date.now();
    return currentDeployments();
  }

  if (!force && catalogReady && deploymentCatalog.size > 0) {
    return currentDeployments();
  }

  if (!catalogBootstrapPromise) {
    catalogBootstrapPromise = (async () => {
      await loadLatestRegistryDeployment();
      catalogReady = true;
      catalogLastRefreshAt = Date.now();
      return currentDeployments();
    })().finally(() => {
      catalogBootstrapPromise = null;
    });
  }

  try {
    await withTimeout(
      catalogBootstrapPromise,
      CATALOG_BOOTSTRAP_TIMEOUT_MS,
      "Timed out while loading the latest voting event from the deployment registry."
    );
  } catch (error) {
    catalogWarning = error.message;
    console.warn(catalogWarning);
    // Do not fail the page. Static/runtime deployments can still be served while the RPC recovers.
    catalogReady = true;
  }

  return currentDeployments();
}

function beginHistoricalCatalogRefresh({ force = false } = {}) {
  if (!getRegistryAddress()) return null;
  if (catalogRefreshPromise) return catalogRefreshPromise;

  const recentlyRefreshed = Date.now() - catalogLastRefreshAt < CATALOG_REFRESH_TTL_MS;
  if (!force && catalogScannedThrough !== null && recentlyRefreshed) return null;

  catalogRefreshPromise = (async () => {
    // Make the newest event available first. The historical scan must never block normal page loading.
    await loadLatestRegistryDeployment();

    const latestBlock = await provider.getBlockNumber();
    if (catalogStartBlock === null) {
      catalogStartBlock = await discoverRegistryStartBlock(latestBlock);
    }

    const fromBlock =
      catalogScannedThrough === null
        ? catalogStartBlock
        : Math.max(catalogStartBlock, catalogScannedThrough + 1);

    if (fromBlock <= latestBlock) {
      await scanRegistryLogs(fromBlock, latestBlock);
      catalogScannedThrough = latestBlock;
    }

    catalogReady = true;
    catalogLastRefreshAt = Date.now();
    return currentDeployments();
  })()
    .catch((error) => {
      const detail = error.shortMessage || error.message;
      catalogWarning =
        `Historical event discovery is retrying in the background: ${detail}. ` +
        "Set DEPLOYMENT_REGISTRY_FROM_BLOCK in Render to the registry deployment block for the fastest recovery.";
      catalogLastRefreshAt = Date.now();
      console.warn(catalogWarning);
      return currentDeployments();
    })
    .finally(() => {
      catalogRefreshPromise = null;
    });

  return catalogRefreshPromise;
}

async function refreshDeploymentCatalog({ force = false, waitForHistory = false } = {}) {
  await bootstrapDeploymentCatalog({ force: false });

  const historyRefresh = beginHistoricalCatalogRefresh({ force });
  if (waitForHistory && historyRefresh) {
    await historyRefresh;
  }

  return currentDeployments();
}

async function getDeploymentCatalog(options = {}) {
  return refreshDeploymentCatalog(options);
}

async function resolveDeployment(id = null, { strict = true } = {}) {
  const deployments = await getDeploymentCatalog();

  if (!id) {
    const latest = deployments[0] || null;
    if (!latest && strict) throw new Error("No voting event deployed.");
    return latest;
  }

  let key;
  try {
    key = eventKey(id);
  } catch (_error) {
    if (strict) throw new Error("Invalid voting event id.");
    return null;
  }

  let deployment = deploymentCatalog.get(key) || null;

  // A browser may remember an older selected event before the background history scan reaches it.
  // Wait only for this exact lookup, and keep the general event list responsive.
  if (!deployment && getRegistryAddress()) {
    const historyRefresh = beginHistoricalCatalogRefresh({ force: true });
    if (historyRefresh) {
      try {
        await withTimeout(
          historyRefresh,
          CATALOG_LOOKUP_WAIT_MS,
          "The selected voting event is still being recovered. Please retry shortly."
        );
      } catch (_error) {
        // The request receives a clear not-found/retry response below while recovery continues.
      }
      deployment = deploymentCatalog.get(key) || null;
    }
  }

  if (!deployment && strict) throw new Error("Voting event not found or still loading.");
  return deployment;
}

async function codeExists(value) {
  return Boolean(value && ethers.isAddress(value) && (await provider.getCode(value)) !== "0x");
}

async function validateDeployment(deployment) {
  if (!deployment?.deployed) return { ok: false, reason: "No voting event deployed." };

  const addresses = [
    deployment.contracts?.accessList,
    deployment.contracts?.zynToken,
    deployment.contracts?.voting
  ];

  const checks = await Promise.all(addresses.map(codeExists));
  const missingIndex = checks.findIndex((value) => !value);
  if (missingIndex >= 0) {
    return { ok: false, reason: `Stale deployment address: ${addresses[missingIndex]}` };
  }

  return { ok: true };
}

async function getContracts(eventIdOrDeployment = null, strict = true) {
  const deployment =
    eventIdOrDeployment && typeof eventIdOrDeployment === "object"
      ? normalizeDeployment(eventIdOrDeployment)
      : await resolveDeployment(eventIdOrDeployment, { strict });

  if (!deployment) {
    return { deployed: false, reason: "No voting event deployed.", deployment: baseDeployment() };
  }

  const validation = await validateDeployment(deployment);
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

  if (!Number.isInteger(event.votingStartTimestamp) || !Number.isInteger(event.votingEndTimestamp)) {
    throw new Error("Voting timestamps must be whole Unix timestamps.");
  }
  if (event.votingEndTimestamp <= event.votingStartTimestamp) {
    throw new Error("Voting end must be after voting start.");
  }
  if (!Number.isInteger(event.quorumBps) || event.quorumBps < 0 || event.quorumBps > 10000) {
    throw new Error("Quorum must be between 0 and 10000 bps.");
  }
  if (!event.proposals.length) throw new Error("At least one proposal is required.");
  return event;
}

function newestDeploymentOutput(startedAt) {
  const candidates = [RELAY_DEPLOY, FRONT_DEPLOY, EXPORT_DEPLOY]
    .filter((file) => fs.existsSync(file))
    .map((file) => ({
      file,
      modifiedAt: fs.statSync(file).mtimeMs,
      deployment: readJson(file, null)
    }))
    .filter((entry) => entry.deployment?.deployed && entry.modifiedAt >= startedAt - 1500)
    .sort((left, right) => right.modifiedAt - left.modifiedAt);

  return candidates[0]?.deployment || null;
}

function enqueueRelayer(work) {
  const run = relayerTxQueue.then(work, work);
  relayerTxQueue = run.catch(() => undefined);
  return run;
}

function enqueueDeployment(work) {
  deploymentQueueDepth += 1;

  const wrapped = async () => {
    try {
      return await work();
    } finally {
      deploymentQueueDepth = Math.max(0, deploymentQueueDepth - 1);
    }
  };

  const run = deploymentQueue.then(wrapped, wrapped);
  deploymentQueue = run.catch(() => undefined);
  return run;
}

async function persistDeploymentToRegistryUnsafe(deployment) {
  const registry = registryContract(wallet);
  if (!registry) return null;

  const tx = await registry.saveDeployment(
    deployment.network?.chainId || network.chainId,
    deployment.deployer || wallet.address,
    deployment.contracts.accessList,
    deployment.contracts.zynToken,
    deployment.contracts.voting,
    { gasLimit: 600000 }
  );
  const receipt = await tx.wait();

  return {
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    registry: getRegistryAddress()
  };
}

async function persistDeployment(deployment, { registryAlreadySerialized = false } = {}) {
  const registryReceipt = registryAlreadySerialized
    ? await persistDeploymentToRegistryUnsafe(deployment)
    : await enqueueRelayer(() => persistDeploymentToRegistryUnsafe(deployment));

  const normalized = normalizeDeployment(
    {
      ...deployment,
      persistence: registryReceipt
        ? { ...(deployment.persistence || {}), deploymentRegistry: registryReceipt }
        : deployment.persistence
    },
    {
      source: "runtime",
      registryBlockNumber: registryReceipt?.blockNumber,
      registryTxHash: registryReceipt?.txHash,
      registryAddress: registryReceipt?.registry
    }
  );

  upsertDeployment(normalized);
  saveLatestDeployment(normalized);
  eventSummaryCache.delete(eventKey(normalized.eventId));
  catalogLastRefreshAt = 0;
  return normalized;
}

async function runGuiDeployUnsafe(body, { registryAlreadySerialized = false } = {}) {
  const event = validateEventBody(body || {});
  await runCommand("npx hardhat compile");

  const startedAt = Date.now();
  await runCommand(`npx hardhat run scripts/deploy.js --network ${deployNetworkName}`, {
    ...process.env,
    EVENT_CONFIG_JSON: JSON.stringify(event)
  });

  const rawDeployment = newestDeploymentOutput(startedAt);
  if (!rawDeployment) {
    throw new Error("Deployment command completed, but no new deployment output was produced.");
  }

  const deployment = normalizeDeployment(rawDeployment, {
    event: rawDeployment.event || event,
    source: "runtime"
  });

  const validation = await validateDeployment(deployment);
  if (!validation.ok) throw new Error(validation.reason);
  return persistDeployment(deployment, { registryAlreadySerialized });
}

function queueGuiDeploy(body) {
  return enqueueDeployment(async () => {
    if (deploymentUsesRelayerSigner) {
      return enqueueRelayer(() => runGuiDeployUnsafe(body, { registryAlreadySerialized: true }));
    }
    return runGuiDeployUnsafe(body, { registryAlreadySerialized: false });
  });
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
    if (!body || !sig || sig !== expected) return null;
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

async function sendTx(contract, method, args = []) {
  return enqueueRelayer(async () => {
    const tx = await contract[method](...args, { gasLimit: 8000000 });
    const receipt = await tx.wait();
    return { txHash: receipt.hash, blockNumber: receipt.blockNumber };
  });
}

async function mapLimit(items, limit, mapper) {
  const output = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      output[index] = await mapper(items[index], index);
    }
  }

  const workerCount = Math.min(Math.max(1, Number(limit) || 1), Math.max(1, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return output;
}

async function getProposals(voting, includeResults = false) {
  const count = Number(await voting.proposalCount());
  return mapLimit(Array.from({ length: count }, (_, index) => index), 4, async (index) => {
    const [question, options] = await voting.getProposal(index);
    const proposal = { id: index, question, options };
    if (includeResults) proposal.result = (await voting.getResultForProposal(index)).map(display);
    return proposal;
  });
}

async function getRegisterRows(access, token, voting) {
  const wallets = await access.getShareholderWallets();
  return mapLimit(wallets, 5, async (walletAddress) => {
    const [record, balance, snapshotBalance, hasVoted, delegateTo, delegatedPower, effectivePower] =
      await Promise.all([
        access.getShareholderRecord(walletAddress),
        token.balanceOf(walletAddress),
        token.snapshotBalanceOf(walletAddress),
        voting.hasVoted(walletAddress),
        voting.delegateOf(walletAddress),
        voting.delegatedPowerTo(walletAddress),
        voting.effectiveVotingPower(walletAddress)
      ]);

    return {
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
    };
  });
}

function statusFromTimes(startTimestamp, endTimestamp) {
  const current = now();
  if (current < Number(startTimestamp)) return "pending";
  if (current >= Number(endTimestamp)) return "closed";
  return "open";
}

async function getEventSummary(eventIdOrDeployment = null, { useCache = true } = {}) {
  const deployment =
    eventIdOrDeployment && typeof eventIdOrDeployment === "object"
      ? normalizeDeployment(eventIdOrDeployment)
      : await resolveDeployment(eventIdOrDeployment);
  const key = eventKey(deployment.eventId);
  const cached = eventSummaryCache.get(key);

  if (useCache && cached && cached.expiresAt > Date.now()) return cached.value;

  const { token, voting } = await getContracts(deployment);
  const [
    tokenName,
    tokenSymbol,
    snapshotCreated,
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
    token.name(),
    token.symbol(),
    token.recordDateSnapshotCreated(),
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

  const status = statusFromTimes(start, end);
  const value = {
    eventId: deployment.eventId,
    deployed: true,
    deployedAt: deployment.deployedAt,
    source: deployment.source,
    network: deployment.network || network,
    contracts: deployment.contracts,
    event: { issuerName, eventTitle, eventCode, tokenName, tokenSymbol },
    tokenSnapshot: {
      created: snapshotCreated,
      totalSnapshotSupply: display(totalSnapshotSupply)
    },
    voting: {
      startTimestamp: Number(start),
      endTimestamp: Number(end),
      resultsAvailable: status === "closed",
      totalBallots: Number(ballots),
      totalVotingPowerCast: display(cast),
      quorumBps: Number(quorumBps),
      quorumAchieved
    },
    status,
    ongoing: status !== "closed"
  };

  eventSummaryCache.set(key, { value, expiresAt: Date.now() + EVENT_SUMMARY_TTL_MS });
  return value;
}

async function getConfig(eventId = null) {
  const deployment = await resolveDeployment(eventId, { strict: false });
  const exactEventMissing = Boolean(eventId && !deployment);
  const contracts = exactEventMissing
    ? { deployed: false, reason: "Voting event not found or still loading." }
    : await getContracts(deployment, false);

  if (!contracts.deployed) {
    return {
      eventId: deployment?.eventId || eventId || null,
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
    eventCode,
    shareholderRegister,
    proposals
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
    voting.eventCode(),
    getRegisterRows(access, token, voting),
    getProposals(voting, false)
  ]);

  const status = statusFromTimes(start, end);
  return {
    eventId: deployment.eventId,
    deployed: true,
    deployedAt: deployment.deployedAt,
    source: deployment.source,
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
      resultsAvailable: status === "closed",
      totalBallots: Number(ballots),
      totalVotingPowerCast: display(cast),
      quorumBps: Number(quorumBps),
      quorumAchieved
    },
    status,
    shareholderRegister,
    proposals
  };
}

async function getEligibility(value, eventId = null) {
  const voter = toAddress(value);
  const deployment = await resolveDeployment(eventId, { strict: false });
  const exactEventMissing = Boolean(eventId && !deployment);
  const contracts = exactEventMissing
    ? { deployed: false, reason: "Voting event not found or still loading." }
    : await getContracts(deployment, false);

  if (!contracts.deployed) {
    return {
      eventId: deployment?.eventId || eventId || null,
      address: voter,
      deployed: false,
      eligible: false,
      relevant: false,
      accessMode: "view-only",
      viewOnlyReason: contracts.reason || "No voting event deployed."
    };
  }

  const { access, token, voting } = contracts;
  const [
    record,
    balance,
    snapshotBalance,
    snapshotCreated,
    hasVoted,
    nonce,
    symbol,
    name,
    start,
    end,
    delegateTo,
    delegatedPower,
    effectivePower
  ] = await Promise.all([
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
    viewOnlyReason = balance > 0n || record.exists ? "Record date pending" : "View-only";
  } else if (effectivePower === 0n) {
    viewOnlyReason = "View-only";
  } else if (!votingOpen) {
    viewOnlyReason = current < Number(start) ? "Pending" : "Closed";
  } else {
    accessMode = "vote";
    viewOnlyReason = "Ready";
  }

  const relevant = Boolean(
    record.exists ||
      record.blacklisted ||
      balance > 0n ||
      snapshotBalance > 0n ||
      delegatedPower > 0n ||
      effectivePower > 0n ||
      hasVoted ||
      delegatedOut
  );

  let voteTxHash = null;
  if (hasVoted) {
    try {
      voteTxHash = await getVoteTransactionHash(voting, voter, contracts.deployment, hasVoted);
    } catch (error) {
      console.warn(
        `Could not locate VoteSubmitted transaction for ${voter} in ${contracts.deployment.eventId}:`,
        error.shortMessage || error.message
      );
    }
  }

  return {
    eventId: contracts.deployment.eventId,
    address: voter,
    deployed: true,
    relevant,
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
    voteTxHash,
    nonce: Number(nonce),
    votingOpen,
    eligible: accessMode === "vote",
    accessMode,
    viewOnlyReason,
    tokenAddress: contracts.deployment.contracts.zynToken,
    tokenSymbol: symbol,
    tokenName: name,
    decimals: 18
  };
}

function eventSortRank(item) {
  if (item.eligibility?.eligible && item.status === "open") return 0;
  if (item.status === "open") return 1;
  if (item.status === "pending") return 2;
  return 3;
}

async function getWalletEvents(address) {
  const voter = toAddress(address);
  const deployments = await getDeploymentCatalog();
  const rows = await mapLimit(deployments, 3, async (deployment) => {
    try {
      const [summary, eligibility] = await Promise.all([
        getEventSummary(deployment),
        getEligibility(voter, deployment.eventId)
      ]);
      if (!eligibility.relevant) return null;
      return { ...summary, eligibility };
    } catch (error) {
      console.warn(`Could not load wallet event ${deployment.eventId}:`, error.shortMessage || error.message);
      return null;
    }
  });

  const events = rows.filter(Boolean).sort((left, right) => {
    const rankDifference = eventSortRank(left) - eventSortRank(right);
    if (rankDifference) return rankDifference;
    return Number(right.voting?.endTimestamp || 0) - Number(left.voting?.endTimestamp || 0);
  });

  return {
    address: voter,
    events,
    eligibleEventCount: events.filter((item) => item.eligibility?.eligible).length,
    openEventCount: events.filter((item) => item.status === "open").length
  };
}

function parseCsv(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) throw new Error("CSV requires header and rows.");

  const headers = lines[0].split(",").map((header) => header.trim().toLowerCase());
  const idx = (name) => headers.indexOf(name.toLowerCase());
  if (idx("wallet") < 0 || idx("shares") < 0) {
    throw new Error("CSV requires Wallet and Shares columns.");
  }

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
    if (!Number.isInteger(numeric) || numeric < 0 || numeric > 255) {
      throw new Error("Invalid ballot choice.");
    }
    return numeric;
  });
}

function sameChoices(leftValue, rightValue) {
  const left = normalizeChoices(leftValue);
  const right = normalizeChoices(rightValue);
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

function requestedEventId(req) {
  return req.params?.eventId || req.query?.eventId || req.body?.eventId || null;
}

function invalidateEvent(eventId) {
  if (!eventId) return;
  try {
    eventSummaryCache.delete(eventKey(eventId));
  } catch (_error) {
    // Ignore invalid ids here; request validation happens elsewhere.
  }
}

async function healthHandler(_req, res) {
  try {
    loadStaticDeployments();
    refreshDeploymentCatalog().catch((error) => {
      catalogWarning = error.shortMessage || error.message;
    });

    const block = await provider.getBlockNumber();
    res.json({
      ok: true,
      relayer: wallet.address,
      deployer: deployerAddress,
      deploymentUsesRelayerSigner,
      network,
      deployNetworkName,
      deploymentRegistry: getRegistryAddress(),
      deploymentQueueDepth,
      eventCount: deploymentCatalog.size,
      catalogReady,
      catalogScanning: Boolean(catalogRefreshPromise),
      catalogScannedThrough,
      catalogStartBlock,
      catalogWarning,
      block
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
}

app.get("/api/health", healthHandler);
app.get("/health", healthHandler);
app.get("/", healthHandler);

app.post("/api/auth/login", (req, res) => {
  const role = String(req.body?.role || "");
  const password = String(req.body?.password || "");
  if (!passwords[role] || passwords[role] !== password) {
    res.status(401).json({ error: "Invalid password." });
    return;
  }
  res.json({ role, token: makeToken(role) });
});

async function eventsHandler(_req, res) {
  try {
    const deployments = await getDeploymentCatalog();
    const rows = await mapLimit(deployments, 3, async (deployment) => {
      try {
        return await getEventSummary(deployment);
      } catch (error) {
        return {
          eventId: deployment.eventId,
          deployed: true,
          deployedAt: deployment.deployedAt,
          contracts: deployment.contracts,
          status: "unavailable",
          ongoing: false,
          error: error.shortMessage || error.message
        };
      }
    });

    res.json({
      events: rows,
      count: rows.length,
      ongoingCount: rows.filter((item) => item.ongoing).length,
      catalogReady,
      catalogScanning: Boolean(catalogRefreshPromise),
      catalogScannedThrough,
      catalogWarning
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

app.get("/api/events", eventsHandler);

app.get("/api/wallets/:address/events", async (req, res) => {
  try {
    res.json(await getWalletEvents(req.params.address));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

async function configHandler(req, res) {
  try {
    res.json(await getConfig(requestedEventId(req)));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

app.get("/api/config", configHandler);
app.get("/api/events/:eventId/config", configHandler);

async function eligibilityHandler(req, res) {
  try {
    res.json(await getEligibility(req.params.address, requestedEventId(req)));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

app.get("/api/eligibility/:address", eligibilityHandler);
app.get("/api/events/:eventId/eligibility/:address", eligibilityHandler);

app.post("/api/admin/deploy", requireRole("admin"), async (req, res) => {
  try {
    const deployment = await queueGuiDeploy(req.body || {});
    res.json({ ok: true, eventId: deployment.eventId, deployment });
  } catch (error) {
    console.error("GUI deployment failed:", error);
    res.status(500).json({ error: error.message || "Deployment failed." });
  }
});

async function importRegisterHandler(req, res) {
  try {
    const eventId = requestedEventId(req);
    const { access, deployment } = await getContracts(eventId);
    const rows = parseCsv(req.body?.csvText);
    const receipt = await sendTx(access, "setShareholders", [
      rows.map((row) => row.wallet),
      rows.map((row) => units(row.shares)),
      rows.map((row) => row.label),
      rows.map((row) => row.beneficialOwner),
      rows.map((row) => row.custodian)
    ]);
    invalidateEvent(deployment.eventId);
    res.json({ ok: true, eventId: deployment.eventId, imported: rows.length, ...receipt });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

app.post(
  "/api/transfer-agent/import-register",
  requireRole(["admin", "transferAgent"]),
  importRegisterHandler
);
app.post(
  "/api/events/:eventId/transfer-agent/import-register",
  requireRole(["admin", "transferAgent"]),
  importRegisterHandler
);

async function registerHandler(req, res) {
  try {
    const { access, token, voting, deployment } = await getContracts(requestedEventId(req));
    res.json({ eventId: deployment.eventId, rows: await getRegisterRows(access, token, voting) });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

app.get(
  "/api/transfer-agent/register",
  requireRole(["admin", "transferAgent", "inspector", "issuer", "solicitor"]),
  registerHandler
);
app.get(
  "/api/events/:eventId/transfer-agent/register",
  requireRole(["admin", "transferAgent", "inspector", "issuer", "solicitor"]),
  registerHandler
);

async function finalizeRecordDateHandler(req, res) {
  try {
    const { token, deployment } = await getContracts(requestedEventId(req));
    const receipt = await sendTx(token, "finalizeRecordDate");
    invalidateEvent(deployment.eventId);
    res.json({ ok: true, eventId: deployment.eventId, ...receipt });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

app.post(
  "/api/admin/finalize-record-date",
  requireRole(["admin", "transferAgent"]),
  finalizeRecordDateHandler
);
app.post(
  "/api/admin/snapshot",
  requireRole(["admin", "transferAgent"]),
  finalizeRecordDateHandler
);
app.post(
  "/api/events/:eventId/admin/finalize-record-date",
  requireRole(["admin", "transferAgent"]),
  finalizeRecordDateHandler
);
app.post(
  "/api/events/:eventId/admin/snapshot",
  requireRole(["admin", "transferAgent"]),
  finalizeRecordDateHandler
);

async function endVotingHandler(req, res) {
  try {
    const { voting, deployment } = await getContracts(requestedEventId(req));
    const receipt = await sendTx(voting, "endVotingNow");
    invalidateEvent(deployment.eventId);
    res.json({ ok: true, eventId: deployment.eventId, ...receipt });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

app.post("/api/admin/end-now", requireRole(["admin", "issuer"]), endVotingHandler);
app.post(
  "/api/events/:eventId/admin/end-now",
  requireRole(["admin", "issuer"]),
  endVotingHandler
);

async function buildDelegationHandler(req, res) {
  try {
    const delegator = toAddress(req.body?.delegator);
    const delegatee = toAddress(req.body?.delegatee);
    if (delegator === delegatee) throw new Error("Delegate wallet must be different.");

    const { deployment, token, voting } = await getContracts(requestedEventId(req));
    const [snapshotCreated, snapshotBalance, hasVoted, delegateTo, delegateeVoted, nonce] =
      await Promise.all([
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
      eventId: deployment.eventId,
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
}

app.post("/api/build-delegation", buildDelegationHandler);
app.post("/api/events/:eventId/build-delegation", buildDelegationHandler);

async function relayDelegationHandler(req, res) {
  try {
    const delegator = toAddress(req.body?.delegator);
    const delegatee = toAddress(req.body?.delegatee);
    const { deployment, voting } = await getContracts(requestedEventId(req));
    const message = req.body?.message || {};
    const signature = req.body?.signature;

    if (toAddress(message.delegator) !== delegator || toAddress(message.delegatee) !== delegatee) {
      throw new Error("Delegation does not match signed message.");
    }
    if (String(message.votingId) !== "1") throw new Error("Invalid voting id.");

    const typed = {
      domain: await typedDomain(deployment),
      types: delegationTypes,
      primaryType: "Delegation",
      message
    };
    if (toAddress(ethers.verifyTypedData(typed.domain, typed.types, typed.message, signature)) !== delegator) {
      throw new Error("Signature does not match delegator.");
    }

    const receipt = await sendTx(voting, "delegateBySig", [
      delegator,
      delegatee,
      BigInt(message.deadline),
      signature
    ]);
    invalidateEvent(deployment.eventId);
    res.json({ ok: true, eventId: deployment.eventId, ...receipt });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

app.post("/api/relay-delegation", relayDelegationHandler);
app.post("/api/events/:eventId/relay-delegation", relayDelegationHandler);

async function buildBallotHandler(req, res) {
  try {
    const voter = toAddress(req.body?.voter);
    const choices = normalizeChoices(req.body?.choices);
    const { deployment, voting } = await getContracts(requestedEventId(req));
    const eligibility = await getEligibility(voter, deployment.eventId);
    if (!eligibility.eligible) throw new Error(eligibility.viewOnlyReason);
    if (choices.length !== Number(await voting.proposalCount())) {
      throw new Error("Choice count mismatch.");
    }

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
      eventId: deployment.eventId,
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
}

app.post("/api/build-ballot", buildBallotHandler);
app.post("/api/events/:eventId/build-ballot", buildBallotHandler);

async function relayVoteHandler(req, res) {
  try {
    const voter = toAddress(req.body?.voter);
    const choices = normalizeChoices(req.body?.choices);
    const { deployment, voting } = await getContracts(requestedEventId(req));
    const message = req.body?.message || {};
    const signature = req.body?.signature;

    if (toAddress(message.voter) !== voter) {
      throw new Error("Ballot voter does not match signed message.");
    }
    if (String(message.votingId) !== "1") throw new Error("Invalid voting id.");

    let signedChoicesArray = message.choicesArray;
    if (!Array.isArray(signedChoicesArray)) {
      try {
        signedChoicesArray = JSON.parse(message.choices || "[]");
      } catch (_error) {
        signedChoicesArray = [];
      }
    }

    if (!sameChoices(signedChoicesArray, choices)) {
      throw new Error("Choices do not match signed ballot.");
    }

    const expectedChoicesText = choicesText(choices);
    const expectedChoicesHash = choicesHash(choices);
    const packedChoices = packChoices(choices);

    if (String(message.choices) !== expectedChoicesText) {
      throw new Error("Choices do not match signed ballot.");
    }
    if (String(message.choicesHash || "").toLowerCase() !== expectedChoicesHash.toLowerCase()) {
      throw new Error("Choices hash does not match signed ballot.");
    }

    const typed = {
      domain: await typedDomain(deployment),
      types: ballotTypes,
      primaryType: "Ballot",
      message: walletBallotMessage(message)
    };
    const recovered = toAddress(
      ethers.verifyTypedData(typed.domain, typed.types, typed.message, signature)
    );
    if (recovered !== voter) {
      throw new Error(`Signature does not match voter. Signed by ${recovered}, expected ${voter}.`);
    }

    try {
      const receipt = await sendTx(voting, "submitVoteBySig", [
        voter,
        packedChoices,
        message.choices,
        message.choicesHash,
        BigInt(message.deadline),
        signature
      ]);
      invalidateEvent(deployment.eventId);
      voteTransactionCache.set(
        voteTransactionCacheKey(deployment.eventId, voter),
        receipt.txHash
      );
      res.json({ ok: true, eventId: deployment.eventId, ...receipt });
    } catch (contractError) {
      throw new Error(
        contractError.shortMessage ||
          contractError.reason ||
          contractError.message ||
          "Ballot rejected by voting contract."
      );
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

app.post("/api/relay-vote", relayVoteHandler);
app.post("/api/events/:eventId/relay-vote", relayVoteHandler);

async function resultsHandler(req, res) {
  try {
    const { voting, deployment } = await getContracts(requestedEventId(req));
    const end = Number(await voting.votingEndTimestamp());
    if (now() < end) {
      res.json({
        eventId: deployment.eventId,
        available: false,
        secondsRemaining: end - now(),
        proposals: []
      });
      return;
    }

    res.json({
      eventId: deployment.eventId,
      available: true,
      proposals: await getProposals(voting, true)
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

app.get("/api/results", resultsHandler);
app.get("/api/events/:eventId/results", resultsHandler);

async function auditHandler(req, res) {
  try {
    const audit = await getConfig(requestedEventId(req));
    res.json({ eventId: audit.eventId, audit });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

app.get("/api/inspector/audit", requireRole(["admin", "inspector"]), auditHandler);
app.get(
  "/api/events/:eventId/inspector/audit",
  requireRole(["admin", "inspector"]),
  auditHandler
);

async function participationHandler(req, res) {
  try {
    const config = await getConfig(requestedEventId(req));
    const supply = Number(config.tokenSnapshot?.totalSnapshotSupply || 0);
    const cast = Number(config.voting?.totalVotingPowerCast || 0);
    const rows = config.shareholderRegister || [];

    res.json({
      eventId: config.eventId,
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
}

app.get(
  "/api/solicitor/participation",
  requireRole(["admin", "solicitor", "issuer"]),
  participationHandler
);
app.get(
  "/api/events/:eventId/solicitor/participation",
  requireRole(["admin", "solicitor", "issuer"]),
  participationHandler
);

function safeFilePart(value) {
  return String(value || "event")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "event";
}

async function exportHandler(req, res) {
  try {
    const payload = await getConfig(requestedEventId(req));
    const fileName = `proxy-vote-audit-${safeFilePart(payload.event?.eventCode)}-${Date.now()}.json`;
    writeJson(path.join(ROOT, "exports", fileName), payload);
    res.json({ eventId: payload.eventId, fileName, payload });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}

app.get("/api/export-state", requireRole(["admin", "issuer", "inspector"]), exportHandler);
app.get(
  "/api/events/:eventId/export-state",
  requireRole(["admin", "issuer", "inspector"]),
  exportHandler
);

const port = Number(process.env.PORT || process.env.RELAYER_PORT || 4000);

async function start() {
  loadStaticDeployments();

  app.listen(port, () => {
    console.log(`Broadridge proxy voting API running on port ${port}`);
    console.log(`Network: ${network.name} (${network.chainId})`);
    console.log(`Hardhat deploy network: ${deployNetworkName}`);
    console.log(`Relayer wallet: ${wallet.address}`);
    if (deployerAddress) console.log(`Deployer wallet: ${deployerAddress}`);
    if (deploymentUsesRelayerSigner) {
      console.log(
        "DEPLOYER_PRIVATE_KEY and RELAYER_PRIVATE_KEY use the same wallet. " +
          "Deployment and relay transactions are safely serialized to prevent nonce collisions."
      );
    } else if (deployerAddress) {
      console.warn(
        "DEPLOYER_PRIVATE_KEY and RELAYER_PRIVATE_KEY use different wallets. " +
          "The current deployment script assigns contract ownership to the deployer; ensure ownership is transferred to the relayer before using protected role actions."
      );
    }
    if (getRegistryAddress()) console.log(`Deployment registry: ${getRegistryAddress()}`);
  });

  refreshDeploymentCatalog({ force: true }).catch((error) => {
    catalogWarning = error.shortMessage || error.message;
    console.warn("Initial event catalog bootstrap failed:", catalogWarning);
  });
}

start().catch((error) => {
  console.error("API failed to start:", error);
  process.exit(1);
});
