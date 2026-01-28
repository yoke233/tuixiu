import { SimpleBox } from "@boxlite-ai/boxlite";

const image = (process.env.BOXLITE_IMAGE || "node:20-slim").trim();
const expected = "Hello from BoxLite Node!";

async function main() {
  const box = new SimpleBox({ image });
  try {
    const result = await box.exec("node", "-e", `console.log(${JSON.stringify(expected)})`);
    process.stdout.write(result.stdout);
    if (!result.stdout.includes(expected)) {
      throw new Error("unexpected stdout");
    }
    if (result.exitCode !== 0) {
      throw new Error(`unexpected exitCode: ${result.exitCode}`);
    }
  } finally {
    await box.stop();
  }
}

main().catch((err) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
