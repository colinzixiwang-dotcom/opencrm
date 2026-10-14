# Third-party notices

## RuoYi-Go permission components

- Project: [lostvip-com/ruoyi-go](https://github.com/lostvip-com/ruoyi-go), a community Go port of RuoYi.
- Reviewed and downloaded revision: `fb2af8b8e8375267f723d29f8607b3f5ae6db800`.
- License: MIT, copyright (c) 2020 lostvip.com. Full license is retained at [backend/third_party/ruoyi-go/LICENSE](backend/third_party/ruoyi-go/LICENSE).
- Upstream references: `modules/system/model/SysUser.go`, `SysRole.go`, `SysMenu.go`; `modules/system/service/PermissionService.go`; `modules/common/middleware/auth/permit_check.go`.
- Adapted into `backend/internal/ruoyi/models.go` and `permission.go`.

The adaptation preserves user/role/menu entities, role keys, page/button menu types, enabled/disabled flags, role-menu and user-role relationships, and menu permission-string evaluation. Changes include explicit injected GORM handles, string user IDs compatible with Harbor, omission of password fields from JSON, SQLite initialization, per-request grant calculation, role union, server-side enforcement, and custom Harbor action mappings. Harbor uses its own persistent sessions, HTTP routes, and business logic. It does not import the full RuoYi-Go framework, Redis/JWT stack, templates, or UI. The React interface and Harbor styling are independent of RuoYi's UI.

Other npm and Go dependencies retain their own licenses in installed packages/module caches; their pinned versions are recorded in `package-lock.json` and `backend/go.sum`.
