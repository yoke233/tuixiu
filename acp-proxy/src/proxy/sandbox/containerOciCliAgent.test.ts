import { describe, expect, it } from "vitest";

import { buildContainerEntrypointScript, parseContainerCli } from "./containerOciCliAgent.js";

describe("proxy/sandbox/containerOciCliAgent", () => {
  it("buildContainerEntrypointScript: 带 init 时包含 marker/exec/env export", () => {
    const script = buildContainerEntrypointScript({
      workingDir: "/workspace",
      initMarkerPrefix: "__M__:",
      initScript: 'echo "INIT_ENV=$TEST_ENV" >&2',
      initEnv: { TEST_ENV: "ok", "BAD-KEY": "x" },
    });

    expect(script).toContain("set -euo pipefail");
    expect(script).toContain("workspace='/workspace'");
    expect(script).toContain('mkdir -p "$workspace"');
    expect(script).toContain("export TEST_ENV=$'ok'");
    expect(script).not.toContain("BAD-KEY");
    expect(script).toContain("marker='__M__:'");
    expect(script).toContain('printf \'%s{"ok":true}\\n\' "$marker" >&2');
    expect(script).toContain('exec "$@"');
  });

  it("buildContainerEntrypointScript: 无 init 时不注入 marker", () => {
    const script = buildContainerEntrypointScript({
      workingDir: "/workspace",
      initMarkerPrefix: "__M__:",
      initScript: "",
      initEnv: undefined,
    });

    expect(script).toContain('exec "$@"');
    expect(script).not.toContain("marker='__M__:'");
  });

  it("parseContainerCli: trims and validates", () => {
    expect(parseContainerCli(" docker ")).toBe("docker");
    expect(() => parseContainerCli("runc")).toThrow(/不支持的容器 CLI/);
  });
});
