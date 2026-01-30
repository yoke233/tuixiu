export function mergeInitScripts(...scripts: Array<string | null | undefined>): string {
  return scripts
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter(Boolean)
    .join("\n\n");
}

export function buildWorkspaceInitScript(): string {
  return `set -euo pipefail

init_step() {
  stage="$1"
  status="$2"
  msg="\${3:-}"
  if [ -n "$msg" ]; then
    printf '__TUIXIU_INIT_STEP__:%s:%s:%s\\n' "$stage" "$status" "$msg" >&2
  else
    printf '__TUIXIU_INIT_STEP__:%s:%s\\n' "$stage" "$status" >&2
  fi
}

repo="\${TUIXIU_REPO_URL:-}"
ws="\${TUIXIU_WORKSPACE_GUEST:-\${TUIXIU_WORKSPACE:-/workspace}}"
base="\${TUIXIU_BASE_BRANCH:-main}"
branch="\${TUIXIU_RUN_BRANCH:-}"
auth="\${TUIXIU_GIT_AUTH_MODE:-}"
workspace_mode="\${TUIXIU_WORKSPACE_MODE:-}"
skip_workspace_init="\${TUIXIU_SKIP_WORKSPACE_INIT:-}"

if [ -z "$repo" ]; then
  echo "[init] missing TUIXIU_REPO_URL" >&2
  exit 2
fi
if [ -z "$branch" ]; then
  echo "[init] missing TUIXIU_RUN_BRANCH" >&2
  exit 2
fi
if [ -z "$ws" ] || [ "$ws" = "/" ]; then
  echo "[init] invalid workspace" >&2
  exit 2
fi

if [ "$workspace_mode" = "mount" ] || [ "$skip_workspace_init" = "1" ]; then
  init_step ready done
  exit 0
fi

init_step auth start
if [ "$auth" = "ssh" ]; then
  if [ -n "\${TUIXIU_GIT_SSH_COMMAND:-}" ]; then
    export GIT_SSH_COMMAND="$TUIXIU_GIT_SSH_COMMAND"
  else
    key_path=""
    if [ -n "\${TUIXIU_GIT_SSH_KEY_B64:-}" ]; then
      init_step ssh_key start
      key_path="\${TUIXIU_GIT_SSH_KEY_PATH:-/tmp/tuixiu_git_key}"
      printf '%s' "$TUIXIU_GIT_SSH_KEY_B64" | base64 -d > "$key_path"
      chmod 600 "$key_path" 2>/dev/null || true
      init_step ssh_key done
    elif [ -n "\${TUIXIU_GIT_SSH_KEY:-}" ]; then
      init_step ssh_key start
      key_path="\${TUIXIU_GIT_SSH_KEY_PATH:-/tmp/tuixiu_git_key}"
      printf '%s\\n' "$TUIXIU_GIT_SSH_KEY" > "$key_path"
      chmod 600 "$key_path" 2>/dev/null || true
      init_step ssh_key done
    elif [ -n "\${TUIXIU_GIT_SSH_KEY_PATH:-}" ]; then
      key_path="$TUIXIU_GIT_SSH_KEY_PATH"
      chmod 600 "$key_path" 2>/dev/null || true
    fi

    kh="\${TUIXIU_GIT_SSH_KNOWN_HOSTS_PATH:-/tmp/tuixiu_known_hosts}"
    if [ -n "$key_path" ]; then
      init_step known_hosts start
      host=""
      case "$repo" in
        ssh://*)
          host=$(printf "%s" "$repo" | sed -E 's#^ssh://([^@/]+@)?([^/:]+).*#\\2#')
          ;;
        *@*:*)
          host=$(printf "%s" "$repo" | sed -E 's#^[^@]+@([^:]+):.*#\\1#')
          ;;
        http://*|https://*)
          host=$(printf "%s" "$repo" | sed -E 's#^https?://([^/]+).*#\\1#')
          ;;
      esac
      if [ -n "$host" ]; then
        ssh-keyscan -t rsa,ecdsa,ed25519 "$host" > "$kh" 2>/dev/null || true
      fi
      init_step known_hosts done
      if [ -s "$kh" ]; then
        export GIT_SSH_COMMAND="ssh -i \\"$key_path\\" -o IdentitiesOnly=yes -o UserKnownHostsFile=\\"$kh\\" -o StrictHostKeyChecking=yes"
      else
        export GIT_SSH_COMMAND="ssh -i \\"$key_path\\" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
      fi
    fi
  fi
else
  if [ -n "\${TUIXIU_GIT_HTTP_PASSWORD:-}" ]; then
    export GIT_TERMINAL_PROMPT=0
    export GCM_INTERACTIVE=Never
    askpass="\${TUIXIU_GIT_ASKPASS_PATH:-/tmp/tuixiu-askpass.sh}"
    cat > "$askpass" <<'EOF'
#!/bin/sh
prompt="$1"
case "$prompt" in
  *Username*|*username*)
    printf '%s\\n' "\${TUIXIU_GIT_HTTP_USERNAME:-x-access-token}"
    ;;
  *)
    printf '%s\\n' "\${TUIXIU_GIT_HTTP_PASSWORD:-}"
    ;;
esac
EOF
    chmod 700 "$askpass"
    export GIT_ASKPASS="$askpass"
  fi
fi
init_step auth done

init_step clone start
mkdir -p "$ws"
if [ -d "$ws/.git" ]; then
  git -C "$ws" fetch --prune || true
else
  rm -rf "$ws"/*
  git clone --branch "$base" --single-branch "$repo" "$ws"
fi
init_step clone done

init_step checkout start
if git -C "$ws" checkout -B "$branch" "origin/$base" 2>/dev/null; then
  :
else
  git -C "$ws" checkout -B "$branch"
fi
init_step checkout done

init_step ready done
`;
}
