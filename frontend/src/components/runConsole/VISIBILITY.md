# RunConsole 可见性规则（默认隐藏哪些“状态事件”）

目标：Console 默认只展示“人真正关心的内容”（对话 / 工具调用 / 权限请求 / 关键错误），避免被高频状态心跳刷屏；需要排障时可以手动展开“状态事件”。

## 入口文件

- 事件 -> ConsoleItem 映射（决定每条信息长什么样、是否默认隐藏）：
  - `frontend/src/components/runConsole/eventToConsoleItem.ts`
- Console 默认过滤：
  - `frontend/src/components/RunConsole.tsx`
- “显示/隐藏状态事件”开关（由页面层提供，避免在首页/卡片弹窗里占 UI）：
  - Session 单独页面右上角：`frontend/src/pages/session/sections/SessionConsoleCard.tsx`
  - Issue 详情页 Console 默认不提供开关（需要排障可点“全屏控制台”进入 Session 页）
- ConsoleItem 数据结构（`isStatus` 标记）：
  - `frontend/src/components/runConsole/types.ts`

## isStatus 约定

在 `eventToConsoleItem.ts` 里：

- `item.isStatus = true`：默认隐藏（属于“状态/调试信息”），但用户可在 UI 点击“显示状态事件”查看。
- **错误信息必须默认可见**：例如 init 失败、异常断连、沙盒 error、`[proxy:error]`、`[agent:stderr]` 等，不能标记为 isStatus。

UI 行为：
- RunConsole 只负责按 `item.isStatus` 做过滤；是否展示状态事件由上层页面传入 `showStatusEvents` 控制。

## 当前默认隐藏（isStatus=true）的典型事件

- `transport_connected`：连接已建立（通常不需要反复显示）
- `transport_disconnected`：如果被判定为“正常断开”（code=0 或 code 缺失且无 signal）
- `init_result`：当 `ok=true`
- `sandbox_instance_status`：当状态是 running/creating 且没有 last_error（高频心跳）
- `init_step`：当 `status=progress`（过于频繁）；`start/done/error` 仍默认展示
- `config_option_update`：配置选项列表（信息量大，默认隐藏）
- `sandbox.acp_exit`：当被判定为“正常退出”（code=0 或 code 缺失且无 signal）

## 默认展示的“初始化/排障关键事件”

- `init_step` 的 `start/done/error`
- `init_result` 的 `ok=false`
- `transport_disconnected` 的异常情况（code!=0 或 signal 存在）
- `sandbox_instance_status` 的 error/failed 或 `last_error` 非空
- `sandbox.acp_exit` 的异常退出（code!=0 或 signal 存在）
- 文本类错误：`[proxy:error] ...` / `[agent:stderr] ...` / `[init:stderr] ...`

## 本地排障工具（不看 UI 也能看“默认渲染结果”）

可以用后端脚本把某个 Run 的 events 按前端 RunConsole 的规则打印出来：

- `backend/scripts/inspect-run-console.ts`

运行：

```powershell
Push-Location backend
pnpm exec tsx scripts/inspect-run-console.ts <runId> 800
Pop-Location
```
