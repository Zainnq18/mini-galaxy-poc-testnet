require("dotenv").config();
const { execFileSync } = require("child_process");

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is missing`);
  return value.trim();
}

function rpc(method, params = []) {
  const rpcUrl = required("RPC_URL");

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method,
    params
  });

  const output = execFileSync("curl", [
    "-s",
    "-X", "POST",
    rpcUrl,
    "-H", "Content-Type: application/json",
    "-d", body
  ], { encoding: "utf8" });

  const data = JSON.parse(output);
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

async function main() {
  required("RPC_URL");
  required("RELAYER_PRIVATE_KEY");

  const chainIdHex = rpc("eth_chainId");
  const blockNumberHex = rpc("eth_blockNumber");

  console.log("Testnet RPC is reachable.");
  console.log(`RPC chain ID: ${parseInt(chainIdHex, 16)}`);
  console.log(`Latest block: ${parseInt(blockNumberHex, 16)}`);

  if (parseInt(chainIdHex, 16) !== 80002) {
    throw new Error(`Expected Polygon Amoy chain ID 80002, got ${parseInt(chainIdHex, 16)}`);
  }
}

main().catch((error) => {
  console.error(`Config check failed: ${error.message}`);
  process.exit(1);
});