import { runProxyCli } from "./proxyCli.js";

runProxyCli().catch((err) => {
  console.error(err);
  process.exit(1);
});
