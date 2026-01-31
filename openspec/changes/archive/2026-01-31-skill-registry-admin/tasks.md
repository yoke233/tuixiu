## 1. 数据模型与迁移

- [x] 1.1 在 `backend/prisma/schema.prisma` 增加 `Skill` / `SkillVersion` / `RoleSkillBinding` 模型与必要索引/唯一约束
- [x] 1.2 生成 Prisma migration（`pnpm -C backend prisma:migrate`）并确认本地可启动
- [x] 1.3 为后端/前端补齐 DTO/类型（Skill 搜索项、版本信息、Role 绑定结构）

## 2. 后端 Admin APIs（Skill Registry & Search）

- [x] 2.1 新增 `backend/src/routes/skills.ts`：实现 `GET /api/admin/skills/search`（provider=registry，含 q/tags/limit/cursor 校验与稳定返回结构）
- [x] 2.2 实现 `GET /api/admin/skills/:skillId`（admin 权限、未登录 401/非 admin 403、NOT_FOUND/BAD_INPUT 业务错误封装等行为符合 specs）
- [x] 2.3 实现 `GET /api/admin/skills/:skillId/versions`（按 importedAt 倒序，空列表允许）
- [x] 2.4 在 `backend/src/index.ts` 注册 skills routes（挂载到 `/api/admin`）

## 3. 后端 Admin APIs（Role-Skill-Bindings）

- [x] 3.1 新增 role-skill-bindings routes：实现 `GET /api/admin/projects/:projectId/roles/:roleId/skills`
- [x] 3.2 实现 `PUT /api/admin/projects/:projectId/roles/:roleId/skills`（原子替换、skillId 存在性校验、pinned 版本一致性校验预留）
- [x] 3.3 确认删除 RoleTemplate 时绑定关系被级联删除（或在实现中补齐 onDelete 策略）

## 4. 前端 Admin Skills 分区（搜索/详情）

- [x] 4.1 在 `frontend/src/pages/admin/adminSections.ts` 增加 `skills` 分区元数据与导航分组
- [x] 4.2 新增 `frontend/src/api/skills.ts`：封装 `/admin/skills/search`、skill 详情与 versions 请求
- [x] 4.3 新增 `frontend/src/pages/admin/sections/SkillsSection.tsx`：实现搜索（q/tags/limit）+ 列表展示 + 详情查看（含版本列表）
- [x] 4.4 在 `frontend/src/pages/admin/AdminPage.tsx` 接入 `SkillsSection`，并保证路由 query（`?section=skills`）可直达

## 5. 前端 角色启用技能（配置 UI）

- [x] 5.1 在 `frontend/src/api/roles.ts` 或新增 `frontend/src/api/roleSkills.ts`：封装 role skills 读写接口
- [x] 5.2 在 `frontend/src/pages/admin/sections/RolesSection.tsx` 增加“启用 skills”编辑区域（从 registry 搜索/选择，并保存为原子替换）
- [x] 5.3 处理无 skills 场景：UI 清晰提示“暂无可用技能/请先导入”（不阻塞其它角色配置）

## 6. 测试与校验

- [x] 6.1 后端为 skills 搜索与 role skills 绑定增加基础测试（鉴权、空结果、NOT_FOUND/BAD_INPUT 业务错误封装、原子替换语义）
- [x] 6.2 前端为 SkillsSection 增加最小交互测试（渲染、搜索触发、空结果提示）
- [x] 6.3 跑通 `pnpm lint` / `pnpm typecheck` / `pnpm test`（至少覆盖相关 package）
