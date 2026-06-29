// File: scripts/deployRegistry.js
// One-time deployment for the on-chain deployment registry used by the hosted relayer.

const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const { getNetworkProfile } = require("../shared/networkConfig");

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  const Registry = await ethers.getContractFactory("DeploymentRegistry");
  const registry = await Registry.deploy(deployer.address);
  await registry.waitForDeployment();

  const address = await registry.getAddress();
  const payload = {
    network: { ...getNetworkProfile(), chainId: Number(network.chainId) },
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    deploymentRegistry: address
  };

  const root = path.resolve(__dirname, "..");
  writeJson(path.join(root, "deployments", "polygonAmoy.registry.json"), payload);

  console.log("Deployment registry deployed");
  console.log(JSON.stringify(payload, null, 2));
  console.log(`DEPLOYMENT_REGISTRY_ADDRESS=${address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
