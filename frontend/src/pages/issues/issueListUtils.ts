export function hasStringLabel(labels: unknown, needle: string): boolean {
  if (!Array.isArray(labels)) return false;
  const expected = needle.trim().toLowerCase();
  return labels.some((x) => typeof x === "string" && x.trim().toLowerCase() === expected);
}

