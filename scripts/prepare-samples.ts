// npm run prepare-samples: installs each sample's dependencies so checks can run offline.
// Needs the internet only for samples that depend on registry packages; the current ones are vendored.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd(), "samples");
const samples = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(path.join(root, entry.name, "package.json")))
  .map((entry) => entry.name)
  .sort();

let failed = 0;
for (const name of samples) {
  const cwd = path.join(root, name);
  // the project's own lifecycle scripts are not run while preparing
  const args = existsSync(path.join(cwd, "package-lock.json"))
    ? ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]
    : ["install", "--ignore-scripts", "--no-audit", "--no-fund"];
  process.stdout.write(`${name}: npm ${args[0]} ... `);
  const result = spawnSync("npm", args, { cwd, encoding: "utf8" });
  if (result.status === 0) console.log("ok");
  else {
    failed++;
    console.log("FAILED");
    console.error((result.stderr || result.stdout || String(result.error)).trim().split("\n").slice(-8).join("\n"));
  }
}
console.log(failed === 0 ? `\n${samples.length} samples ready.` : `\n${failed} of ${samples.length} samples failed.`);
process.exit(failed === 0 ? 0 : 1);
