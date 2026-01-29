// src/sandbox/containerOciGlue.ts (示例)
import type WebSocket from "ws";
import { ContainerOciCliProvider, type ContainerOciConfig } from "./providers/container_oci_cli.js";

export function createContainerOciProvider(cfg: ContainerOciConfig) {
  const provider = new ContainerOciCliProvider(cfg);

  return {
    async onAcpOpen(ws: WebSocket, send: (o: any) => void, msg: any, agent_command: string[]) {
      await provider.open(ws, send, {
        run_id: String(msg.run_id),
        instance_name: String(msg.instance_name),
        init: msg.init ?? {},
        agent_command,
      });
    },

    onAcpMessage(msg: any) {
      // 示例：把服务端下发的消息写入 agent stdin
      // 你测试里 agentCode 用 readline 按行读 JSON，所以这里必须带 \n
      provider.sendToAgent(String(msg.instance_name), JSON.stringify(msg.message) + "\n");
    },

    async onSandboxRemove(send: (o: any) => void, msg: any) {
      const r = await provider.remove(String(msg.instance_name));
      send({ type: "sandbox_control_result", ok: r.ok, status: r.status });
    },
  };
}
