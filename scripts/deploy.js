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

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isLocalNetwork(chainId) {
  return chainId === 31337;
}

function isAlreadyVerifiedError(error) {
  const message = String(
    error?.message ||
    error?.shortMessage ||
    error ||
    ""
  ).toLowerCase();

  return (
    message.includes("already verified") ||
    message.includes("already been verified") ||
    message.includes("contract source code already verified")
  );
}

async function verifyContract({
  name,
  address,
  constructorArguments,
  contract,
  attempts = 4,
}) {
  if (!process.env.ETHERSCAN_API_KEY) {
    console.warn(
      `[verification] Skipping ${name}: ETHERSCAN_API_KEY is not configured.`
    );

    return {
      verified: false,
      skipped: true,
      reason: "ETHERSCAN_API_KEY is not configured",
    };
  }

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      console.log(
        `[verification] Verifying ${name} at ${address} ` +
        `(attempt ${attempt}/${attempts})...`
      );

      await hre.run("verify:verify", {
        address,
        constructorArguments,
        contract,
      });

      console.log(`[verification] ${name} verified successfully.`);

      return {
        verified: true,
        address,
      };
    } catch (error) {
      if (isAlreadyVerifiedError(error)) {
        console.log(`[verification] ${name} is already verified.`);

        return {
          verified: true,
          alreadyVerified: true,
          address,
        };
      }

      const message = String(
        error?.message ||
        error?.shortMessage ||
        error
      );

      console.error(
        `[verification] ${name} attempt ${attempt} failed: ${message}`
      );

      if (attempt === attempts) {
        return {
          verified: false,
          address,
          error: message,
        };
      }

      // Explorers sometimes need time to index newly deployed bytecode.
      await sleep(attempt * 15000);
    }
  }

  return {
    verified: false,
    address,
    error: "Verification attempts exhausted",
  };
}

async function verifyEventContracts({
  chainId,
  accessListAddress,
  tokenAddress,
  votingAddress,
  deployerAddress,
  event,
}) {
  if (isLocalNetwork(chainId)) {
    console.log(
      "[verification] Local Hardhat deployments cannot be published to PolygonScan."
    );

    return {
      skipped: true,
      reason: "Local development network",
    };
  }

  console.log(
    "[verification] Waiting for explorer indexing before verification..."
  );

  await sleep(20000);

  const accessList = await verifyContract({
    name: "AccessList",
    address: accessListAddress,
    constructorArguments: [
      deployerAddress,
    ],
    contract: "contracts/AccessList.sol:AccessList",
  });

  const companyToken = await verifyContract({
    name: "CompanyToken",
    address: tokenAddress,
    constructorArguments: [
      event.tokenName,
      event.tokenSymbol,
      accessListAddress,
      deployerAddress,
    ],
    contract: "contracts/CompanyToken.sol:CompanyToken",
  });

  const proxyVoting = await verifyContract({
    name: "ProxyVoting",
    address: votingAddress,
    constructorArguments: [
      accessListAddress,
      tokenAddress,
      event.issuerName,
      event.eventTitle,
      event.eventCode,
      event.votingStartTimestamp,
      event.votingEndTimestamp,
      event.quorumBps,
      deployerAddress,
    ],
    contract: "contracts/ProxyVoting.sol:ProxyVoting",
  });

  return {
    accessList,
    companyToken,
    proxyVoting,
  };
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const event = parseEventConfig();

  const AccessList = await ethers.getContractFactory("AccessList");
  const accessList = await AccessList.deploy(deployer.address, { gasLimit: 4_500_000 });
  await accessList.waitForDeployment();
  if ((await ethers.provider.getNetwork()).chainId !== 31337n) {
  await accessList.deploymentTransaction().wait(3);
}

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
  if ((await ethers.provider.getNetwork()).chainId !== 31337n) {
  await token.deploymentTransaction().wait(3);
}

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
  if ((await ethers.provider.getNetwork()).chainId !== 31337n) {
  await voting.deploymentTransaction().wait(3);
}

  for (const proposal of event.proposals) {
    await (await voting.addProposal(proposal.question, proposal.options, { gasLimit: 3_000_000 })).wait();
  }

const network = await ethers.provider.getNetwork();
const chainId = Number(network.chainId);

const accessListAddress = await accessList.getAddress();
const tokenAddress = await token.getAddress();
const votingAddress = await voting.getAddress();

const explorerBaseUrl =
  chainId === 80002
    ? "https://amoy.polygonscan.com"
    : chainId === 137
      ? "https://polygonscan.com"
      : null;

const verification = await verifyEventContracts({
  chainId,
  accessListAddress,
  tokenAddress,
  votingAddress,
  deployerAddress: deployer.address,
  event,
});

const deployment = {
  deployed: true,
  deployedAt: new Date().toISOString(),
  deployer: deployer.address,

  network: {
    ...getNetworkProfile(),
    chainId,
  },

  contracts: {
    accessList: accessListAddress,
    zynToken: tokenAddress,
    voting: votingAddress,
  },

  explorer: explorerBaseUrl
    ? {
        baseUrl: explorerBaseUrl,
        contracts: {
          accessList: `${explorerBaseUrl}/address/${accessListAddress}#code`,
          zynToken: `${explorerBaseUrl}/address/${tokenAddress}#code`,
          voting: `${explorerBaseUrl}/address/${votingAddress}#code`,
        },
      }
    : null,

  verification,

  event,
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
