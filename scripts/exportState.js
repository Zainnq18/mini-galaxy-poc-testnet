const fs = require("fs");
const path = require("path");

async function main() {
  const root = path.resolve(__dirname, "..");
  const source = path.join(root, "relayer", "deployment.json");
  if (!fs.existsSync(source)) throw new Error("No deployment found.");
  const payload = JSON.parse(fs.readFileSync(source, "utf8"));
  const file = path.join(root, "exports", `deployment-export-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + "\n");
  console.log(file);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
