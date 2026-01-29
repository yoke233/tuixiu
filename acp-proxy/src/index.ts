import { runProxyCli } from "./runProxyCli.js";

runProxyCli().catch((err) => {
  console.error(err);
  process.exit(1);
});
