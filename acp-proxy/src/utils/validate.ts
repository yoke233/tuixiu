export function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export function validateRunId(v: unknown): string {
  const runId = String(v ?? "").trim();
  if (!runId) throw new Error("run_id 为空");
  if (runId.length > 200) throw new Error("run_id 过长");
  if (/[\\/]/.test(runId)) throw new Error("run_id 不能包含路径分隔符");
  if (runId.includes(":")) throw new Error("run_id 不能包含 ':'");
  return runId;
}

export function validateInstanceName(v: unknown): string {
  const name = String(v ?? "").trim();
  if (!name) throw new Error("instance_name 为空");
  if (name.length > 200) throw new Error("instance_name 过长");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error("instance_name 含非法字符");
  }
  return name;
}
