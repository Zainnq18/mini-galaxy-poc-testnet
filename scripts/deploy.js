// File: scripts/deploy.js
// Deploys a clean custom voting event. No event is preinstalled; all event fields are provided by CLI/env or GUI.

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;
const { DEFAULT_QUORUM_BPS, DEFAULT_VOTING_DURATION_SECONDS, DEFAULT_SHAREHOLDER_REGISTRY } = require("../shared/constants");
const { getNetworkProfile } = require("../shared/networkConfig");

function requireText(value, name) {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${name} is required.`);
  return text;
}

function parseEventConfig() {
  const now = Math.floor(Date.now() / 1000);
  const fromJson = process.env.EVENT_CONFIG_JSON ? JSON.parse(process.env.EVENT_CONFIG_JSON) : {};
  const start = Number(fromJson.votingStartTimestamp || process.env.VOTING_START_TIMESTAMP || now + 60);
  const end = Number(
    fromJson.votingEndTimestamp ||
      process.env.VOTING_END_TIMESTAMP ||
      start + Number(process.env.VOTING_DURATION_SECONDS || DEFAULT_VOTING_DURATION_SECONDS)
  );

  const config = {
    issuerName: requireText(fromJson.issuerName || process.env.ISSUER_NAME, "Issuer name"),
    eventTitle: requireText(fromJson.eventTitle || process.env.EVENT_TITLE, "Event title"),
    eventCode: requireText(fromJson.eventCode || process.env.EVENT_CODE, "Event code"),
    tokenName: requireText(fromJson.tokenName || process.env.TOKEN_NAME, "Token name"),
    tokenSymbol: requireText(fromJson.tokenSymbol || process.env.TOKEN_SYMBOL, "Token symbol"),
    votingStartTimestamp: start,
    votingEndTimestamp: end,
    quorumBps: Number(fromJson.quorumBps || process.env.QUORUM_BPS || DEFAULT_QUORUM_BPS),
    proposals: fromJson.proposals || []
  };

  if (config.votingEndTimestamp <= config.votingStartTimestamp) {
    throw new Error("Voting end timestamp must be after voting start timestamp.");
  }
  if (!Array.isArray(config.proposals) || config.proposals.length === 0) {
    throw new Error("At least one proposal is required.");
  }
  for (const [index, proposal] of config.proposals.entries()) {
    if (!proposal.question || !String(proposal.question).trim()) throw new Error(`Proposal ${index + 1} question is required.`);
    if (!Array.isArray(proposal.options) || proposal.options.length < 2) {
      throw new Error(`Proposal ${index + 1} requires at least two options.`);
    }
  }

  return config;
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const event = parseEventConfig();

  const AccessList = await ethers.getContractFactory("AccessList");
  const accessList = await AccessList.deploy(deployer.address, { gasLimit: 4_500_000 });
  await accessList.waitForDeployment();

  if (process.env.SKIP_DEFAULT_REGISTER !== "true" && DEFAULT_SHAREHOLDER_REGISTRY.length > 0) {
    const wallets = DEFAULT_SHAREHOLDER_REGISTRY.map((row) => row.wallet);
    const shares = DEFAULT_SHAREHOLDER_REGISTRY.map((row) => ethers.parseEther(String(row.shares)));
    const labels = DEFAULT_SHAREHOLDER_REGISTRY.map((row) => row.label);
    const beneficialOwners = DEFAULT_SHAREHOLDER_REGISTRY.map((row) => row.beneficialOwner);
    const custodians = DEFAULT_SHAREHOLDER_REGISTRY.map((row) => row.custodian);
    await (await accessList.setShareholders(wallets, shares, labels, beneficialOwners, custodians, { gasLimit: 5_500_000 })).wait();
  }

  const Token = await ethers.getContractFactory("CompanyToken");
  const token = await Token.deploy(event.tokenName, event.tokenSymbol, await accessList.getAddress(), deployer.address, { gasLimit: 5_500_000 });
  await token.waitForDeployment();

  const Voting = await ethers.getContractFactory("ProxyVoting");
  const voting = await Voting.deploy(
    await accessList.getAddress(),
    await token.getAddress(),
    event.issuerName,
    event.eventTitle,
    event.eventCode,
    event.votingStartTimestamp,
    event.votingEndTimestamp,
    event.quorumBps,
    deployer.address,
    { gasLimit: 9_000_000 }
  );
  await voting.waitForDeployment();

  for (const proposal of event.proposals) {
    await (await voting.addProposal(proposal.question, proposal.options, { gasLimit: 3_000_000 })).wait();
  }

  const network = await ethers.provider.getNetwork();
  const deployment = {
    deployed: true,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    network: { ...getNetworkProfile(), chainId: Number(network.chainId) },
    contracts: {
      accessList: await accessList.getAddress(),
      zynToken: await token.getAddress(),
      voting: await voting.getAddress()
    },
    event
  };

  const root = path.resolve(__dirname, "..");
  writeJson(path.join(root, "relayer", "deployment.json"), deployment);
  writeJson(path.join(root, "frontend", "src", "contracts", "proxyDeployment.json"), deployment);
  writeJson(path.join(root, "exports", "deployment.json"), deployment);

  console.log("Deployment complete");
  console.log(JSON.stringify(deployment, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
