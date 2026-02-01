export type WorkspaceAccessMode = "ro" | "rw";
export type WorkspaceLifecycle = "ephemeral" | "persisted";
export type WorkspaceMountSource = "repo" | "skills" | "bundle" | "artifact";

export type WorkspaceMount = {
  key: string;
  source: WorkspaceMountSource;
  path: string;
  access: WorkspaceAccessMode;
  meta?: Record<string, unknown> | null;
};

export type WorkspaceInventoryItem = {
  key: string;
  source: WorkspaceMountSource;
  ref?: string | null;
  version?: string | null;
  hash?: string | null;
};

export type WorkspaceInventory = {
  generatedAt: string;
  items: WorkspaceInventoryItem[];
};

export type WorkspaceSpec = {
  mounts: WorkspaceMount[];
  lifecycle: WorkspaceLifecycle;
  inventoryPath: string;
};

export const DEFAULT_INVENTORY_PATH = ".tuixiu/context-inventory.json";
