import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, rm } from "node:fs/promises";
import path from "node:path";

import type { ProxyContext } from "../proxyContext.js";
import { WORKSPACE_GUEST_PATH, nowIso } from "../proxyContext.js";
import { closeAgent, sendSandboxInstanceStatus } from "../runs/runRuntime.js";
import { createHostGitEnv } from "../utils/gitHost.js";
import { validateInstanceName, validateRunId } from "../utils/validate.js";

type ExpectedInstance = {
  instance_name: string;
  run_id: string | null;
};

const runQueues = new Map<string, Promise<void>>();
const runQueueSizes = new Map<string, number>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseEnv(raw: unknown): Record<string, string> | undefined {
  if (!isRecord(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

const execFileAsync = promisify(execFile);

function resolveQueueRunId(runIdRaw: string, instanceNameRaw: string): string | null {
  const runId = runIdRaw.trim();
  if (runId) {
    try {
      return validateRunId(runId);
    } catch {
      return null;
    }
  }

  const instanceName = instanceNameRaw.trim();
  if (!instanceName.startsWith("tuixiu-run-")) return null;
  const inferred = instanceName.slice("tuixiu-run-".length);
  if (!inferred) return null;
  try {
    return validateRunId(inferred);
  } catch {
    return null;
  }
}

async function enqueueFallback(runId: string, task: () => Promise<void>): Promise<void> {
  const prev = runQueues.get(runId) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(task)
    .finally(() => {
      if (runQueues.get(runId) === next) runQueues.delete(runId);
    });
  runQueues.set(runId, next);
  return next;
}

async function enqueueRunTask(
  ctx: ProxyContext,
  runId: string | null,
  meta: { action: string; requestId?: string | null },
  task: () => Promise<void>,
): Promise<void> {
  if (!runId) {
    await task();
    return;
  }

  const pending = runQueueSizes.get(runId) ?? 0;
  if (pending > 0) {
    ctx.log("sandbox_control queued", {
      runId,
      action: meta.action,
      requestId: meta.requestId ?? undefined,
      pending,
    });
  }
  runQueueSizes.set(runId, pending + 1);

  const run = ctx.runs.get(runId);
  try {
    if (run) {
      await ctx.runs.enqueue(runId, task);
      return;
    }

    await enqueueFallback(runId, task);
  } finally {
    const next = (runQueueSizes.get(runId) ?? 1) - 1;
    if (next <= 0) runQueueSizes.delete(runId);
    else runQueueSizes.set(runId, next);
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function readAllText(stream: ReadableStream<Uint8Array> | undefined): Promise<string> {
  if (!stream) return "";
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let out = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
    return out;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

function trimOutput(text: string, limit = 8_000): string {
  if (!text || text.length <= limit) return text;
  return `...${text.slice(text.length - limit)}`;
}

const GIT_PUSH_SCRIPT = `set -euo pipefail

repo="\${TUIXIU_REPO_URL:-}"
ws="\${TUIXIU_WORKSPACE_GUEST:-/workspace}"
branch="\${TUIXIU_RUN_BRANCH:-}"
remote="\${TUIXIU_GIT_REMOTE:-origin}"
auth="\${TUIXIU_GIT_AUTH_MODE:-}"

if [ -z "$branch" ]; then
  echo "[git_push] missing TUIXIU_RUN_BRANCH" >&2
  exit 2
fi
if [ -z "$ws" ] || [ "$ws" = "/" ]; then
  echo "[git_push] invalid workspace" >&2
  exit 2
fi

if [ "$auth" = "ssh" ]; then
  if [ -n "\${TUIXIU_GIT_SSH_COMMAND:-}" ]; then
    export GIT_SSH_COMMAND="$TUIXIU_GIT_SSH_COMMAND"
  else
    key_path=""
    if [ -n "\${TUIXIU_GIT_SSH_KEY_B64:-}" ]; then
      key_path="\${TUIXIU_GIT_SSH_KEY_PATH:-/tmp/tuixiu_git_key}"
      printf '%s' "$TUIXIU_GIT_SSH_KEY_B64" | base64 -d > "$key_path"
      chmod 600 "$key_path" 2>/dev/null || true
    elif [ -n "\${TUIXIU_GIT_SSH_KEY:-}" ]; then
      key_path="\${TUIXIU_GIT_SSH_KEY_PATH:-/tmp/tuixiu_git_key}"
      printf '%s\\n' "$TUIXIU_GIT_SSH_KEY" > "$key_path"
      chmod 600 "$key_path" 2>/dev/null || true
    elif [ -n "\${TUIXIU_GIT_SSH_KEY_PATH:-}" ]; then
      key_path="$TUIXIU_GIT_SSH_KEY_PATH"
      chmod 600 "$key_path" 2>/dev/null || true
    fi

    kh="\${TUIXIU_GIT_SSH_KNOWN_HOSTS_PATH:-/tmp/tuixiu_known_hosts}"
    if [ -n "$key_path" ]; then
      host=""
      case "$repo" in
        ssh://*)
          host=$(printf "%s" "$repo" | sed -E 's#^ssh://([^@/]+@)?([^/:]+).*#\\2#')
          ;;
        *@*:* )
          host=$(printf "%s" "$repo" | sed -E 's#^[^@]+@([^:]+):.*#\\1#')
          ;;
        http://*|https://*)
          host=$(printf "%s" "$repo" | sed -E 's#^https?://([^/]+).*#\\1#')
          ;;
      esac
      if [ -n "$host" ]; then
        ssh-keyscan -t rsa,ecdsa,ed25519 "$host" > "$kh" 2>/dev/null || true
      fi
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

git -C "$ws" push -u "$remote" "$branch"
`;

function parseExpectedInstances(ctx: ProxyContext, raw: unknown): ExpectedInstance[] {
  if (!Array.isArray(raw)) return [];
  const out: ExpectedInstance[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    try {
      const instanceName = validateInstanceName(record.instance_name);
      const runIdRaw = record.run_id;
      const runId =
        runIdRaw === null || runIdRaw === undefined || !String(runIdRaw).trim()
          ? null
          : validateRunId(runIdRaw);
      out.push({ instance_name: instanceName, run_id: runId });
    } catch (err) {
      ctx.log("invalid expected_instances entry", { err: String(err) });
    }
  }
  return out;
}

async function reportInventory(ctx: ProxyContext, expectedRaw?: unknown): Promise<void> {
  const capturedAt = nowIso();
  const inventoryId = randomUUID();
  const instances = await ctx.sandbox.listInstances({ managedOnly: true });
  const expectedInstances = parseExpectedInstances(ctx, expectedRaw);
  const knownNames = new Set(instances.map((i) => i.instanceName));
  const missingInstances = expectedInstances
    .filter((i) => !knownNames.has(i.instance_name))
    .map((i) => ({ instance_name: i.instance_name, run_id: i.run_id }));

  const payload: Record<string, unknown> = {
    type: "sandbox_inventory",
    inventory_id: inventoryId,
    provider: ctx.sandbox.provider,
    runtime: ctx.sandbox.provider === "container_oci" ? (ctx.sandbox.runtime ?? null) : null,
    captured_at: capturedAt,
    instances: instances.map((i) => {
      const runId = i.instanceName.startsWith("tuixiu-run-")
        ? i.instanceName.slice("tuixiu-run-".length)
        : null;
      return {
        instance_name: i.instanceName,
        run_id: runId,
        status: i.status,
        created_at: i.createdAt,
        last_seen_at: capturedAt,
      };
    }),
  };

  if (Array.isArray(expectedRaw)) {
    payload.missing_instances = missingInstances;
  }

  ctx.send(payload);
}

export async function handleSandboxControl(ctx: ProxyContext, msg: any): Promise<void> {
  const runId = String(msg?.run_id ?? "").trim();
  const instanceNameRaw = String(msg?.instance_name ?? "").trim();
  const action = String(msg?.action ?? "").trim();
  const requestIdRaw = String(msg?.request_id ?? "").trim();
  const requestId = requestIdRaw ? requestIdRaw : null;
  const queueRunId = resolveQueueRunId(runId, instanceNameRaw);

  const reply = (payload: Record<string, unknown>) => {
    try {
      ctx.send({
        type: "sandbox_control_result",
        run_id: runId || null,
        instance_name: instanceNameRaw || null,
        action,
        request_id: requestId,
        ...payload,
      });
    } catch (err) {
      ctx.log("failed to send sandbox_control_result", { err: String(err) });
    }
  };

  try {
    if (action === "report_inventory") {
      await reportInventory(ctx, msg?.expected_instances);
      reply({ ok: true });
      return;
    }

    if (action === "remove_image") {
      const image = String(msg?.image ?? "").trim();
      if (!image) {
        reply({ ok: false, error: "image 为空" });
        return;
      }
      await ctx.sandbox.removeImage(image);
      reply({ ok: true });
      return;
    }

    await enqueueRunTask(ctx, queueRunId, { action, requestId }, async () => {
      if (action === "git_push") {
        const effectiveRunId = validateRunId(runId);
        const branch = String(msg?.branch ?? "").trim();
        if (!branch) {
          reply({ ok: false, error: "branch 为空" });
          return;
        }
        if (ctx.cfg.sandbox.gitPush === false) {
          reply({ ok: false, error: "git_push disabled" });
          return;
        }

        const timeoutSecondsRaw = msg?.timeout_seconds ?? 300;
        const timeoutSeconds = Number.isFinite(timeoutSecondsRaw)
          ? Math.max(5, Math.min(3600, Number(timeoutSecondsRaw)))
          : 300;

        const env = parseEnv(msg?.env) ?? {};
        const remote =
          typeof msg?.remote === "string" && msg.remote.trim() ? msg.remote.trim() : "origin";

        const workspaceMode = ctx.cfg.sandbox.workspaceMode ?? "mount";
        if (workspaceMode === "mount") {
          const rootRaw = ctx.cfg.sandbox.workspaceHostRoot?.trim() ?? "";
          if (!rootRaw) {
            reply({ ok: false, error: "workspaceHostRoot 未配置" });
            return;
          }
          const root = path.isAbsolute(rootRaw) ? rootRaw : path.join(process.cwd(), rootRaw);
          const runtime = ctx.runs.get(effectiveRunId);
          const runtimePath =
            runtime?.hostWorkspacePath && runtime.hostWorkspacePath.trim()
              ? runtime.hostWorkspacePath.trim()
              : "";
          const hostWorkspace = runtimePath || path.join(root, `run-${effectiveRunId}`);
          const shouldCheck = !runtime?.hostWorkspaceReady || !runtimePath;
          if (shouldCheck) {
            if (!(await pathExists(hostWorkspace))) {
              reply({ ok: false, error: `workspace 不存在: ${hostWorkspace}` });
              return;
            }
            const gitDir = path.join(hostWorkspace, ".git");
            if (!(await pathExists(gitDir))) {
              reply({ ok: false, error: `workspace 未就绪(缺少 .git): ${hostWorkspace}` });
              return;
            }
          }

          let cleanup = async () => {};
          try {
            const envRes = await createHostGitEnv(env);
            cleanup = envRes.cleanup;
            const res = await execFileAsync("git", ["push", "-u", remote, branch], {
              cwd: hostWorkspace,
              env: envRes.env,
            });
            reply({ ok: true, stdout: trimOutput(String(res.stdout ?? "")), stderr: trimOutput(String(res.stderr ?? "")) });
          } catch (err) {
            const stdout = String((err as any)?.stdout ?? "");
            const stderr = String((err as any)?.stderr ?? "");
            reply({
              ok: false,
              error: String(err),
              stdout: trimOutput(stdout),
              stderr: trimOutput(stderr),
            });
          } finally {
            await cleanup().catch(() => {});
          }
          return;
        }

        const instanceName = validateInstanceName(instanceNameRaw);
        const cwdInGuest = String(msg?.cwd ?? "").trim() || WORKSPACE_GUEST_PATH;
        env.TUIXIU_RUN_BRANCH = branch;
        env.TUIXIU_WORKSPACE_GUEST = env.TUIXIU_WORKSPACE_GUEST ?? WORKSPACE_GUEST_PATH;
        env.TUIXIU_GIT_REMOTE = remote;

        let proc: any;
        try {
          proc = await ctx.sandbox.execProcess({
            instanceName,
            command: ["bash", "-lc", GIT_PUSH_SCRIPT],
            cwdInGuest,
            env,
          });
        } catch (err) {
          reply({ ok: false, error: String(err) });
          return;
        }

        const exitP = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
          proc.onExit?.((info: { code: number | null; signal: string | null }) => resolve(info));
          if (!proc.onExit) resolve({ code: null, signal: null });
        });

        const outP = readAllText(proc.stdout);
        const errP = readAllText(proc.stderr);

        const raced = await Promise.race([
          exitP.then((r) => ({ kind: "exit" as const, ...r })),
          delay(timeoutSeconds * 1000).then(() => ({ kind: "timeout" as const })),
        ]);

        if (raced.kind === "timeout") {
          await proc.close?.().catch(() => {});
          const [stdout, stderr] = await Promise.allSettled([outP, errP]).then((res) => [
            res[0].status === "fulfilled" ? res[0].value : "",
            res[1].status === "fulfilled" ? res[1].value : "",
          ]);
          reply({
            ok: false,
            error: `timeout after ${timeoutSeconds}s`,
            stdout: trimOutput(stdout),
            stderr: trimOutput(stderr),
          });
          return;
        }

        const [stdout, stderr] = await Promise.all([outP, errP]);
        const code = raced.code ?? null;
        const signal = raced.signal ?? null;
        if (code !== 0) {
          reply({
            ok: false,
            error: `exitCode=${code ?? "unknown"}${signal ? ` signal=${signal}` : ""}`,
            stdout: trimOutput(stdout),
            stderr: trimOutput(stderr),
            code,
            signal,
          });
          return;
        }

        reply({
          ok: true,
          stdout: trimOutput(stdout),
          stderr: trimOutput(stderr),
          code,
          signal,
        });
        return;
      }

      if (action === "prune_orphans") {
        const expectedInstances = parseExpectedInstances(ctx, msg?.expected_instances);
        const expectedSet = new Set(expectedInstances.map((i) => i.instance_name));
        const known = await ctx.sandbox.listInstances({ managedOnly: true });
        const orphans = known.filter((i) => !expectedSet.has(i.instanceName));

        const deletedInstances: Array<{ instance_name: string; run_id: string | null; reason: string }> = [];
        for (const inst of orphans) {
          try {
            await ctx.sandbox.removeInstance(inst.instanceName);
            const inferredRunId = inst.instanceName.startsWith("tuixiu-run-")
              ? inst.instanceName.slice("tuixiu-run-".length)
              : null;
            deletedInstances.push({
              instance_name: inst.instanceName,
              run_id: inferredRunId && inferredRunId.trim() ? inferredRunId : null,
              reason: "prune_orphans",
            });
          } catch (err) {
            ctx.log("prune_orphans failed to remove instance", {
              instanceName: inst.instanceName,
              err: String(err),
            });
          }
        }

        if (deletedInstances.length > 0) {
          ctx.send({
            type: "sandbox_inventory",
            inventory_id: randomUUID(),
            captured_at: nowIso(),
            provider: ctx.sandbox.provider,
            runtime: ctx.sandbox.provider === "container_oci" ? (ctx.sandbox.runtime ?? null) : null,
            deleted_instances: deletedInstances,
          });
        }

        reply({ ok: true, deleted_count: deletedInstances.length });
        return;
      }

      if (action === "gc") {
        const dryRun = typeof msg?.dry_run === "boolean" ? msg.dry_run : true;
        const expectedInstances = parseExpectedInstances(ctx, msg?.expected_instances);
        const expectedSet = new Set(expectedInstances.map((i) => i.instance_name));
        const known = await ctx.sandbox.listInstances({ managedOnly: true });
        const orphans = known.filter((i) => !expectedSet.has(i.instanceName));

        const workspaceMode = ctx.cfg.sandbox.workspaceMode ?? "mount";
        const gcConfig = isRecord(msg?.gc) ? (msg.gc as Record<string, unknown>) : {};
        const removeOrphans = gcConfig.remove_orphans === false ? false : true;
        const removeWorkspaces = gcConfig.remove_workspaces === false ? false : true;
        const maxDeleteCount =
          typeof gcConfig.max_delete_count === "number" && Number.isFinite(gcConfig.max_delete_count)
            ? Math.max(0, Math.min(10_000, Math.floor(gcConfig.max_delete_count)))
            : 500;

        const deletes: Array<Record<string, unknown>> = [];
        for (const inst of orphans) {
          const inferredRunId = inst.instanceName.startsWith("tuixiu-run-")
            ? inst.instanceName.slice("tuixiu-run-".length)
            : null;
          if (removeOrphans) {
            deletes.push({
              kind: "instance",
              instance_name: inst.instanceName,
              run_id: inferredRunId && inferredRunId.trim() ? inferredRunId : null,
            });
          }
          if (removeWorkspaces && workspaceMode === "mount" && inferredRunId && inferredRunId.trim()) {
            deletes.push({
              kind: "workspace",
              workspace_mode: workspaceMode,
              instance_name: inst.instanceName,
              run_id: inferredRunId,
            });
          }
        }

        const planned = { deletes: deletes.slice(0, maxDeleteCount) };
        if (dryRun) {
          reply({ ok: true, planned });
          return;
        }

        const deletedInstances: Array<{ instance_name: string; run_id: string | null; reason: string }> = [];
        const errors: Array<{ kind: string; message: string; instance_name?: string; run_id?: string | null }> = [];

        for (const item of planned.deletes) {
          if (!item || typeof item !== "object") continue;
          const kind = String((item as any).kind ?? "");
          const instanceName =
            typeof (item as any).instance_name === "string" ? (item as any).instance_name.trim() : "";
          const runId =
            typeof (item as any).run_id === "string" && (item as any).run_id.trim()
              ? (item as any).run_id.trim()
              : null;

          if (kind === "instance") {
            try {
              await ctx.sandbox.removeInstance(instanceName);
              deletedInstances.push({
                instance_name: instanceName,
                run_id: runId,
                reason: "gc",
              });
            } catch (err) {
              errors.push({
                kind,
                message: String(err),
                ...(instanceName ? { instance_name: instanceName } : {}),
                run_id: runId,
              });
            }
            continue;
          }

          if (kind === "workspace" && workspaceMode === "mount") {
            const rootRaw = ctx.cfg.sandbox.workspaceHostRoot?.trim() ?? "";
            if (!rootRaw) {
              errors.push({
                kind,
                message: "workspaceHostRoot 未配置",
                ...(instanceName ? { instance_name: instanceName } : {}),
                run_id: runId,
              });
              continue;
            }
            if (!runId) continue;

            const root = path.isAbsolute(rootRaw) ? rootRaw : path.join(process.cwd(), rootRaw);
            const resolvedRoot = path.resolve(root);
            const candidate = path.resolve(resolvedRoot, `run-${runId}`);
            const rootPrefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
            if (!candidate.startsWith(rootPrefix)) {
              errors.push({
                kind,
                message: `workspace path escape: ${candidate}`,
                ...(instanceName ? { instance_name: instanceName } : {}),
                run_id: runId,
              });
              continue;
            }

            try {
              await rm(candidate, { recursive: true, force: true });
            } catch (err) {
              errors.push({
                kind,
                message: String(err),
                ...(instanceName ? { instance_name: instanceName } : {}),
                run_id: runId,
              });
            }
            continue;
          }
        }

        if (deletedInstances.length > 0) {
          ctx.send({
            type: "sandbox_inventory",
            inventory_id: randomUUID(),
            captured_at: nowIso(),
            provider: ctx.sandbox.provider,
            runtime: ctx.sandbox.provider === "container_oci" ? (ctx.sandbox.runtime ?? null) : null,
            deleted_instances: deletedInstances,
          });
        }
        await reportInventory(ctx, msg?.expected_instances);

        reply({
          ok: errors.length === 0,
          planned,
          deleted: { instances: deletedInstances.length },
          ...(errors.length > 0 ? { errors } : {}),
        });
        return;
      }

      if (action === "remove_workspace") {
        const workspaceModeRaw =
          typeof msg?.workspace_mode === "string" ? String(msg.workspace_mode).trim() : "";
        const workspaceMode =
          workspaceModeRaw === "mount" || workspaceModeRaw === "git_clone"
            ? workspaceModeRaw
            : (ctx.cfg.sandbox.workspaceMode ?? "mount");
        const effectiveRunId = queueRunId;

        const reportDeletedWorkspace = (opts: { instanceName?: string | null; runId?: string | null }) => {
          ctx.send({
            type: "sandbox_inventory",
            inventory_id: randomUUID(),
            captured_at: nowIso(),
            provider: ctx.sandbox.provider,
            runtime: ctx.sandbox.provider === "container_oci" ? (ctx.sandbox.runtime ?? null) : null,
            deleted_workspaces: [
              {
                instance_name: opts.instanceName ?? null,
                run_id: opts.runId ?? null,
                workspace_mode: workspaceMode,
                deleted_at: nowIso(),
                reason: "remove_workspace",
              },
            ],
          });
        };

        if (workspaceMode === "mount") {
          if (!effectiveRunId) {
            reply({ ok: false, error: "run_id 为空" });
            return;
          }
          const rootRaw = ctx.cfg.sandbox.workspaceHostRoot?.trim() ?? "";
          if (!rootRaw) {
            reply({ ok: false, error: "workspaceHostRoot 未配置" });
            return;
          }
          const root = path.isAbsolute(rootRaw) ? rootRaw : path.join(process.cwd(), rootRaw);
          const resolvedRoot = path.resolve(root);
          const rootPrefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
          const hostWorkspace = path.resolve(resolvedRoot, `run-${effectiveRunId}`);
          if (!hostWorkspace.startsWith(rootPrefix)) {
            reply({ ok: false, error: `workspace path escape: ${hostWorkspace}` });
            return;
          }
          await rm(hostWorkspace, { recursive: true, force: true });
          reportDeletedWorkspace({ runId: effectiveRunId });
          reply({ ok: true });
          return;
        }

        const instanceName = validateInstanceName(instanceNameRaw);

        let proc: any;
        try {
          proc = await ctx.sandbox.execProcess({
            instanceName,
            command: ["bash", "-lc", "rm -rf /workspace/*"],
            cwdInGuest: WORKSPACE_GUEST_PATH,
            env: undefined,
          });
        } catch (err) {
          reply({ ok: false, error: String(err) });
          return;
        }

        const exitP = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
          proc.onExit?.((info: { code: number | null; signal: string | null }) => resolve(info));
          if (!proc.onExit) resolve({ code: null, signal: null });
        });

        const outP = readAllText(proc.stdout);
        const errP = readAllText(proc.stderr);

        const raced = await Promise.race([
          exitP.then((r) => ({ kind: "exit" as const, ...r })),
          delay(60_000).then(() => ({ kind: "timeout" as const })),
        ]);

        if (raced.kind === "timeout") {
          await proc.close?.().catch(() => {});
          const [stdout, stderr] = await Promise.allSettled([outP, errP]).then((res) => [
            res[0].status === "fulfilled" ? res[0].value : "",
            res[1].status === "fulfilled" ? res[1].value : "",
          ]);
          reply({
            ok: false,
            error: "timeout after 60s",
            stdout: trimOutput(stdout),
            stderr: trimOutput(stderr),
          });
          return;
        }

        const [stdout, stderr] = await Promise.all([outP, errP]);
        const code = raced.code ?? null;
        const signal = raced.signal ?? null;
        if (code !== 0) {
          reply({
            ok: false,
            error: `exitCode=${code ?? "unknown"}${signal ? ` signal=${signal}` : ""}`,
            stdout: trimOutput(stdout),
            stderr: trimOutput(stderr),
            code,
            signal,
          });
          return;
        }

        reportDeletedWorkspace({ instanceName, runId: effectiveRunId });
        reply({
          ok: true,
          stdout: trimOutput(stdout),
          stderr: trimOutput(stderr),
          code,
          signal,
        });
        return;
      }

      const instanceName = validateInstanceName(instanceNameRaw);

      if (action === "inspect") {
        const info = await ctx.sandbox.inspectInstance(instanceName);
        if (runId) {
          sendSandboxInstanceStatus(ctx, {
            runId,
            instanceName,
            status: info.status === "missing" ? "missing" : info.status,
            lastError: null,
          });
        }
        reply({ ok: true, status: info.status, details: { created_at: info.createdAt } });
        return;
      }

      if (action === "ensure_running") {
        const effectiveRunId = validateRunId(runId);
        const info = await ctx.sandbox.ensureInstanceRunning({
          runId: effectiveRunId,
          instanceName,
          workspaceGuestPath: WORKSPACE_GUEST_PATH,
          env: undefined,
        });
        sendSandboxInstanceStatus(ctx, {
          runId: effectiveRunId,
          instanceName,
          status: info.status === "missing" ? "missing" : info.status,
          lastError: null,
        });
        reply({ ok: true, status: info.status, details: { created_at: info.createdAt } });
        return;
      }

      if (action === "stop") {
        if (runId) {
          const run = ctx.runs.get(runId);
          if (run) await closeAgent(ctx, run, "sandbox_control_stop");
        }
        await ctx.sandbox.stopInstance(instanceName);
        const info = await ctx.sandbox.inspectInstance(instanceName);
        if (runId) {
          sendSandboxInstanceStatus(ctx, {
            runId,
            instanceName,
            status: info.status === "missing" ? "missing" : info.status,
            lastError: null,
          });
        }
        reply({ ok: true, status: info.status });
        return;
      }

      if (action === "remove") {
        if (runId) {
          const run = ctx.runs.get(runId);
          if (run) await closeAgent(ctx, run, "sandbox_control_remove");
          ctx.runs.delete(runId);
        }
        await ctx.sandbox.removeInstance(instanceName);
        await reportInventory(ctx);
        ctx.send({
          type: "sandbox_inventory",
          inventory_id: randomUUID(),
          captured_at: nowIso(),
          provider: ctx.sandbox.provider,
          runtime: ctx.sandbox.provider === "container_oci" ? (ctx.sandbox.runtime ?? null) : null,
          deleted_instances: [
            {
              instance_name: instanceName,
              run_id: runId || null,
              reason: "sandbox_control_remove",
            },
          ],
        });
        if (runId) {
          sendSandboxInstanceStatus(ctx, {
            runId,
            instanceName,
            status: "missing",
            lastError: null,
          });
        }
        reply({ ok: true, status: "missing" });
        return;
      }

      reply({ ok: false, error: "unsupported_action" });
    });
  } catch (err) {
    const message = String(err);
    if (runId && instanceNameRaw) {
      sendSandboxInstanceStatus(ctx, {
        runId,
        instanceName: instanceNameRaw,
        status: "error",
        lastError: message,
      });
    }
    reply({ ok: false, error: message });
  }
}
