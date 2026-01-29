export const ADMIN_SECTION_KEYS = [
  "acpSessions",
  "approvals",
  "settings",
  "policy",
  "textTemplates",
  "projects",
  "issues",
  "roles",
  "archive",
] as const;

export type AdminSectionKey = (typeof ADMIN_SECTION_KEYS)[number];

export const ADMIN_SECTION_META: Record<AdminSectionKey, { title: string; desc: string }> = {
  approvals: { title: "审批队列", desc: "Pending approvals / 需要人工确认的动作" },
  settings: { title: "平台设置", desc: "影响看板展示与全局行为" },
  policy: { title: "策略（Policy）", desc: "Project 级：自动化开关 / 审批门禁 / 敏感目录（JSON）" },
  textTemplates: { title: "文本模板", desc: "平台模板 / Project 覆盖（Handlebars）" },
  projects: { title: "项目管理", desc: "创建/配置 Project（仓库、SCM、认证方式等）" },
  issues: { title: "Issue 管理", desc: "创建需求或导入外部 Issue" },
  roles: { title: "角色模板", desc: "创建/维护 RoleTemplate（Prompt / initScript 等）" },
  archive: { title: "Issue 归档", desc: "管理已完成/失败/取消的 Issue 归档状态" },
  acpSessions: {
    title: "ACP Proxies / Sessions",
    desc: "查看 acp-proxy 注册状态与实例存活，并可管理 ACP session / 启动独立交互 Session",
  },
};

export function getSectionFromSearch(search: string): AdminSectionKey | null {
  const raw = new URLSearchParams(search).get("section");
  if (!raw) return null;
  return (ADMIN_SECTION_KEYS as readonly string[]).includes(raw) ? (raw as AdminSectionKey) : null;
}
