function getNetworkProfile() {
  const explicitChainId = process.env.CHAIN_ID || process.env.VITE_CHAIN_ID;
  const inferredChainId = process.env.POLYGON_AMOY_RPC_URL ? 80002 : 31337;
  const chainId = Number(explicitChainId || inferredChainId);
  const isAmoy = chainId === 80002;

  const rpcUrl =
    process.env.RPC_URL ||
    process.env.POLYGON_AMOY_RPC_URL ||
    process.env.VITE_RPC_URL ||
    process.env.VITE_HARDHAT_RPC_URL ||
    "http://127.0.0.1:8545";

  return {
    name: process.env.NETWORK_NAME || (isAmoy ? "Polygon Amoy" : "Hardhat Localhost"),
    chainId,
    rpcUrl,
    currencySymbol: process.env.CURRENCY_SYMBOL || (isAmoy ? "POL" : "ETH"),
    blockExplorerUrl: process.env.BLOCK_EXPLORER_URL || (isAmoy ? "https://amoy.polygonscan.com" : "")
  };
}
module.exports = { getNetworkProfile };
