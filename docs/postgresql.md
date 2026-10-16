# 当前 PostgreSQL 存储与迁移

2026-10-16 已将现有工作区切换至 `192.168.1.84:5432/morpho_rma_crm`，PostgreSQL 16.13。运行程序和常规测试只使用 PostgreSQL；Go SQLite 驱动已移除。旧 SQLite 文件只保留为一次性迁移源和备份。

按用户最新要求，范围是现有工单、设置/配置、身份权限以及已有业务。设计文档作为 DDD 指引；未预建 Lark 审批、MES、自动履约、未来状态机或全部目标表，也未改变现有审批/质保/登录规则。

## 当前上下文

| Schema | 当前所有权 |
|---|---|
| `access_control` | 用户、密码哈希、角色、菜单权限、角色关联、会话；唯一权威身份来源 |
| `support_access` | Udesk 工单、元数据、自定义字段定义、身份映射、不可变工单快照、回复页缓存 |
| `configuration` | 工作区设置、现有方案/任务类型/根因/自定义字段/审批与质保配置；按配置项拆分文档，保留现有 revision |
| `rma` | 工单创建的 Intake 草稿/关联、正式 RMA、现有任务、手工支持订单、权益记录 |
| `catalog` | 当前 SKU 和 SN 记录 |
| `operations` | 当前已有 ERP 记录，包括被隐藏导航的业务与旧本地工单历史 |
| `integration` | 同步运行、请求幂等回执、迁移版本、工作区标量元数据 |
| `audit` | 追加式业务审计 |

8 个 schema 对应当前代码职责，未来边界随功能发展可调整。Configuration 目前统一服务版本化配置；RMA 内的任务/审批状态保持现状，待履约/审批能力独立演进时再提取，不制造空模块。

`internal/persistence` 提供 PostgreSQL 连接、受控命名、当前集合所有权和兼容仓储；`ruoyi.Service` 负责身份/授权写入，`tickets.Service` 负责源工单与映射。账号同步直接写权威身份关系并通过审计追加接口记录操作，不再读写全局业务 JSON。

业务集合按记录 ID 保存为独立 JSONB 聚合行，自定义字段、历史快照、任务事件和原始内容不丢失。现有领域规则保持 Go 实现，API 兼容层组装原有结构；不会继续保存整个 workspace 的单行 `app_state`。对缺少 ID 的原有 ERP 行保留位置键作为兼容身份，不把这个规则推广为新聚合设计。

## 配置和启动

应用从项目根目录 `.env` 读取缺失环境变量，进程环境优先。优先使用非空 `DATABASE_URL`；否则使用 PG*。密码不会进入前端或日志。

```dotenv
PGHOST=192.168.1.84
PGPORT=5432
PGDATABASE=morpho_rma_crm
PGUSER=morpho_app
PGPASSWORD=<deployment secret>
PGSSLMODE=prefer
DATABASE_URL=
HOST=192.168.1.61
PORT=4317
```

`PGSSLMODE` 保留部署配置。实际连接已确认 TLS；`prefer` 不等于证书身份验证，如部署需要 verify-full，应提供匹配的 CA/证书。不要提交实际凭证。

```sh
./scripts/go.sh build -o ../.bin/harbor-db ./cmd/db
./.bin/harbor-db -action migrate
./.bin/harbor-db -action verify
./start.sh
```

migrate 使用事务/advisory lock 和 schema_migrations 版本登记。现有 ORM 表只在 migration v1 内建模，不在每次启动重新 AutoMigrate；每次启动校验迁移版本。未来新增表/列必须添加后续 migration，不能只修改 v1 后期待现有库自动变化。

空正式库不会偷偷 seed 示例数据；启动会要求先导入现有工作区。没有 PG 配置或 PG 不可用会报错，不自动切回本地数据库。健康检查实际探测 PG，失败返回 503。

## 一次性迁移

实际迁移保留了：8 用户、5 角色、57 菜单、8 用户角色关系、136 角色菜单关系、5 Udesk 映射、2 草稿、2 快照、26 回复页、823 本地工单缓存行、7 元数据记录、188 同步运行，以及所有原业务集合、政策和设置。缓存行数不等于源当前实际可见工单数；现场实时读取为 681 张去重工单。

最终导入前停写，完整旧库备份在 ignored `data/pre-postgres-migration.sqlite`。一次性导出在 ignored `.bin/pg-final-import.json`（含认证资料，按 0600 创建，不应分发）。

```sh
python3 scripts/export-legacy-sqlite.py data/harbor.sqlite .bin/legacy-export.json
./.bin/harbor-db -action import -file .bin/legacy-export.json
```

Python 仅在明确运行迁移导出时使用标准库 SQLite，以只读事务取得一致源快照。应用程序不调用它。

导入全部在一个 PG 事务内完成，恢复 ID 序列，拒绝覆盖已初始化工作区。保留用户密码哈希/启停状态、定制角色/菜单、已有会话、草稿 owner 与源快照。身份从关系表生成兼容投影，不维护第二份密码副本。

正式切换后的业务数据/设置/政策和密码哈希已逐项与最终源快照核对。切换后不能直接恢复旧 SQLite 作为运行库：它不会包含 PG 上的新写入。

## 并发与未来扩展

现有 map-based 业务命令使用 PG 事务 advisory lock，保护跨实例的资格判断、业务更新与幂等登记。它替代进程 mutex，保证当前语义；并不声称已支持任意规模的并行业务写入。工单读取/源记录持久化不经过这一兼容命令锁，网络请求不持有该锁。

仓储只更新变化的业务行，审计记录追加且同 ID 不覆盖，事务失败全部回滚。页面读取使用一致的只读快照。账号/授权以关系表为唯一来源，现有权限测试在 PG 上验证。

后续功能优先新增所属上下文的类型、Repository 和 migration；热点字段按真实筛选/排序需求提取成列并建索引。逐项替换兼容命令后可以缩小锁到具体聚合，而不重写整站/再次搬库。既有 Configuration 在规则生命周期稳定后可提取 Solution/Warranty；Task 和 Approval 也按实际能力再拆。

这次没有实现后台增量同步/Redis 缓存，Udesk 页面仍实时读取源接口，全局排序仍遵循此前完整读取的契约。数据库迁移不会消除上游请求和限流耗时；本地工单索引/同步属于下一项独立功能。

当前 audit 的追加限制由应用仓储保证。若需要抵御数据库应用 owner 直接执行 UPDATE/DELETE，需另行配置非 owner 运行角色与数据库权限；这次没有伪称已完成该隔离。

## 测试与恢复

Go/API/浏览器测试均使用配置的 PostgreSQL，以随机或临时 namespace 映射为 `test_<hash>_<context>` schema 集合。常规测试结束会 DROP 自己的测试 schema；destroy-test 命令拒绝删除正式 schema。测试不使用 SQLite，不在正式业务表创建测试账号/RMA。CI 采用独立 PostgreSQL 16 service。

- `npm test`：领域、权限、工单服务与前端单测。
- `npm run test:migration`：对当前旧源只读导出，导入隔离 PG schema，核对业务/配置/密码、登录与重启。
- `npm run test:browser`：现有 UI、RMA、设置、配置、质保、双语、代理登录、Udesk 与邮件展示。
- `./scripts/go.sh test -race ./...`：并发检查；跨实例幂等测试使用两个独立 Store，共同发起 16 个同键请求，只有一个持久结果。

备份使用 PostgreSQL 的 pg_dump/受控恢复；业务 JSON 下载不包含完整身份/会话/工单集成表，不能作为全库恢复。旧本地数据库文件不再是当前备份来源。PITR/定期备份由数据库部署负责。
