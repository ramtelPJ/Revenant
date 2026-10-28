// npm run setup-check: tells you what is missing before you launch Revenant. Installs and downloads nothing.
// Only loopback addresses and the local Docker CLI are contacted.
import { existsSync } from "node:fs";
import { formatReport, runSetupChecks } from "../src/lib/setup-check.ts";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const { text, ok } = formatReport(await runSetupChecks());
console.log(`\nRevenant setup check\n\n${text}\n`);
process.exit(ok ? 0 : 1);
