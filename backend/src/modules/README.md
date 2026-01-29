# backend/src/modules

这里存放按“业务域/能力”组织的后端实现代码（例如 `scm`、`workflow`、`pm`）。

约定：
- 迁移期 `backend/src/services/**` 仅作为兼容层（re-export）。
- 新代码优先从 `modules/<domain>` 导入，避免跨域随意引用。
- 避免循环依赖；需要跨域时优先抽成更底层的 `utils/` 或通过接口（ports）解耦。
