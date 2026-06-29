// File: scripts/checkTestnetConfig.js
// Safe testnet preflight check. It never prints private keys.

require("dotenv").config();
const { ethers } = require("ethers");
const { getNetworkProfile } = require("../shared/networkConfig");

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is missing`);
  return value;
}

async function main() {
  const rpcUrl = required("RPC_URL");
  const relayerKey = required("RELAYER_PRIVATE_KEY");
  const deployerKey = process.env.DEPLOYER_PRIVATE_KEY || relayerKey;
  const network = getNetworkProfile();

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const chain = await provider.getNetwork();
  const relayer = new ethers.Wallet(relayerKey, provider);
  const deployer = new ethers.Wallet(deployerKey, provider);
  const [relayerBalance, deployerBalance, blockNumber] = await Promise.all([
    provider.getBalance(relayer.address),
    provider.getBalance(deployer.address),
    provider.getBlockNumber()
  ]);

  console.log("Testnet config looks readable.");
  console.log(`Configured network: ${network.name} (${network.chainId})`);
  console.log(`RPC chain ID: ${Number(chain.chainId)}`);
  console.log(`Latest block: ${blockNumber}`);
  console.log(`Relayer wallet: ${relayer.address}`);
  console.log(`Relayer balance: ${ethers.formatEther(relayerBalance)} ${network.currencySymbol}`);
  console.log(`Deployer wallet: ${deployer.address}`);
  console.log(`Deployer balance: ${ethers.formatEther(deployerBalance)} ${network.currencySymbol}`);

  if (Number(chain.chainId) !== Number(network.chainId)) {
    throw new Error(`RPC chain ID ${Number(chain.chainId)} does not match configured CHAIN_ID ${network.chainId}`);
  }
  if (network.chainId === 80002 && relayerBalance === 0n) {
    console.warn("Relayer wallet has 0 POL. The hosted relayer will not be able to pay gas until you fund it.");
  }
}

main().catch((error) => {
  console.error(`Config check failed: ${error.message}`);
  process.exit(1);
});
