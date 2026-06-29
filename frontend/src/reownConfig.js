// File: frontend/src/reownConfig.js
// Reown AppKit configuration for the configured EVM network.

import { createAppKit } from "@reown/appkit/react";
import { EthersAdapter } from "@reown/appkit-adapter-ethers";
import { defineChain } from "@reown/appkit/networks";

const projectId = import.meta.env.VITE_REOWN_PROJECT_ID || "b56e18d47c72ab683b10814fe9495694";
const chainId = Number(import.meta.env.VITE_CHAIN_ID || 31337);
const chainName = import.meta.env.VITE_CHAIN_NAME || "Hardhat Localhost 31337";
const rpcUrl = import.meta.env.VITE_RPC_URL || import.meta.env.VITE_HARDHAT_RPC_URL || "http://127.0.0.1:8545";
const currencyName = import.meta.env.VITE_NATIVE_CURRENCY_NAME || "Hardhat ETH";
const currencySymbol = import.meta.env.VITE_NATIVE_CURRENCY_SYMBOL || "ETH";
const blockExplorerUrl = import.meta.env.VITE_BLOCK_EXPLORER_URL || rpcUrl;

export const targetNetwork = defineChain({
  id: chainId,
  caipNetworkId: `eip155:${chainId}`,
  chainNamespace: "eip155",
  name: chainName,
  nativeCurrency: {
    decimals: 18,
    name: currencyName,
    symbol: currencySymbol
  },
  rpcUrls: {
    default: { http: [rpcUrl] }
  },
  blockExplorers: {
    default: { name: chainName, url: blockExplorerUrl }
  },
  contracts: {}
});

// Keep the old export name available for compatibility with the existing app code.
export const hardhatLocal = targetNetwork;

createAppKit({
  adapters: [new EthersAdapter()],
  networks: [targetNetwork],
  defaultNetwork: targetNetwork,
  projectId,
  metadata: {
    name: "Broadridge Proxy Voting",
    description: "Tokenised proxy voting portal with record-date voting power.",
    url: window.location.origin,
    icons: [`${window.location.origin}/broadridge-logo-white.png`]
  },
  features: {
    analytics: false,
    email: false,
    socials: []
  },
  themeMode: "light",
  themeVariables: {
    "--w3m-accent": "#064BB7",
    "--w3m-color-mix": "#0C2340",
    "--w3m-color-mix-strength": 16,
    "--w3m-border-radius-master": "3px"
  }
});
