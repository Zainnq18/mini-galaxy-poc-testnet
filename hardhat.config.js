// File: hardhat.config.js
require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const DEMO_MNEMONIC = "test test test test test test test test test test test junk";

const networks = {
  hardhat: {
    chainId: 31337,
    accounts: {
      mnemonic: DEMO_MNEMONIC,
      path: "m/44'/60'/0'/0",
      initialIndex: 0,
      count: 20,
      accountsBalance: "10000000000000000000000"
    }
  },
  localhost: {
    url: process.env.RPC_URL || "http://127.0.0.1:8545",
    chainId: 31337
  }
};

if (process.env.POLYGON_AMOY_RPC_URL && process.env.DEPLOYER_PRIVATE_KEY) {
  const polygonAmoy = {
    url: process.env.POLYGON_AMOY_RPC_URL,
    accounts: [process.env.DEPLOYER_PRIVATE_KEY],
    chainId: 80002
  };
  networks.polygonAmoy = polygonAmoy;
  networks.amoy = polygonAmoy;
}

if (process.env.POLYGON_RPC_URL && process.env.DEPLOYER_PRIVATE_KEY) {
  networks.polygon = {
    url: process.env.POLYGON_RPC_URL,
    accounts: [process.env.DEPLOYER_PRIVATE_KEY],
    chainId: 137
  };
}

module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },

  networks,

  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY,
  },

  sourcify: {
    enabled: true,
  },
};
