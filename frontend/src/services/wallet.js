// File: frontend/src/services/wallet.js
// Reown AppKit wallet helpers for the configured EVM network, EIP-712 signing, and ERC20 token display.

import { BrowserProvider, getAddress, verifyTypedData } from "ethers";

export const TARGET_CHAIN_ID_DECIMAL = Number(import.meta.env.VITE_CHAIN_ID || 31337);
export const TARGET_CHAIN_ID_HEX =
  import.meta.env.VITE_CHAIN_ID_HEX || `0x${TARGET_CHAIN_ID_DECIMAL.toString(16)}`;
export const TARGET_CHAIN_NAME = import.meta.env.VITE_CHAIN_NAME || "Hardhat Localhost 31337";
export const TARGET_RPC_URL =
  import.meta.env.VITE_RPC_URL || import.meta.env.VITE_HARDHAT_RPC_URL || "http://127.0.0.1:8545";
export const TARGET_NATIVE_CURRENCY_NAME = import.meta.env.VITE_NATIVE_CURRENCY_NAME || "Hardhat ETH";
export const TARGET_NATIVE_CURRENCY_SYMBOL = import.meta.env.VITE_NATIVE_CURRENCY_SYMBOL || "ETH";
export const TARGET_BLOCK_EXPLORER_URL = import.meta.env.VITE_BLOCK_EXPLORER_URL || "";

// Backward-compatible exports used by older local Hardhat code/tests.
export const HARDHAT_CHAIN_ID_DECIMAL = TARGET_CHAIN_ID_DECIMAL;
export const HARDHAT_CHAIN_ID_HEX = TARGET_CHAIN_ID_HEX;

function resolveProvider(walletProvider) {
  return walletProvider || window.ethereum || null;
}

export function hasWalletProvider(walletProvider) {
  const provider = resolveProvider(walletProvider);
  return Boolean(provider && typeof provider.request === "function");
}

export async function ensureTargetNetwork(walletProvider) {
  const provider = resolveProvider(walletProvider);
  if (!hasWalletProvider(provider)) throw new Error("No wallet provider found.");

  const chainId = await provider.request({ method: "eth_chainId" });
  if (String(chainId).toLowerCase() === TARGET_CHAIN_ID_HEX.toLowerCase()) return;

  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: TARGET_CHAIN_ID_HEX }] });
  } catch (error) {
    if (error?.code !== 4902) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: TARGET_CHAIN_ID_HEX,
          chainName: TARGET_CHAIN_NAME,
          nativeCurrency: {
            name: TARGET_NATIVE_CURRENCY_NAME,
            symbol: TARGET_NATIVE_CURRENCY_SYMBOL,
            decimals: 18
          },
          rpcUrls: [TARGET_RPC_URL],
          blockExplorerUrls: TARGET_BLOCK_EXPLORER_URL ? [TARGET_BLOCK_EXPLORER_URL] : []
        }
      ]
    });
  }
}

// Keep the existing import name in App.jsx unchanged so the UI/flow stays untouched.
export const ensureHardhatNetwork = ensureTargetNetwork;

function normalizeAddress(address) {
  if (!address) return null;
  try {
    return getAddress(address);
  } catch (_error) {
    return null;
  }
}

export async function activeWalletAccount(walletProvider) {
  const provider = resolveProvider(walletProvider);
  if (!hasWalletProvider(provider)) throw new Error("No wallet provider found.");

  let accounts = await provider.request({ method: "eth_accounts" });
  if (!accounts?.length) {
    accounts = await provider.request({ method: "eth_requestAccounts" });
  }

  return normalizeAddress(accounts?.[0]) || null;
}

export async function connectedWalletAccounts(walletProvider) {
  const provider = resolveProvider(walletProvider);
  if (!hasWalletProvider(provider)) throw new Error("No wallet provider found.");
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  return (accounts || []).map(normalizeAddress).filter(Boolean);
}

export async function signTypedBallot(account, typedDataForWallet, walletProvider) {
  const provider = resolveProvider(walletProvider);
  const expectedAccount = normalizeAddress(account);

  if (!expectedAccount) throw new Error("No connected account found.");
  if (!hasWalletProvider(provider)) throw new Error("No wallet provider found.");

  const accounts = await connectedWalletAccounts(provider);
  const activeAccount = normalizeAddress(accounts[0]);
  const expectedConnected = accounts.some((candidate) => candidate.toLowerCase() === expectedAccount.toLowerCase());

  if (!expectedConnected) {
    throw new Error(
      `Selected wallet does not match the ballot voter. Reconnect ${expectedAccount} in the wallet modal and try again.`
    );
  }

  if (activeAccount && activeAccount.toLowerCase() !== expectedAccount.toLowerCase()) {
    throw new Error(
      `Your wallet is currently signing as ${activeAccount}. Switch to ${expectedAccount} in your wallet, reconnect, and try again.`
    );
  }

  const { domain, types, message } = typedDataForWallet;
  const cleanTypes = { ...types };
  delete cleanTypes.EIP712Domain;

  const browserProvider = new BrowserProvider(provider);
  const signer = await browserProvider.getSigner(expectedAccount);
  const signature = await signer.signTypedData(domain, cleanTypes, message);

  const recovered = normalizeAddress(verifyTypedData(domain, cleanTypes, message, signature));
  if (!recovered || recovered.toLowerCase() !== expectedAccount.toLowerCase()) {
    throw new Error(
      `Wallet signature was produced by ${recovered || "an unknown account"}, but the ballot belongs to ${expectedAccount}. Switch accounts and reconnect.`
    );
  }

  return signature;
}

export async function watchAsset({ address, symbol, decimals = 18 }, walletProvider) {
  const provider = resolveProvider(walletProvider);
  if (!hasWalletProvider(provider) || !address) return false;

  return provider.request({
    method: "wallet_watchAsset",
    params: {
      type: "ERC20",
      options: { address, symbol, decimals }
    }
  });
}

export function shortAddress(address) {
  if (!address) return "Not connected";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
