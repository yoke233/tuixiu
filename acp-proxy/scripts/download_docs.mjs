import fs from "node:fs/promises";
import path from "node:path";

const targetDir = String.raw`d:\xyad\tuixiu-acp\acp-proxy\acp-protocol`;
const llmsUrl = "https://agentclientprotocol.com/llms.txt";

async function main() {
  // 1. Clean up target directory
  try {
    await fs.rm(targetDir, { recursive: true, force: true });
    await fs.mkdir(targetDir, { recursive: true });
    console.log(`Cleaned target directory: ${targetDir}`);
  } catch (err) {
    console.error("Failed to clean directory:", err);
    return;
  }

  // 2. Fetch llms.txt
  console.log(`Fetching index from ${llmsUrl}...`);
  let indexContent = "";
  try {
    const res = await fetch(llmsUrl);
    if (!res.ok)
      throw new Error(`Failed to fetch index: ${res.status} ${res.statusText}`);
    indexContent = await res.text();
  } catch (err) {
    console.error("Error fetching index:", err);
    return;
  }

  // 3. Parse links
  // Format: - [Title](https://...) : Description
  const regex = /- \[(.*?)\]\((https:\/\/.*?)\)/g;
  const matches = [...indexContent.matchAll(regex)];

  console.log(`Found ${matches.length} documents to download.`);

  // 4. Download each file
  for (const match of matches) {
    let title = match[1].trim();
    const url = match[2];

    // Sanitize title to be a valid filename
    // Replace invalid chars with underscore or remove them
    // Windows invalid: < > : " / \ | ? *
    let safeTitle = title.replace(/[<>:"/\\|?*]/g, "_");

    // Ensure it ends with .md
    if (!safeTitle.toLowerCase().endsWith(".md")) {
      safeTitle += ".md";
    }

    const filename = safeTitle;

    console.log(`Downloading ${url} -> ${filename} ...`);

    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.error(`  Failed: ${res.status}`);
        continue;
      }
      const text = await res.text();
      await fs.writeFile(path.join(targetDir, filename), text, "utf8");
    } catch (err) {
      console.error(`  Error: ${err.message}`);
    }
  }

  console.log("Done.");
}

main();
