# Windows 下 Node `spawn` 运行 `npx/pnpm` 的 cmd shim 模式

**提取时间：** 2026-01-26  
**适用上下文：** 在 Windows（尤其是 PowerShell）里用 Node 子进程启动 `npx/pnpm/npm/yarn` 或 `*.cmd/*.bat`，以及 ACP proxy/runner 这类需要稳定拉起 CLI 的场景

## 问题

- 现象：`Error: spawn npx ENOENT`（或类似 `spawn pnpm ENOENT`），导致代理/桥接进程初始化失败；上游还可能出现 `write EPIPE`（连接已断但仍继续写入）。
- 根因（常见）：Windows 上很多 CLI 实际是 `*.cmd`/`*.bat`；当运行环境的 `PATH` 不完整、或未能正确解析 `PATHEXT`、或进程以“非交互环境/服务方式”启动时，直接 `spawn("npx", ...)` 可能找不到可执行文件而报 ENOENT。

## 解决方案

1. **对 `npx/pnpm/npm/yarn` 与 `*.cmd/*.bat` 统一走 `cmd.exe /d /s /c`**
   - 让 Windows Shell 负责解析 `*.cmd`/`*.bat` 与 PATH 查找，避免 Node 直接 spawn 的兼容性坑。
2. **对“写入已断开的连接”做硬化**
   - WebSocket/stream 写入前检查状态；写失败（如 EPIPE）时捕获并触发重连/清理映射，避免二次崩溃。
3. **诊断手段（先定位再修）**
   - 打印 `process.env.PATH`、`process.env.ComSpec`。
   - 在同一运行身份下执行 `where.exe npx` / `where.exe pnpm` 验证是否可见。
   - 将最终 `spawnCmd/spawnArgs/cwd` 记录到日志，便于复盘。

## 示例

```ts
const [rawCmd, ...args] = command;
const lower = rawCmd.toLowerCase();
const useCmdShim =
  process.platform === "win32" &&
  (lower === "npx" || lower === "npm" || lower === "pnpm" || lower === "yarn" ||
    lower.endsWith(".cmd") || lower.endsWith(".bat"));

const spawnCmd = useCmdShim ? (process.env.ComSpec ?? "cmd.exe") : rawCmd;
const spawnArgs = useCmdShim ? ["/d", "/s", "/c", rawCmd, ...args] : args;

spawn(spawnCmd, spawnArgs, { cwd, stdio: ["pipe", "pipe", "pipe"] });
```

## 何时使用

- 你在 Windows 上需要从 Node 可靠启动：`npx`、`pnpm`、`npm`、`yarn`、或任何 `*.cmd/*.bat`（例如 `npx --yes @zed-industries/codex-acp`）。
- 你的进程可能运行在“环境变量不完整”的上下文（服务、计划任务、守护进程、CI runner）且出现间歇性 ENOENT。
- 你在做 websocket/stdio 桥接（如 ACP proxy），希望对断线写入（EPIPE）更稳健。

