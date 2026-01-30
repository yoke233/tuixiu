export function mergeInitScripts(...scripts: Array<string | null | undefined>): string {
  return scripts
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter(Boolean)
    .join("\n\n");
}

export function buildWorkspaceInitScript(): string {
  const lines: string[] = [];
  lines.push("set -euo pipefail");
  lines.push("");
  lines.push("init_step() {");
  lines.push('  stage="$1"');
  lines.push('  status="$2"');
  lines.push('  msg="${3:-}"');
  lines.push('  if [ -n "$msg" ]; then');
  lines.push('    printf \'__TUIXIU_INIT_STEP__:%s:%s:%s\\n\' "$stage" "$status" "$msg" >&2');
  lines.push("  else");
  lines.push('    printf \'__TUIXIU_INIT_STEP__:%s:%s\\n\' "$stage" "$status" >&2');
  lines.push("  fi");
  lines.push("}");
  lines.push("");
  lines.push('repo="${TUIXIU_REPO_URL:-}"');
  lines.push('ws="${TUIXIU_WORKSPACE_GUEST:-${TUIXIU_WORKSPACE:-/workspace}}"');
  lines.push('base="${TUIXIU_BASE_BRANCH:-main}"');
  lines.push('branch="${TUIXIU_RUN_BRANCH:-}"');
  lines.push('auth="${TUIXIU_GIT_AUTH_MODE:-}"');
  lines.push("");
  lines.push('if [ -z "$repo" ]; then');
  lines.push('  echo "[init] missing TUIXIU_REPO_URL" >&2');
  lines.push("  exit 2");
  lines.push("fi");
  lines.push('if [ -z "$branch" ]; then');
  lines.push('  echo "[init] missing TUIXIU_RUN_BRANCH" >&2');
  lines.push("  exit 2");
  lines.push("fi");
  lines.push('if [ -z "$ws" ] || [ "$ws" = "/" ]; then');
  lines.push('  echo "[init] invalid workspace" >&2');
  lines.push("  exit 2");
  lines.push("fi");
  lines.push("");
  lines.push("init_step auth start");
  lines.push('if [ "$auth" = "ssh" ]; then');
  lines.push('  if [ -n "${TUIXIU_GIT_SSH_COMMAND:-}" ]; then');
  lines.push('    export GIT_SSH_COMMAND="$TUIXIU_GIT_SSH_COMMAND"');
  lines.push("  else");
  lines.push('    key_path=""');
  lines.push('    if [ -n "${TUIXIU_GIT_SSH_KEY_B64:-}" ]; then');
  lines.push("      init_step ssh_key start");
  lines.push('      key_path="${TUIXIU_GIT_SSH_KEY_PATH:-/tmp/tuixiu_git_key}"');
  lines.push('      printf \'%s\' "$TUIXIU_GIT_SSH_KEY_B64" | base64 -d > "$key_path"');
  lines.push('      chmod 600 "$key_path" 2>/dev/null || true');
  lines.push("      init_step ssh_key done");
  lines.push('    elif [ -n "${TUIXIU_GIT_SSH_KEY:-}" ]; then');
  lines.push("      init_step ssh_key start");
  lines.push('      key_path="${TUIXIU_GIT_SSH_KEY_PATH:-/tmp/tuixiu_git_key}"');
  lines.push('      printf \'%s\\n\' "$TUIXIU_GIT_SSH_KEY" > "$key_path"');
  lines.push('      chmod 600 "$key_path" 2>/dev/null || true');
  lines.push("      init_step ssh_key done");
  lines.push('    elif [ -n "${TUIXIU_GIT_SSH_KEY_PATH:-}" ]; then');
  lines.push('      key_path="$TUIXIU_GIT_SSH_KEY_PATH"');
  lines.push('      chmod 600 "$key_path" 2>/dev/null || true');
  lines.push("    fi");
  lines.push("");
  lines.push('    kh="${TUIXIU_GIT_SSH_KNOWN_HOSTS_PATH:-/tmp/tuixiu_known_hosts}"');
  lines.push('    if [ -n "$key_path" ]; then');
  lines.push("      init_step known_hosts start");
  lines.push('      host=""');
  lines.push('      case "$repo" in');
  lines.push("        ssh://*)");
  lines.push(
    '          host=$(printf "%s" "$repo" | sed -E \'s#^ssh://([^@/]+@)?([^/:]+).*#\\2#\')',
  );
  lines.push("          ;;");
  lines.push("        *@*:*)");
  lines.push('          host=$(printf "%s" "$repo" | sed -E \'s#^[^@]+@([^:]+):.*#\\1#\')');
  lines.push("          ;;");
  lines.push("        http://*|https://*)");
  lines.push('          host=$(printf "%s" "$repo" | sed -E \'s#^https?://([^/]+).*#\\1#\')');
  lines.push("          ;;");
  lines.push("      esac");
  lines.push('      if [ -n "$host" ]; then');
  lines.push('        ssh-keyscan -t rsa,ecdsa,ed25519 "$host" > "$kh" 2>/dev/null || true');
  lines.push("      fi");
  lines.push("      init_step known_hosts done");
  lines.push('      if [ -s "$kh" ]; then');
  lines.push(
    '        export GIT_SSH_COMMAND="ssh -i \\"$key_path\\" -o IdentitiesOnly=yes -o UserKnownHostsFile=\\"$kh\\" -o StrictHostKeyChecking=yes"',
  );
  lines.push("      else");
  lines.push(
    '        export GIT_SSH_COMMAND="ssh -i \\"$key_path\\" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"',
  );
  lines.push("      fi");
  lines.push("    fi");
  lines.push("  fi");
  lines.push("else");
  lines.push('  if [ -n "${TUIXIU_GIT_HTTP_PASSWORD:-}" ]; then');
  lines.push("    export GIT_TERMINAL_PROMPT=0");
  lines.push("    export GCM_INTERACTIVE=Never");
  lines.push('    askpass="${TUIXIU_GIT_ASKPASS_PATH:-/tmp/tuixiu-askpass.sh}"');
  lines.push("    cat > \"$askpass\" <<'EOF'");
  lines.push("#!/bin/sh");
  lines.push('prompt="$1"');
  lines.push('case "$prompt" in');
  lines.push("  *Username*|*username*)");
  lines.push("    printf '%s\\n' \"${TUIXIU_GIT_HTTP_USERNAME:-x-access-token}\"");
  lines.push("    ;;");
  lines.push("  *)");
  lines.push("    printf '%s\\n' \"${TUIXIU_GIT_HTTP_PASSWORD:-}\"");
  lines.push("    ;;");
  lines.push("esac");
  lines.push("EOF");
  lines.push('    chmod 700 "$askpass"');
  lines.push('    export GIT_ASKPASS="$askpass"');
  lines.push("  fi");
  lines.push("fi");
  lines.push("init_step auth done");
  lines.push("");
  lines.push("init_step clone start");
  lines.push('mkdir -p "$ws"');
  lines.push('if [ -d "$ws/.git" ]; then');
  lines.push('  git -C "$ws" fetch --prune || true');
  lines.push("else");
  lines.push('  rm -rf "$ws"/*');
  lines.push('  git clone --branch "$base" --single-branch "$repo" "$ws"');
  lines.push("fi");
  lines.push("init_step clone done");
  lines.push("");
  lines.push("init_step checkout start");
  lines.push('if git -C "$ws" checkout -B "$branch" "origin/$base" 2>/dev/null; then');
  lines.push("  :");
  lines.push("else");
  lines.push('  git -C "$ws" checkout -B "$branch"');
  lines.push("fi");
  lines.push("init_step checkout done");
  lines.push("");
  lines.push("init_step ready done");
  lines.push("");
  return lines.join("\n");
}
