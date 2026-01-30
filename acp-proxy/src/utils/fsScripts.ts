export const FS_READ_SCRIPT = 'cat "$1"';

export const FS_WRITE_SCRIPT = [
  "set -e",
  'p="$1"',
  'dir="${p%/*}"',
  'if [ "$dir" != "$p" ]; then mkdir -p "$dir"; fi',
  'cat > "$p"',
].join("\n");
