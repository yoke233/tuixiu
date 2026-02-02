# agent-inputs

## MODIFIED Requirements

### Requirement: Each input specifies source, target root, apply method, and access intent
每个输入项 MUST 明确包含：

- `id`：输入项标识（用于日志/排障/幂等）
- `source`：输入来源（至少包含 `hostPath`、受控下载端点 zip（`httpZip`）、以及内联文本（`inlineText`））
- `target`：目标位置，使用 “逻辑根目录 + 相对路径” 表达
- `apply`：落地方式（至少包含 bind mount、copy、download+extract、以及 write file）
- `access`：权限意图（`ro`/`rw`），若缺省则默认等同 `rw`

#### Scenario: Proxy can apply an input without policy-specific branching
- **WHEN** acp-proxy 收到一个输入项（包含 source/target/apply/access），例如：
  - `apply=writeFile` 且 `source.type=inlineText`，目标为 `USER_HOME` 下的相对路径
- **THEN** acp-proxy 可在不依赖 workspacePolicy 等分散策略特判的前提下，对该输入项执行对应落地动作

## ADDED Requirements

### Requirement: writeFile applies inlineText to the target path under the logical root
当输入项满足 `apply=writeFile` 且 `source.type=inlineText` 时，acp-proxy MUST 将 `text` 以 UTF-8 写入到 `target.root + target.path` 对应的目标文件路径，并在必要时创建父目录。

#### Scenario: Write AGENTS.md under USER_HOME
- **WHEN** 输入项为 `apply=writeFile`、`target.root=USER_HOME`、`target.path=.codex/AGENTS.md`
- **THEN** 该文件被写入到 run 的 `USER_HOME` 对应目录下，并在 agent 启动后可被读取

