import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";

import { AcpClientFacade, type JsonRpcRequest } from "./acpClientFacade.js";

function makeHandle(opts?: { stdout?: string; stderr?: string; code?: number | null }) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();

  if (opts?.stdout) stdout.end(opts.stdout);
  else stdout.end();

  if (opts?.stderr) stderr.end(opts.stderr);
  else stderr.end();

  const handle: any = {
    stdin: WritableStreamFromNodeStream(stdin),
    stdout: ReadableStreamFromNodeStream(stdout),
    stderr: ReadableStreamFromNodeStream(stderr),
    close: async () => {},
    onExit: (cb: any) => cb({ code: opts?.code ?? 0, signal: null }),
  };
  return handle;
}

function ReadableStreamFromNodeStream(node: PassThrough): ReadableStream<Uint8Array> {
  const reader = node as any;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      reader.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      reader.on("end", () => controller.close());
      reader.on("error", (err: any) => controller.error(err));
    },
  });
}

function WritableStreamFromNodeStream(node: PassThrough): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      node.write(Buffer.from(chunk));
    },
    close() {
      node.end();
    },
    abort() {
      node.end();
    },
  });
}

describe("AcpClientFacade host_process fs path mapping", () => {
  it("fs/write_text_file resolves relative path under workspaceHostRoot", async () => {
    const execProcess = vi.fn(async (opts: any) => {
      expect(opts.cwdInGuest).toBe("D:\\workspaces\\run-r1");
      expect(opts.command[0]).toBe("node");
      expect(opts.command[1]).toBe("-e");
      expect(String(opts.command[3]).toLowerCase()).toContain("d:\\workspaces\\run-r1\\docs\\test1.md");
      return makeHandle();
    });

    const facade = new AcpClientFacade({
      runId: "r1",
      instanceName: "inst1",
      workspaceGuestRoot: "/workspace",
      workspaceHostRoot: "D:\\workspaces\\run-r1",
      sandbox: { provider: "host_process", execProcess } as any,
      log: () => {},
      terminalEnabled: true,
    });

    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "fs/write_text_file",
      params: { path: "docs/test1.md", content: "hi" },
    };
    const res = await facade.handleRequest(req);
    expect(res?.error).toBeUndefined();
    expect(execProcess).toHaveBeenCalledTimes(1);
  });

  it("fs/write_text_file rejects absolute path outside workspaceHostRoot", async () => {
    const facade = new AcpClientFacade({
      runId: "r1",
      instanceName: "inst1",
      workspaceGuestRoot: "/workspace",
      workspaceHostRoot: "D:\\workspaces\\run-r1",
      sandbox: { provider: "host_process", execProcess: vi.fn() } as any,
      log: () => {},
      terminalEnabled: true,
    });

    const req: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "fs/write_text_file",
      params: { path: "D:\\workspaces\\other\\x.md", content: "no" },
    };
    const res = await facade.handleRequest(req);
    expect(res?.error).toBeTruthy();
  });
});

