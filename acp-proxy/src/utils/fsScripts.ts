export const FS_READ_SCRIPT = 'cat "$1"';

export const FS_WRITE_SCRIPT = [
  "set -e",
  'p="$1"',
  'dir="${p%/*}"',
  'if [ "$dir" != "$p" ]; then mkdir -p "$dir"; fi',
  'cat > "$p"',
].join("\n");

// host_process (Windows) fallback: use Node.js instead of sh.
export const FS_READ_NODE_SCRIPT =
  "const fs=require('node:fs');" +
  "const p=process.argv[1];" +
  "process.stdout.write(fs.readFileSync(p,'utf8'));";

export const FS_WRITE_NODE_SCRIPT =
  "const fs=require('node:fs');" +
  "const path=require('node:path');" +
  "const p=process.argv[1];" +
  "fs.mkdirSync(path.dirname(p),{recursive:true});" +
  "let data='';" +
  "process.stdin.setEncoding('utf8');" +
  "process.stdin.on('data',c=>data+=c);" +
  "process.stdin.on('end',()=>{fs.writeFileSync(p,data,'utf8');});";
