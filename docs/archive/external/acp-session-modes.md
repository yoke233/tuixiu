---
title: "ACP Session Modes（外部资料归档）"
owner: "@tuixiu-maintainers"
status: "archived"
last_reviewed: "2026-01-27"
---

> ⚠️ **外部资料归档**：本文档为外部抓取内容，格式/内容不保证最新，仅用于追溯。  
> 建议优先阅读：`docs/01_architecture/acp-integration.md` 与 ACP 官方文档。

Session Modes - Agent Client Protocol

[Skip to main content](#content-area)

[Agent Client Protocol home page![light logo](https://mintcdn.com/zed-685ed6d6/FgcZrIi8cEeJJGHC/logo/light.svg?fit=max&auto=format&n=FgcZrIi8cEeJJGHC&q=85&s=5cf9119e471543528e40443ba41baf30)![dark logo](https://mintcdn.com/zed-685ed6d6/FgcZrIi8cEeJJGHC/logo/dark.svg?fit=max&auto=format&n=FgcZrIi8cEeJJGHC&q=85&s=ef801d8ed18c55ed6d930fe23a92c719)](/)

Search...

⌘K

##### Overview

* [Introduction](/overview/introduction)
* [Architecture](/overview/architecture)
* [Agents](/overview/agents)
* [Clients](/overview/clients)

##### Protocol

* [Overview](/protocol/overview)
* [Initialization](/protocol/initialization)
* [Session Setup](/protocol/session-setup)
* [Prompt Turn](/protocol/prompt-turn)
* [Content](/protocol/content)
* [Tool Calls](/protocol/tool-calls)
* [File System](/protocol/file-system)
* [Terminals](/protocol/terminals)
* [Agent Plan](/protocol/agent-plan)
* [Session Modes](/protocol/session-modes)
* [Slash Commands](/protocol/slash-commands)
* [Extensibility](/protocol/extensibility)
* [Transports](/protocol/transports)
* [Schema](/protocol/schema)

##### Libraries

* [Kotlin](/libraries/kotlin)
* [Python](/libraries/python)
* [Rust](/libraries/rust)
* [TypeScript](/libraries/typescript)
* [Community](/libraries/community)

* [GitHub](https://github.com/agentclientprotocol/agent-client-protocol)
* [Zed Industries](https://zed.dev)
* [JetBrains](https://jetbrains.com)

[Agent Client Protocol home page![light logo](https://mintcdn.com/zed-685ed6d6/FgcZrIi8cEeJJGHC/logo/light.svg?fit=max&auto=format&n=FgcZrIi8cEeJJGHC&q=85&s=5cf9119e471543528e40443ba41baf30)![dark logo](https://mintcdn.com/zed-685ed6d6/FgcZrIi8cEeJJGHC/logo/dark.svg?fit=max&auto=format&n=FgcZrIi8cEeJJGHC&q=85&s=ef801d8ed18c55ed6d930fe23a92c719)](/)

Search...

⌘K

* [GitHub](https://github.com/agentclientprotocol/agent-client-protocol)
* [Zed Industries](https://zed.dev)
* [JetBrains](https://jetbrains.com)

Search...

Navigation

Protocol

Session Modes

[Protocol](/overview/introduction)[RFDs](/rfds/about)[Community](/community/communication)[Updates](/updates)[Brand](/brand)

[Protocol](/overview/introduction)[RFDs](/rfds/about)[Community](/community/communication)[Updates](/updates)[Brand](/brand)

Protocol

Session Modes
=============

Copy page

Switch between different agent operating modes

Copy page

Agents can provide a set of modes they can operate in. Modes often affect the system prompts used, the availability of tools, and whether they request permission before running.

[​](#initial-state) Initial state
---------------------------------

During [Session Setup](./session-setup) the Agent **MAY** return a list of modes it can operate in and the currently active mode:

Copy

```
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "sessionId": "sess_abc123def456",
    "modes": {
      "currentModeId": "ask",
      "availableModes": [
        {
          "id": "ask",
          "name": "Ask",
          "description": "Request permission before making any changes"
        },
        {
          "id": "architect",
          "name": "Architect",
          "description": "Design and plan software systems without implementation"
        },
        {
          "id": "code",
          "name": "Code",
          "description": "Write and modify code with full tool access"
        }
      ]
    }
  }
}
```

[​](#param-modes)

modes

SessionModeState

The current mode state for the session

### [​](#sessionmodestate) SessionModeState

[​](#param-current-mode-id)

currentModeId

SessionModeId

required

The ID of the mode that is currently active

[​](#param-available-modes)

availableModes

SessionMode[]

required

The set of modes that the Agent can operate in

### [​](#sessionmode) SessionMode

[​](#param-id)

id

SessionModeId

required

Unique identifier for this mode

[​](#param-name)

name

string

required

Human-readable name of the mode

[​](#param-description)

description

string

Optional description providing more details about what this mode does

[​](#setting-the-current-mode) Setting the current mode
-------------------------------------------------------

The current mode can be changed at any point during a session, whether the Agent is idle or generating a response.

### [​](#from-the-client) From the Client

Typically, Clients display the available modes to the user and allow them to change the current one, which they can do by calling the [`session/set_mode`](./schema#session%2Fset-mode) method.

Copy

```
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/set_mode",
  "params": {
    "sessionId": "sess_abc123def456",
    "modeId": "code"
  }
}
```

[​](#param-session-id)

sessionId

SessionId

required

The ID of the session to set the mode for

[​](#param-mode-id)

modeId

SessionModeId

required

The ID of the mode to switch to. Must be one of the modes listed in
`availableModes`

### [​](#from-the-agent) From the Agent

The Agent can also change its own mode and let the Client know by sending the `current_mode_update` session notification:

Copy

```
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "sess_abc123def456",
    "update": {
      "sessionUpdate": "current_mode_update",
      "modeId": "code"
    }
  }
}
```

#### [​](#exiting-plan-modes) Exiting plan modes

A common case where an Agent might switch modes is from within a special “exit mode” tool that can be provided to the language model during plan/architect modes. The language model can call this tool when it determines it’s ready to start implementing a solution.
This “switch mode” tool will usually request permission before running, which it can do just like any other tool:

Copy

```
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session/request_permission",
  "params": {
    "sessionId": "sess_abc123def456",
    "toolCall": {
      "toolCallId": "call_switch_mode_001",
      "title": "Ready for implementation",
      "kind": "switch_mode",
      "status": "pending",
      "content": [
        {
          "type": "text",
          "text": "## Implementation Plan..."
        }
      ]
    },
    "options": [
      {
        "optionId": "code",
        "name": "Yes, and auto-accept all actions",
        "kind": "allow_always"
      },
      {
        "optionId": "ask",
        "name": "Yes, and manually accept actions",
        "kind": "allow_once"
      },
      {
        "optionId": "reject",
        "name": "No, stay in architect mode",
        "kind": "reject_once"
      }
    ]
  }
}
```

When an option is chosen, the tool runs, setting the mode and sending the `current_mode_update` notification mentioned above.
[Learn more about permission requests](./tool-calls#requesting-permission)

Was this page helpful?

YesNo

[Previous](/protocol/agent-plan)[Slash CommandsAdvertise available slash commands to clients

Next](/protocol/slash-commands)

⌘I

[github](https://github.com/agentclientprotocol/agent-client-protocol)

[Powered by](https://www.mintlify.com?utm_campaign=poweredBy&utm_medium=referral&utm_source=zed-685ed6d6)

On this page

* [Initial state](#initial-state)
* [SessionModeState](#sessionmodestate)
* [SessionMode](#sessionmode)
* [Setting the current mode](#setting-the-current-mode)
* [From the Client](#from-the-client)
* [From the Agent](#from-the-agent)
* [Exiting plan modes](#exiting-plan-modes)
