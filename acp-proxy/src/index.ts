import { runProxyCli } from "./runProxyCli.js";

process.on("unhandledRejection", (reason) => {
  console.error("[acp-proxy] unhandledRejection", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[acp-proxy] uncaughtException", err);
  process.exit(1);
});

runProxyCli().catch((err) => {
  console.error(err);
  process.exit(1);
});
