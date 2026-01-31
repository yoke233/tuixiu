import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { downloadToFileMock } = vi.hoisted(() => ({
  downloadToFileMock: vi.fn(),
}));

vi.mock("./httpDownload.js", () => ({ downloadToFile: downloadToFileMock }));

const { computeContentHashFromDir } = await import("./contentHash.js");
const { prepareSkillsForRun } = await import("./skillsMount.js");

function crc32(buf: Uint8Array): number {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }

  let crc = 0xffffffff;
  for (const b of buf) {
    crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n & 0xffff, 0);
  return b;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

function makeZip(files: Array<{ name: string; content: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];

  let offset = 0;
  for (const f of files) {
    const nameBytes = Buffer.from(f.name.replace(/\\/g, "/"), "utf8");
    const data = f.content;
    const crc = crc32(data);

    const localHeader = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      nameBytes,
    ]);
    parts.push(localHeader, data);

    const centralHeader = Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBytes,
    ]);
    central.push(centralHeader);

    offset += localHeader.length + data.length;
  }

  const centralStart = offset;
  const centralDir = Buffer.concat(central);
  parts.push(centralDir);

  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralDir.length),
    u32(centralStart),
    u16(0),
  ]);
  parts.push(end);
  return Buffer.concat(parts);
}

describe("skills/skillsMount prepareSkillsForRun", () => {
  let homeDir = "";
  let workspace1 = "";
  let workspace2 = "";
  let skillDir = "";

  const oldHome = process.env.HOME;
  const oldUserProfile = process.env.USERPROFILE;

  beforeEach(async () => {
    downloadToFileMock.mockReset();
    homeDir = await mkdtemp(path.join(os.tmpdir(), "tuixiu-home-"));
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    workspace1 = await mkdtemp(path.join(os.tmpdir(), "tuixiu-ws-"));
    workspace2 = await mkdtemp(path.join(os.tmpdir(), "tuixiu-ws-"));

    skillDir = await mkdtemp(path.join(os.tmpdir(), "tuixiu-skill-"));
    await writeFile(path.join(skillDir, "SKILL.md"), "# demo\n", "utf8");
    await writeFile(path.join(skillDir, "a.txt"), "a\n", "utf8");
  });

  afterEach(async () => {
    process.env.HOME = oldHome;
    process.env.USERPROFILE = oldUserProfile;
    await Promise.allSettled([
      homeDir ? rm(homeDir, { recursive: true, force: true }) : Promise.resolve(),
      workspace1 ? rm(workspace1, { recursive: true, force: true }) : Promise.resolve(),
      workspace2 ? rm(workspace2, { recursive: true, force: true }) : Promise.resolve(),
      skillDir ? rm(skillDir, { recursive: true, force: true }) : Promise.resolve(),
    ]);
  });

  it("downloads once and hits cache on second run", async () => {
    const hashed = await computeContentHashFromDir(skillDir);
    const zip = makeZip([
      { name: "SKILL.md", content: Buffer.from("# demo\n", "utf8") },
      { name: "a.txt", content: Buffer.from("a\n", "utf8") },
    ]);

    downloadToFileMock.mockImplementation(async (opts: any) => {
      await mkdir(path.dirname(opts.destFile), { recursive: true });
      await writeFile(opts.destFile, zip);
      return { bytes: zip.length };
    });

    const ctx = {
      cfg: {
        orchestrator_url: "ws://example/ws/agent",
        auth_token: "t",
        skills_mounting_enabled: true,
        skills_download_max_bytes: 123,
        agent_env_allowlist: ["CODEX_HOME"],
        sandbox: { workspaceMode: "mount" },
      },
      sandbox: { provider: "container_oci" },
      log: vi.fn(),
    } as any;

    const init1 = {
      skillsManifest: {
        runId: "r1",
        skillVersions: [
          {
            skillId: "s1",
            skillName: "Demo Skill",
            skillVersionId: "v1",
            contentHash: hashed.contentHash,
            storageUri: `/api/acp-proxy/skills/packages/${hashed.contentHash}.zip`,
          },
        ],
      },
    };

    const res1 = await prepareSkillsForRun({
      ctx,
      run: { runId: "r1", hostWorkspacePath: workspace1 } as any,
      init: init1,
    });
    expect(res1).not.toBeNull();
    expect(downloadToFileMock).toHaveBeenCalledTimes(1);
    expect(downloadToFileMock).toHaveBeenCalledWith(expect.objectContaining({ maxBytes: 123 }));
    expect(
      await readFile(
        path.join(workspace1, ".tuixiu", "codex-home", "skills", "demo-skill", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# demo\n");

    const init2 = {
      skillsManifest: { ...init1.skillsManifest, runId: "r2" },
    };
    const res2 = await prepareSkillsForRun({
      ctx,
      run: { runId: "r2", hostWorkspacePath: workspace2 } as any,
      init: init2,
    });
    expect(res2).not.toBeNull();
    expect(downloadToFileMock).toHaveBeenCalledTimes(1);
    expect(
      await readFile(
        path.join(workspace2, ".tuixiu", "codex-home", "skills", "demo-skill", "SKILL.md"),
        "utf8",
      ),
    ).toBe("# demo\n");
  });
});
