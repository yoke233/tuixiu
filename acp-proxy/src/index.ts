import { runProxyCli } from "./proxy/index.js";

runProxyCli().catch((err) => {
  console.error(err);
  process.exit(1);
});
