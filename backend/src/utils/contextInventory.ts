import { DEFAULT_INVENTORY_PATH, type WorkspaceInventory } from "./contextWorkspace.js";

export function buildContextInventory(items: WorkspaceInventory["items"]): WorkspaceInventory {
  return { generatedAt: new Date().toISOString(), items };
}

export function stringifyContextInventory(items: WorkspaceInventory["items"]): {
  path: string;
  json: string;
} {
  const inventory = buildContextInventory(items);
  return { path: DEFAULT_INVENTORY_PATH, json: JSON.stringify(inventory) };
}
