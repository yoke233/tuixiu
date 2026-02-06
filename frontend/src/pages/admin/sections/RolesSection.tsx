import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { createRole, deleteRole, listRoles, updateRole } from "@/api/roles";
import { getRoleSkills, putRoleSkills, type RoleSkillItem } from "@/api/roleSkills";
import {
  listSkillVersions,
  searchSkills,
  type SkillSearchItem,
  type SkillVersion,
} from "@/api/skills";
import type { AgentInputsManifestV1, RoleTemplate } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RoleAgentFilesCard } from "@/pages/admin/sections/roles/RoleAgentFilesCard";
import { RoleSkillsCard } from "@/pages/admin/sections/roles/RoleSkillsCard";
import { RoleTemplateManageForm } from "@/pages/admin/sections/roles/RoleTemplateManageForm";
import {
  cloneAgentInputsManifest,
  createEmptyManifest,
  getAgentsMdInlineText,
  makeAgentInputId,
  normalizeItemForApply,
  upsertAgentsMdInlineText,
} from "@/pages/admin/sections/roles/roleAgentFilesHelpers";

type Props = {
  active: boolean;
  effectiveProjectId: string;
  requireAdmin: () => boolean;
  setError: (msg: string | null) => void;
};

export function RolesSection(props: Props) {
  const { active, effectiveProjectId, requireAdmin, setError } = props;

  const roleCreateKeyRef = useRef<HTMLInputElement>(null);
  const agentInputsInlineFileRef = useRef<HTMLInputElement>(null);
  const [roleSearch, setRoleSearch] = useState("");
  const [roleKey, setRoleKey] = useState("");
  const [roleDisplayName, setRoleDisplayName] = useState("");
  const [roleDescription, setRoleDescription] = useState("");
  const [rolePromptTemplate, setRolePromptTemplate] = useState("");
  const [roleInitScript, setRoleInitScript] = useState("");
  const [roleInitTimeoutSeconds, setRoleInitTimeoutSeconds] = useState("300");
  const [roleEnvText, setRoleEnvText] = useState("");
  const [roleCreateAgentInputs, setRoleCreateAgentInputs] = useState<
    AgentInputsManifestV1 | null | undefined
  >(undefined);
  const [roleCreateSkillsDraft, setRoleCreateSkillsDraft] = useState<RoleSkillItem[] | null>(null);
  const [createSkillsSearchQ, setCreateSkillsSearchQ] = useState("");
  const [createSkillsSearchLoading, setCreateSkillsSearchLoading] = useState(false);
  const [createSkillsSearchError, setCreateSkillsSearchError] = useState<string | null>(null);
  const [createSkillsSearchResults, setCreateSkillsSearchResults] = useState<SkillSearchItem[]>([]);
  const [createSkillVersionsById, setCreateSkillVersionsById] = useState<
    Record<string, SkillVersion[]>
  >({});
  const [createSkillVersionsLoadingById, setCreateSkillVersionsLoadingById] = useState<
    Record<string, boolean>
  >({});

  const [createAgentInputsSelectedId, setCreateAgentInputsSelectedId] = useState("");

  const [roles, setRoles] = useState<RoleTemplate[]>([]);
  const [rolesLoading, setRolesLoading] = useState(false);
  const [rolesError, setRolesError] = useState<string | null>(null);

  const [roleEditingId, setRoleEditingId] = useState("");
  const [roleEditDisplayName, setRoleEditDisplayName] = useState("");
  const [roleEditDescription, setRoleEditDescription] = useState("");
  const [roleEditPromptTemplate, setRoleEditPromptTemplate] = useState("");
  const [roleEditInitScript, setRoleEditInitScript] = useState("");
  const [roleEditInitTimeoutSeconds, setRoleEditInitTimeoutSeconds] = useState("");
  const [roleEditEnvTextEnabled, setRoleEditEnvTextEnabled] = useState(false);
  const [roleEditEnvText, setRoleEditEnvText] = useState("");
  const [roleSavingId, setRoleSavingId] = useState("");
  const [roleDeletingId, setRoleDeletingId] = useState("");

  const [roleAgentInputs, setRoleAgentInputs] = useState<AgentInputsManifestV1>({
    version: 1,
    items: [],
  });
  const [roleAgentInputsSelectedId, setRoleAgentInputsSelectedId] = useState("");
  const [roleAgentInputsSaving, setRoleAgentInputsSaving] = useState(false);
  const [roleAgentInputsError, setRoleAgentInputsError] = useState<string | null>(null);
  const [roleAgentInputsErrorDetails, setRoleAgentInputsErrorDetails] = useState<unknown | null>(
    null,
  );

  const [roleSkills, setRoleSkills] = useState<RoleSkillItem[]>([]);
  const [roleSkillsLoading, setRoleSkillsLoading] = useState(false);
  const [roleSkillsError, setRoleSkillsError] = useState<string | null>(null);
  const [roleSkillsSaving, setRoleSkillsSaving] = useState(false);

  const [roleSkillsSearchQ, setRoleSkillsSearchQ] = useState("");
  const [roleSkillsSearchLoading, setRoleSkillsSearchLoading] = useState(false);
  const [roleSkillsSearchError, setRoleSkillsSearchError] = useState<string | null>(null);
  const [roleSkillsSearchResults, setRoleSkillsSearchResults] = useState<SkillSearchItem[]>([]);

  const [roleSkillVersionsById, setRoleSkillVersionsById] = useState<
    Record<string, SkillVersion[]>
  >({});
  const [roleSkillVersionsLoadingById, setRoleSkillVersionsLoadingById] = useState<
    Record<string, boolean>
  >({});

  const editingRole = useMemo(
    () => roles.find((role) => role.id === roleEditingId) ?? null,
    [roleEditingId, roles],
  );

  const filteredRoles = useMemo(() => {
    const q = roleSearch.trim().toLowerCase();
    if (!q) return roles;
    return roles.filter((role) => {
      const hay = [
        role.key,
        role.displayName ?? "",
        role.description ?? "",
        ...(role.envKeys ?? []),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [roleSearch, roles]);

  const resetRoleEdit = useCallback(() => {
    setRoleEditingId("");
    setRoleEditDisplayName("");
    setRoleEditDescription("");
    setRoleEditPromptTemplate("");
    setRoleEditInitScript("");
    setRoleEditInitTimeoutSeconds("");
    setRoleEditEnvTextEnabled(false);
    setRoleEditEnvText("");

    setRoleAgentInputs({ version: 1, items: [] });
    setRoleAgentInputsSelectedId("");
    setRoleAgentInputsSaving(false);
    setRoleAgentInputsError(null);
    setRoleAgentInputsErrorDetails(null);

    setRoleSkills([]);
    setRoleSkillsLoading(false);
    setRoleSkillsError(null);
    setRoleSkillsSaving(false);
    setRoleSkillsSearchQ("");
    setRoleSkillsSearchLoading(false);
    setRoleSkillsSearchError(null);
    setRoleSkillsSearchResults([]);
  }, []);

  const refreshRoles = useCallback(async () => {
    if (!effectiveProjectId) return;
    setRolesLoading(true);
    setRolesError(null);
    try {
      const items = await listRoles(effectiveProjectId);
      setRoles(items);
    } catch (e) {
      setRolesError(e instanceof Error ? e.message : String(e));
    } finally {
      setRolesLoading(false);
    }
  }, [effectiveProjectId]);

  useEffect(() => {
    if (!active) {
      resetRoleEdit();
      return;
    }
    resetRoleEdit();
    void refreshRoles();
  }, [active, refreshRoles, resetRoleEdit]);

  useEffect(() => {
    if (!active) return;
    if (!effectiveProjectId || !roleEditingId) return;

    setRoleSkillsError(null);
    setRoleSkillsLoading(true);
    void (async () => {
      try {
        if (!requireAdmin()) return;
        const res = await getRoleSkills(effectiveProjectId, roleEditingId);
        setRoleSkills(Array.isArray(res.items) ? res.items : []);
      } catch (e) {
        setRoleSkillsError(e instanceof Error ? e.message : String(e));
        setRoleSkills([]);
      } finally {
        setRoleSkillsLoading(false);
      }
    })();
  }, [active, effectiveProjectId, requireAdmin, roleEditingId]);

  const startRoleEdit = useCallback((role: RoleTemplate) => {
    setRoleEditingId(role.id);
    setRoleEditDisplayName(role.displayName ?? "");
    setRoleEditDescription(role.description ?? "");
    setRoleEditPromptTemplate(role.promptTemplate ?? "");
    setRoleEditInitScript(role.initScript ?? "");
    setRoleEditInitTimeoutSeconds(String(role.initTimeoutSeconds ?? 300));
    setRoleEditEnvTextEnabled(false);
    setRoleEditEnvText(role.envText ?? "");

    const nextAgentInputs = cloneAgentInputsManifest(role.agentInputs);
    setRoleAgentInputs(nextAgentInputs);
    setRoleAgentInputsSelectedId(nextAgentInputs.items[0]?.id ?? "");
    setRoleAgentInputsError(null);
    setRoleAgentInputsErrorDetails(null);
  }, []);

  const copyRoleToCreate = useCallback(
    (
      role: RoleTemplate,
      opts?: { agentInputs?: AgentInputsManifestV1 | null; skills?: RoleSkillItem[] },
    ) => {
      setRoleKey("");
      setRoleDisplayName(role.displayName ?? "");
      setRoleDescription(role.description ?? "");
      setRolePromptTemplate(role.promptTemplate ?? "");
      setRoleInitScript(role.initScript ?? "");
      setRoleInitTimeoutSeconds(String(role.initTimeoutSeconds ?? 300));
      setRoleEnvText(role.envText ?? "");
      setRoleCreateAgentInputs(opts?.agentInputs ?? role.agentInputs ?? null);
      setRoleCreateSkillsDraft(opts?.skills ? opts.skills.map((s) => ({ ...s })) : null);
      setTimeout(() => roleCreateKeyRef.current?.focus(), 0);
    },
    [],
  );

  const copyEditingRoleToCreate = useCallback(() => {
    if (!editingRole) return;
    const copiedAgentInputs: AgentInputsManifestV1 = {
      version: 1,
      ...(roleAgentInputs.envPatch ? { envPatch: roleAgentInputs.envPatch } : {}),
      items: roleAgentInputs.items.map((it) => ({
        ...it,
        source: { ...(it.source as any) },
        target: { ...(it.target as any) },
      })),
    };
    const copiedSkills = roleSkills.map((s) => ({ ...s }));
    resetRoleEdit();
    copyRoleToCreate(editingRole, { agentInputs: copiedAgentInputs, skills: copiedSkills });
  }, [
    copyRoleToCreate,
    editingRole,
    resetRoleEdit,
    roleAgentInputs.envPatch,
    roleAgentInputs.items,
    roleSkills,
  ]);

  const onCreateRole = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      if (!requireAdmin()) return;
      if (!effectiveProjectId) {
        setError("请先创建 Project");
        return;
      }

      const key = roleKey.trim();
      const name = roleDisplayName.trim();
      if (!key || !name) return;

      try {
        const created = await createRole(effectiveProjectId, {
          key,
          displayName: name,
          description: roleDescription.trim() || undefined,
          promptTemplate: rolePromptTemplate.trim() || undefined,
          initScript: roleInitScript.trim() || undefined,
          envText: roleEnvText.trim() || undefined,
          initTimeoutSeconds: Number(roleInitTimeoutSeconds) || undefined,
          ...(roleCreateAgentInputs !== undefined ? { agentInputs: roleCreateAgentInputs } : {}),
        });

        if (roleCreateSkillsDraft?.length) {
          await putRoleSkills(
            effectiveProjectId,
            created.id,
            roleCreateSkillsDraft.map((x) => ({
              skillId: x.skillId,
              versionPolicy: x.versionPolicy,
              ...(x.pinnedVersionId ? { pinnedVersionId: x.pinnedVersionId } : {}),
              enabled: x.enabled,
            })),
          ).catch(() => { });
        }
        setRoleKey("");
        setRoleDisplayName("");
        setRoleDescription("");
        setRolePromptTemplate("");
        setRoleInitScript("");
        setRoleInitTimeoutSeconds("300");
        setRoleEnvText("");
        setRoleCreateAgentInputs(undefined);
        setRoleCreateSkillsDraft(null);
        await refreshRoles();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [
      effectiveProjectId,
      refreshRoles,
      requireAdmin,
      roleDisplayName,
      roleDescription,
      roleEnvText,
      roleInitScript,
      roleInitTimeoutSeconds,
      roleKey,
      roleCreateAgentInputs,
      roleCreateSkillsDraft,
      rolePromptTemplate,
      setError,
    ],
  );

  const onUpdateRole = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      if (!requireAdmin()) return;
      if (!effectiveProjectId) {
        setError("请先创建 Project");
        return;
      }
      if (!roleEditingId) return;

      const displayName = roleEditDisplayName.trim();
      if (!displayName) {
        setError("显示名称不能为空");
        return;
      }

      const timeoutRaw = roleEditInitTimeoutSeconds.trim();
      let timeoutSeconds: number | undefined;
      if (timeoutRaw) {
        const parsed = Number(timeoutRaw);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          setError("init 超时秒数需要正整数");
          return;
        }
        timeoutSeconds = parsed;
      }

      setRoleSavingId(roleEditingId);
      try {
        await updateRole(effectiveProjectId, roleEditingId, {
          displayName,
          description: roleEditDescription.trim(),
          promptTemplate: roleEditPromptTemplate.trim(),
          initScript: roleEditInitScript.trim(),
          ...(roleEditEnvTextEnabled ? { envText: roleEditEnvText } : {}),
          initTimeoutSeconds: timeoutSeconds,
        });
        resetRoleEdit();
        await refreshRoles();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setRoleSavingId("");
      }
    },
    [
      effectiveProjectId,
      refreshRoles,
      requireAdmin,
      resetRoleEdit,
      roleEditDescription,
      roleEditDisplayName,
      roleEditEnvText,
      roleEditEnvTextEnabled,
      roleEditingId,
      roleEditInitScript,
      roleEditInitTimeoutSeconds,
      roleEditPromptTemplate,
      setError,
    ],
  );

  const onDeleteRole = useCallback(
    async (role: RoleTemplate) => {
      setError(null);
      if (!requireAdmin()) return;
      if (!effectiveProjectId) {
        setError("请先创建 Project");
        return;
      }
      if (!window.confirm(`确认删除 RoleTemplate？\n\n${role.displayName} (${role.key})`)) return;

      setRoleDeletingId(role.id);
      try {
        await deleteRole(effectiveProjectId, role.id);
        if (roleEditingId === role.id) resetRoleEdit();
        await refreshRoles();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setRoleDeletingId("");
      }
    },
    [effectiveProjectId, refreshRoles, requireAdmin, resetRoleEdit, roleEditingId, setError],
  );

  const onRoleSkillsSearch = useCallback(async () => {
    setRoleSkillsSearchError(null);
    setError(null);
    if (!requireAdmin()) return;
    const q = roleSkillsSearchQ.trim();

    setRoleSkillsSearchLoading(true);
    try {
      const res = await searchSkills({ provider: "registry", q: q || undefined, limit: 20 });
      setRoleSkillsSearchResults(Array.isArray(res.items) ? res.items : []);
    } catch (e) {
      setRoleSkillsSearchError(e instanceof Error ? e.message : String(e));
      setRoleSkillsSearchResults([]);
    } finally {
      setRoleSkillsSearchLoading(false);
    }
  }, [requireAdmin, roleSkillsSearchQ, setError]);

  const onCreateRoleSkillsSearch = useCallback(async () => {
    setCreateSkillsSearchError(null);
    setError(null);
    if (!requireAdmin()) return;
    const q = createSkillsSearchQ.trim();

    setCreateSkillsSearchLoading(true);
    try {
      const res = await searchSkills({ provider: "registry", q: q || undefined, limit: 20 });
      setCreateSkillsSearchResults(Array.isArray(res.items) ? res.items : []);
    } catch (e) {
      setCreateSkillsSearchError(e instanceof Error ? e.message : String(e));
      setCreateSkillsSearchResults([]);
    } finally {
      setCreateSkillsSearchLoading(false);
    }
  }, [createSkillsSearchQ, requireAdmin, setError]);

  const addRoleSkill = useCallback((it: SkillSearchItem) => {
    setRoleSkills((prev) => {
      if (prev.some((x) => x.skillId === it.skillId)) return prev;
      return [
        ...prev,
        {
          skillId: it.skillId,
          name: it.name,
          versionPolicy: it.latestVersion ? "latest" : "pinned",
          pinnedVersionId: null,
          enabled: true,
        },
      ];
    });
  }, []);

  const addCreateRoleSkill = useCallback((it: SkillSearchItem) => {
    setRoleCreateSkillsDraft((prev) => {
      const base = Array.isArray(prev) ? prev : [];
      if (base.some((x) => x.skillId === it.skillId)) return prev;
      return [
        ...base,
        {
          skillId: it.skillId,
          name: it.name,
          versionPolicy: it.latestVersion ? "latest" : "pinned",
          pinnedVersionId: null,
          enabled: true,
        },
      ];
    });
  }, []);

  const ensureRoleSkillVersions = useCallback(
    async (skillId: string) => {
      if (!requireAdmin()) return;
      if (roleSkillVersionsById[skillId]) return;

      setRoleSkillVersionsLoadingById((prev) => ({ ...prev, [skillId]: true }));
      try {
        const vs = await listSkillVersions(skillId);
        setRoleSkillVersionsById((prev) => ({ ...prev, [skillId]: vs }));
        setRoleSkills((prev) => {
          const idx = prev.findIndex((x) => x.skillId === skillId);
          if (idx < 0) return prev;
          const item = prev[idx];
          if (!item) return prev;
          if (item.versionPolicy !== "pinned") return prev;
          if (item.pinnedVersionId) return prev;
          const first = vs[0]?.id ?? null;
          if (!first) return prev;
          const next = [...prev];
          next[idx] = { ...item, pinnedVersionId: first };
          return next;
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setRoleSkillVersionsLoadingById((prev) => ({ ...prev, [skillId]: false }));
      }
    },
    [requireAdmin, roleSkillVersionsById, setError],
  );

  const ensureCreateRoleSkillVersions = useCallback(
    async (skillId: string) => {
      if (!requireAdmin()) return;
      if (createSkillVersionsById[skillId]) return;

      setCreateSkillVersionsLoadingById((prev) => ({ ...prev, [skillId]: true }));
      try {
        const vs = await listSkillVersions(skillId);
        setCreateSkillVersionsById((prev) => ({ ...prev, [skillId]: vs }));
        setRoleCreateSkillsDraft((prev) => {
          const base = Array.isArray(prev) ? prev : [];
          const idx = base.findIndex((x) => x.skillId === skillId);
          if (idx < 0) return prev;
          const item = base[idx];
          if (!item) return prev;
          if (item.versionPolicy !== "pinned") return prev;
          if (item.pinnedVersionId) return prev;
          const first = vs[0]?.id ?? null;
          if (!first) return prev;
          const next = [...base];
          next[idx] = { ...item, pinnedVersionId: first };
          return next;
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setCreateSkillVersionsLoadingById((prev) => ({ ...prev, [skillId]: false }));
      }
    },
    [createSkillVersionsById, requireAdmin, setError],
  );

  useEffect(() => {
    if (!active) return;
    for (const it of roleSkills) {
      if (it.versionPolicy !== "pinned") continue;
      if (roleSkillVersionsById[it.skillId]) continue;
      void ensureRoleSkillVersions(it.skillId);
    }
  }, [active, ensureRoleSkillVersions, roleSkillVersionsById, roleSkills]);

  useEffect(() => {
    if (!active) return;
    const items = Array.isArray(roleCreateSkillsDraft) ? roleCreateSkillsDraft : [];
    for (const it of items) {
      if (it.versionPolicy !== "pinned") continue;
      if (createSkillVersionsById[it.skillId]) continue;
      void ensureCreateRoleSkillVersions(it.skillId);
    }
  }, [active, createSkillVersionsById, ensureCreateRoleSkillVersions, roleCreateSkillsDraft]);

  const removeRoleSkill = useCallback((skillId: string) => {
    setRoleSkills((prev) => prev.filter((x) => x.skillId !== skillId));
  }, []);

  const removeCreateRoleSkill = useCallback((skillId: string) => {
    setRoleCreateSkillsDraft((prev) =>
      Array.isArray(prev) ? prev.filter((x) => x.skillId !== skillId) : prev,
    );
  }, []);

  const onSaveRoleSkills = useCallback(async () => {
    setError(null);
    if (!requireAdmin()) return;
    if (!effectiveProjectId || !roleEditingId) return;

    const missingPinned = roleSkills.filter(
      (x) => x.versionPolicy === "pinned" && !x.pinnedVersionId,
    );
    if (missingPinned.length) {
      setError("存在 pinned 技能未选择版本，请先选择 pinnedVersionId");
      for (const it of missingPinned) {
        void ensureRoleSkillVersions(it.skillId);
      }
      return;
    }

    setRoleSkillsSaving(true);
    try {
      const res = await putRoleSkills(
        effectiveProjectId,
        roleEditingId,
        roleSkills.map((x) => ({
          skillId: x.skillId,
          versionPolicy: x.versionPolicy,
          ...(x.pinnedVersionId ? { pinnedVersionId: x.pinnedVersionId } : {}),
          enabled: x.enabled,
        })),
      );
      setRoleSkills(Array.isArray(res.items) ? res.items : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRoleSkillsSaving(false);
    }
  }, [
    effectiveProjectId,
    ensureRoleSkillVersions,
    requireAdmin,
    roleEditingId,
    roleSkills,
    setError,
  ]);


  const onSaveAgentInputs = useCallback(async () => {
    setError(null);
    setRoleAgentInputsError(null);
    setRoleAgentInputsErrorDetails(null);
    if (!effectiveProjectId || !roleEditingId) return;

    setRoleAgentInputsSaving(true);
    try {
      const role = await updateRole(effectiveProjectId, roleEditingId, {
        agentInputs: roleAgentInputs,
      });
      setRoles((prev) => prev.map((r) => (r.id === role.id ? role : r)));
    } catch (err) {
      setRoleAgentInputsError(err instanceof Error ? err.message : String(err));
      setRoleAgentInputsErrorDetails((err as any)?.details ?? null);
    } finally {
      setRoleAgentInputsSaving(false);
    }
  }, [effectiveProjectId, roleAgentInputs, roleEditingId, setError]);

  const onStartCreate = useCallback(() => {
    resetRoleEdit();
    setRoleKey("");
    setRoleDisplayName("");
    setRoleDescription("");
    setRolePromptTemplate("");
    setRoleInitScript("");
    setRoleInitTimeoutSeconds("300");
    setRoleEnvText("");
    setRoleCreateAgentInputs(undefined);
    setRoleCreateSkillsDraft(null);
    setCreateSkillsSearchQ("");
    setCreateSkillsSearchLoading(false);
    setCreateSkillsSearchError(null);
    setCreateSkillsSearchResults([]);
    setCreateSkillVersionsById({});
    setCreateSkillVersionsLoadingById({});
    setCreateAgentInputsSelectedId("");
    queueMicrotask(() => roleCreateKeyRef.current?.focus());
  }, [resetRoleEdit]);

  const createSkills = Array.isArray(roleCreateSkillsDraft) ? roleCreateSkillsDraft : [];
  const setCreateSkills = useCallback((updater: (prev: RoleSkillItem[]) => RoleSkillItem[]) => {
    setRoleCreateSkillsDraft((prev) => {
      const base = Array.isArray(prev) ? prev : [];
      return updater(base);
    });
  }, []);

  const createAgentFilesManifest: AgentInputsManifestV1 = useMemo(() => {
    if (roleCreateAgentInputs && typeof roleCreateAgentInputs === "object")
      return roleCreateAgentInputs;
    return createEmptyManifest();
  }, [roleCreateAgentInputs]);

  const setCreateAgentFilesManifest = useCallback(
    (updater: (prev: AgentInputsManifestV1) => AgentInputsManifestV1) => {
      setRoleCreateAgentInputs((prev) => {
        const base =
          prev && typeof prev === "object" ? prev : createEmptyManifest();
        return updater(base);
      });
    },
    [],
  );

  const createAgentsMd = useMemo(
    () => getAgentsMdInlineText(createAgentFilesManifest)?.text ?? "",
    [createAgentFilesManifest],
  );

  const onChangeCreateAgentsMd = useCallback(
    (next: string) => {
      setRolePromptTemplate(next);
      setRoleCreateAgentInputs((prev) => {
        const base =
          prev && typeof prev === "object" ? prev : createEmptyManifest();
        const { manifest, id } = upsertAgentsMdInlineText({
          manifest: base,
          text: next,
          makeAgentInputId,
        });
        queueMicrotask(() => setCreateAgentInputsSelectedId(id));
        return manifest;
      });
    },
    [],
  );

  const editAgentsMd = useMemo(() => {
    const found = getAgentsMdInlineText(roleAgentInputs);
    return found?.text ?? roleEditPromptTemplate;
  }, [roleAgentInputs, roleEditPromptTemplate]);

  const onChangeEditAgentsMd = useCallback(
    (next: string) => {
      setRoleEditPromptTemplate(next);
      setRoleAgentInputs((prev) => {
        const { manifest, id } = upsertAgentsMdInlineText({
          manifest: prev,
          text: next,
          makeAgentInputId,
        });
        queueMicrotask(() => setRoleAgentInputsSelectedId(id));
        return manifest;
      });
    },
    [],
  );

  return (
    <section className="card" hidden={!active}>
      <div className="row spaceBetween" style={{ alignItems: "baseline", flexWrap: "wrap" }}>
        <div>
          <h2 style={{ marginTop: 0, marginBottom: 4 }}>角色模板</h2>
          <div className="muted">维护 Prompt / initScript / envText / 超时等配置。</div>
        </div>
        <div className="row gap" style={{ flexWrap: "wrap" }}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onStartCreate}
            disabled={!effectiveProjectId || rolesLoading}
          >
            新建
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => void refreshRoles()}
            disabled={!effectiveProjectId || rolesLoading}
          >
            刷新
          </Button>
        </div>
      </div>

      {!effectiveProjectId ? (
        <div className="muted" style={{ marginTop: 10 }}>
          请先创建/选择 Project
        </div>
      ) : rolesLoading ? (
        <div className="muted" style={{ marginTop: 10 }}>
          加载中…
        </div>
      ) : rolesError ? (
        <div className="muted" style={{ marginTop: 10 }} title={rolesError}>
          角色列表加载失败：{rolesError}
        </div>
      ) : (
        <div className="adminSplit" style={{ marginTop: 12 }}>
          <div className="rounded-lg border bg-card p-4">
            <div className="row spaceBetween" style={{ alignItems: "baseline", flexWrap: "wrap" }}>
              <div style={{ fontWeight: 800 }}>角色列表</div>
              <div className="muted">
                {filteredRoles.length ? `显示 ${filteredRoles.length} / ${roles.length}` : "—"}
              </div>
            </div>

            <label className="label" style={{ marginTop: 10 }}>
              搜索
              <Input
                value={roleSearch}
                onChange={(e) => setRoleSearch(e.target.value)}
                placeholder="按 key / 名称 / env keys 过滤…"
              />
            </label>

            <div className="tableScroll" style={{ marginTop: 12, maxHeight: 520 }}>
              {filteredRoles.length ? (
                <ul className="list" style={{ marginTop: 0 }}>
                  {filteredRoles.map((role) => {
                    const selected = roleEditingId === role.id;
                    const busy = roleSavingId === role.id || roleDeletingId === role.id;
                    return (
                      <li
                        key={role.id}
                        className={`listItem adminListItem ${selected ? "selected" : ""}`}
                      >
                        <div
                          className="adminListItemButton"
                          onClick={() => {
                            if (busy) return;
                            startRoleEdit(role);
                          }}
                          role="button"
                          tabIndex={busy ? -1 : 0}
                          aria-disabled={busy}
                          onKeyDown={(e) => {
                            if (busy) return;
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              startRoleEdit(role);
                            }
                          }}
                        >
                          <div
                            className="row spaceBetween"
                            style={{ gap: 10, alignItems: "center" }}
                          >
                            <div className="cellStack" style={{ minWidth: 0 }}>
                              <div style={{ fontWeight: 800 }}>{role.displayName ?? role.key}</div>
                              <div className="cellSub">
                                <code>{role.key}</code> · {role.initTimeoutSeconds}s ·{" "}
                                {new Date(role.updatedAt).toLocaleString()}
                              </div>
                              {role.description ? (
                                <div className="cellSub">{role.description}</div>
                              ) : null}
                              {role.envKeys?.length ? (
                                <div className="cellSub">env: {role.envKeys.join(", ")}</div>
                              ) : null}
                            </div>
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                resetRoleEdit();
                                copyRoleToCreate(role);
                              }}
                              disabled={busy}
                              title="复制为新角色"
                            >
                              复制
                            </Button>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="muted">暂无 RoleTemplate</div>
              )}
            </div>
          </div>

          <div className="rounded-lg border bg-card p-4">
            {editingRole ? (
              <div className="stack" style={{ gap: 16 }}>
                <form onSubmit={(e) => void onUpdateRole(e)} className="form">
                  <div
                    className="row spaceBetween"
                    style={{ alignItems: "baseline", flexWrap: "wrap" }}
                  >
                    <div>
                      <h3 style={{ marginTop: 0, marginBottom: 4 }}>编辑角色</h3>
                      <div className="muted">
                        key: <code>{editingRole.key}</code> · id: <code>{editingRole.id}</code>
                      </div>
                    </div>
                    <div
                      className="row gap"
                      style={{ justifyContent: "flex-end", flexWrap: "wrap" }}
                    >
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={copyEditingRoleToCreate}
                        disabled={
                          roleSavingId === editingRole.id || roleDeletingId === editingRole.id
                        }
                      >
                        复制为新角色
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        onClick={() => void onDeleteRole(editingRole)}
                        disabled={
                          roleSavingId === editingRole.id || roleDeletingId === editingRole.id
                        }
                      >
                        {roleDeletingId === editingRole.id ? "删除中…" : "删除"}
                      </Button>
                    </div>
                  </div>

                  <RoleTemplateManageForm
                    mode="edit"
                    roleKey={editingRole.key}
                    roleKeyReadOnly
                    displayName={roleEditDisplayName}
                    onDisplayNameChange={setRoleEditDisplayName}
                    description={roleEditDescription}
                    onDescriptionChange={setRoleEditDescription}
                    promptTemplate={roleEditPromptTemplate}
                    onPromptTemplateChange={setRoleEditPromptTemplate}
                    agentsMdText={editAgentsMd}
                    onAgentsMdTextChange={onChangeEditAgentsMd}
                    initScript={roleEditInitScript}
                    onInitScriptChange={setRoleEditInitScript}
                    initTimeoutSeconds={roleEditInitTimeoutSeconds}
                    onInitTimeoutSecondsChange={setRoleEditInitTimeoutSeconds}
                    envText={roleEditEnvText}
                    onEnvTextChange={setRoleEditEnvText}
                    envTextEnabled={roleEditEnvTextEnabled}
                    onEnvTextEnabledChange={setRoleEditEnvTextEnabled}
                    envKeysHint={editingRole.envKeys ?? null}
                    submitLabel="保存修改"
                    submitBusy={roleSavingId === editingRole.id}
                    submitDisabled={roleSavingId === editingRole.id || roleDeletingId === editingRole.id}
                    onCancel={resetRoleEdit}
                  />
                </form>

                <RoleSkillsCard
                  title="Skills"
                  subtitle="该角色运行时允许加载的 skills 集合（一期仅配置；后续实现挂载）。"
                  loading={roleSkillsLoading}
                  loadError={roleSkillsError}
                  saving={roleSkillsSaving}
                  onSave={() => void onSaveRoleSkills()}
                  skills={roleSkills}
                  setSkills={(updater) => setRoleSkills((prev) => updater(prev))}
                  searchQ={roleSkillsSearchQ}
                  onSearchQChange={setRoleSkillsSearchQ}
                  searchLoading={roleSkillsSearchLoading}
                  searchError={roleSkillsSearchError}
                  searchResults={roleSkillsSearchResults}
                  onSearch={() => void onRoleSkillsSearch()}
                  onAddSkill={addRoleSkill}
                  onRemoveSkill={removeRoleSkill}
                  versionsById={roleSkillVersionsById}
                  versionsLoadingById={roleSkillVersionsLoadingById}
                  ensureVersions={(skillId) => void ensureRoleSkillVersions(skillId)}
                />

                <RoleAgentFilesCard
                  title="Agent 文件"
                  subtitle="按 items 顺序执行，落到该 run 的 WORKSPACE / USER_HOME。"
                  manifest={roleAgentInputs}
                  setManifest={(updater) => setRoleAgentInputs((prev) => updater(prev))}
                  selectedId={roleAgentInputsSelectedId}
                  onSelectedIdChange={setRoleAgentInputsSelectedId}
                  onSave={() => void onSaveAgentInputs()}
                  saving={roleAgentInputsSaving}
                  error={roleAgentInputsError}
                  errorDetails={roleAgentInputsErrorDetails}
                  setError={setError}
                  agentInputsInlineFileRef={agentInputsInlineFileRef}
                  makeAgentInputId={makeAgentInputId}
                  normalizeItemForApply={normalizeItemForApply}
                />

              </div>
            ) : (
              <div className="stack" style={{ gap: 16 }}>
                <div>
                  <h3 style={{ marginTop: 0, marginBottom: 4 }}>创建 RoleTemplate</h3>
                  <div className="muted">建议先从现有角色“复制为新角色”。</div>
                </div>

                <form onSubmit={(e) => void onCreateRole(e)} className="form">
                  <RoleTemplateManageForm
                    mode="create"
                    roleKey={roleKey}
                    roleKeyInputRef={roleCreateKeyRef}
                    onRoleKeyChange={setRoleKey}
                    displayName={roleDisplayName}
                    onDisplayNameChange={setRoleDisplayName}
                    description={roleDescription}
                    onDescriptionChange={setRoleDescription}
                    promptTemplate={rolePromptTemplate}
                    onPromptTemplateChange={setRolePromptTemplate}
                    agentsMdText={createAgentsMd}
                    onAgentsMdTextChange={onChangeCreateAgentsMd}
                    initScript={roleInitScript}
                    onInitScriptChange={setRoleInitScript}
                    initTimeoutSeconds={roleInitTimeoutSeconds}
                    onInitTimeoutSecondsChange={setRoleInitTimeoutSeconds}
                    envText={roleEnvText}
                    onEnvTextChange={setRoleEnvText}
                    submitLabel="创建"
                    submitDisabled={!roleKey.trim() || !roleDisplayName.trim() || !effectiveProjectId}
                    onCancel={onStartCreate}
                    onClear={onStartCreate}
                  >
                    <div className="stack" style={{ gap: 16 }}>
                      <RoleSkillsCard
                        title="Skills"
                        subtitle="创建后会在该角色上保存 skills 配置。"
                        skills={createSkills}
                        setSkills={setCreateSkills}
                        searchQ={createSkillsSearchQ}
                        onSearchQChange={setCreateSkillsSearchQ}
                        searchLoading={createSkillsSearchLoading}
                        searchError={createSkillsSearchError}
                        searchResults={createSkillsSearchResults}
                        onSearch={() => void onCreateRoleSkillsSearch()}
                        onAddSkill={addCreateRoleSkill}
                        onRemoveSkill={removeCreateRoleSkill}
                        versionsById={createSkillVersionsById}
                        versionsLoadingById={createSkillVersionsLoadingById}
                        ensureVersions={(skillId) => void ensureCreateRoleSkillVersions(skillId)}
                      />

                      <RoleAgentFilesCard
                        title="Agent 文件"
                        subtitle="按 items 顺序执行，落到该 run 的 WORKSPACE / USER_HOME。"
                        statusHint={
                          roleCreateAgentInputs === undefined
                            ? "未配置：创建时不会携带该字段。"
                            : roleCreateAgentInputs === null
                              ? "未配置：当前值为 null。"
                              : undefined
                        }
                        manifest={createAgentFilesManifest}
                        setManifest={setCreateAgentFilesManifest}
                        selectedId={createAgentInputsSelectedId}
                        onSelectedIdChange={setCreateAgentInputsSelectedId}
                        setError={setError}
                        agentInputsInlineFileRef={agentInputsInlineFileRef}
                        makeAgentInputId={makeAgentInputId}
                        normalizeItemForApply={normalizeItemForApply}
                      />
                    </div>
                  </RoleTemplateManageForm>
                </form>

                <div className="muted" style={{ marginTop: 2 }}>
                  复制为新角色：仅需填写新的 <code>Role Key</code>，其余字段将沿用；已加载的 Skills /
                  Agent 文件配置也会一并复制。
                </div>

              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
