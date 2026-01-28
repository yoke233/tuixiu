import { spawnSync } from "node:child_process";

const image = (process.env.DOCKER_IMAGE || "node:20-slim").trim();
const expected = "Hello from Docker Node!";

const res = spawnSync(
  "docker",
  ["run", "--rm", image, "node", "-e", `console.log(${JSON.stringify(expected)})`],
  { encoding: "utf8", windowsHide: true },
);

if (res.error) {
  process.stderr.write(`${String(res.error)}\n`);
  process.exit(1);
}

process.stdout.write(res.stdout || "");
process.stderr.write(res.stderr || "");

if (res.status !== 0) {
  process.exit(res.status ?? 1);
}
if (!String(res.stdout || "").includes(expected)) {
  process.stderr.write("unexpected stdout\n");
  process.exit(1);
}
