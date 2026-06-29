// File: scripts/seed.js
// Optional CLI seed. For the production-style GUI flow, use the Transfer Agent portal instead.

const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

const ROOT = path.resolve(__dirname, "..");
const DEPLOYMENT_FILE = path.join(ROOT, "relayer", "deployment.json");
const CSV_FILE = path.join(ROOT, "data", "shareholders.csv");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const idx = (name) => headers.indexOf(name.toLowerCase());
  if (idx("wallet") < 0 || idx("shares") < 0) throw new Error("CSV requires Wallet and Shares columns.");
  return lines.slice(1).map((line, i) => {
    const cols = line.split(",").map((c) => c.trim());
    return {
      wallet: ethers.getAddress(cols[idx("wallet")]),
      shares: ethers.parseEther(cols[idx("shares")]),
      label: idx("label") >= 0 ? cols[idx("label")] || `Holder ${i + 1}` : `Holder ${i + 1}`,
      beneficialOwner: idx("beneficialowner") >= 0 ? cols[idx("beneficialowner")] || "" : "",
      custodian: idx("custodian") >= 0 ? cols[idx("custodian")] || "" : ""
    };
  });
}

async function main() {
  if (!fs.existsSync(DEPLOYMENT_FILE)) throw new Error("Deploy contracts before seeding.");
  if (!fs.existsSync(CSV_FILE)) {
    console.log("No data/shareholders.csv found. Nothing to seed.");
    return;
  }

  const deployment = readJson(DEPLOYMENT_FILE);
  const access = await ethers.getContractAt("AccessList", deployment.contracts.accessList);
  const token = await ethers.getContractAt("CompanyToken", deployment.contracts.zynToken);

  const rows = parseCsv(fs.readFileSync(CSV_FILE, "utf8"));
  if (rows.length === 0) throw new Error("No shareholder rows found.");
  await (await access.setShareholders(
    rows.map((r) => r.wallet),
    rows.map((r) => r.shares),
    rows.map((r) => r.label),
    rows.map((r) => r.beneficialOwner),
    rows.map((r) => r.custodian)
  )).wait();
  await (await token.finalizeRecordDate()).wait();
  console.log(`Seeded ${rows.length} shareholder records and finalized record date.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
