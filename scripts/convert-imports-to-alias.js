const fs = require("node:fs/promises");
const path = require("node:path");

let ts;
try {
  // eslint-disable-next-line import/no-extraneous-dependencies
  ts = require("typescript");
} catch {
  try {
    ts = require(path.join(__dirname, "..", "frontend", "node_modules", "typescript"));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("无法加载 typescript，请先安装依赖。", err);
    process.exit(1);
  }
}

const repoRoot = path.resolve(__dirname, "..");
const srcRoot = path.join(repoRoot, "frontend", "src");

function isSubPath(parent, child) {
  const parentNorm = path.normalize(parent);
  const childNorm = path.normalize(child);
  const parentLower = parentNorm.toLowerCase();
  const childLower = childNorm.toLowerCase();
  if (childLower === parentLower) return true;
  return childLower.startsWith(parentLower + path.sep);
}

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function buildAlias(spec, filePath) {
  if (!spec.startsWith(".")) return null;
  const abs = path.resolve(path.dirname(filePath), spec);
  if (!isSubPath(srcRoot, abs)) return null;
  const rel = path.relative(srcRoot, abs);
  if (!rel || rel.startsWith("..")) return null;
  return `@/${toPosix(rel)}`;
}

function collectReplacements(sourceFile, filePath) {
  const replacements = [];
  const text = sourceFile.getFullText();

  function visit(node) {
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      const alias = buildAlias(spec, filePath);
      if (alias && alias !== spec) {
        const start = node.moduleSpecifier.getStart(sourceFile);
        const end = node.moduleSpecifier.getEnd();
        const raw = text.slice(start, end);
        const quote = raw[0] === "'" || raw[0] === '"' ? raw[0] : "'";
        replacements.push({ start, end, value: `${quote}${alias}${quote}` });
      }
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      const alias = buildAlias(spec, filePath);
      if (alias && alias !== spec) {
        const start = node.moduleSpecifier.getStart(sourceFile);
        const end = node.moduleSpecifier.getEnd();
        const raw = text.slice(start, end);
        const quote = raw[0] === "'" || raw[0] === '"' ? raw[0] : "'";
        replacements.push({ start, end, value: `${quote}${alias}${quote}` });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return replacements;
}

async function processFile(filePath) {
  const sourceText = await fs.readFile(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const replacements = collectReplacements(sourceFile, filePath);
  if (!replacements.length) return false;

  const sorted = [...replacements].sort((a, b) => b.start - a.start);
  let nextText = sourceText;
  for (const r of sorted) {
    nextText = `${nextText.slice(0, r.start)}${r.value}${nextText.slice(r.end)}`;
  }
  if (nextText === sourceText) return false;
  await fs.writeFile(filePath, nextText, "utf8");
  return true;
}

async function listTargetFiles() {
  const { execFile } = require("node:child_process");
  const { promisify } = require("node:util");
  const execFileAsync = promisify(execFile);
  const args = ["--files", "-g", "*.ts", "-g", "*.tsx", srcRoot];
  const res = await execFileAsync("rg", args, { cwd: repoRoot });
  return res.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function main() {
  const files = await listTargetFiles();
  let changed = 0;
  for (const file of files) {
    // skip generated types, if any
    if (file.includes("node_modules")) continue;
    if (await processFile(file)) changed += 1;
  }
  // eslint-disable-next-line no-console
  console.log(`done. updated files: ${changed}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
