import { spawn } from "node:child_process";
import path from "node:path";

const cwd = process.cwd();
const vitestCli = path.join(cwd, "node_modules", "vitest", "dist", "cli.js");

const args = ["run", "src/sandbox/boxliteSandbox.e2e.test.ts"];
const env = { ...process.env, ACP_PROXY_BOXLITE_E2E: "1" };

const child = spawn(process.execPath, [vitestCli, ...args], {
  cwd,
  stdio: "inherit",
  env,
  windowsHide: true,
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});

child.on("error", (err) => {
  console.error(err);
  process.exit(1);
});

