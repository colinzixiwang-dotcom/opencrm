# PostgreSQL 建库与领域迁移计划

状态：供评审的实施计划；未执行 DDL、数据导入或服务切换。

## 依据与只读核验

- 目标设计：[Morpho RMA CRM](https://zuvi.sg.larksuite.com/docx/VAdIduVsioO8m7xGpE1ljIUogwd)，2026-10-16 读取 revision 443，第 2、4、5、6.1、8、9、10、11 章及附录 A/B/C。
- 目标实例：`192.168.1.84:5432/morpho_rma_crm`；应用角色 `morpho_app`。凭据通过部署秘密配置提供，本文件及 Git 不保存密码。
- 实测 PostgreSQL 16.13，当前连接 TLS 已启用；只有 `public` schema，没有业务表。
- 当前角色可以 CONNECT、CREATE SCHEMA；不是 superuser，不能 CREATE ROLE/DB，没有 BYPASSRLS。本次未更改权限。
- 当前仍运行 SQLite；前后端在 `192.168.1.61:5176` / `:4317` 健康。

代码依据：`backend/internal/store/store.go`、`backend/internal/support/{support,warranty}.go`、`backend/internal/tickets/{models,service,accounts}.go`、`backend/internal/ruoyi/{models,permission}.go`。

## 当前结构与迁移必要性

| 当前事实 | 对实施的影响 |
|---|---|
| `app_state` 单行 JSON 保存 RMA、任务、配置、商品、订单、SN、权益和 ERP 数据 | 拆为上下文专属表；不能把单行 JSON 换成 JSONB 后就宣布 DDD 迁移完成 |
| `Store.Apply` 读取/写回整个状态，`sync.Mutex` 串行化写入 | 使用数据库行锁、唯一约束、条件更新；进程锁不能保护多个实例 |
| SQLite WAL、PRAGMA、连接池大小 1、启动时自动迁移/seed | PostgreSQL 单独连接配置与版本化 SQL migration；运行服务不执行隐式 DDL/重置数据 |
| Udesk 已有 tickets、metadata、mappings、snapshots、drafts、links、reply_pages、runs | 按 Support Access / RMA / Integration / Access 所有权重新归位 |
| 账号在 `sys_user` 和 JSON users 内重复维护；账号同步直接读写 app_state | Access 成为账号唯一写入方；Support Access 经 Port 申请账号和维护外部映射 |
| 列表每次完整请求 Udesk 再排序 | 迁入可索引的工单投影，后台同步；改用本地列表读取作为独立功能提交 |
| 当前审批是管理员在 CRM 内处理 | 迁移保留 LOCAL 来源；不得把旧结果冒充 Lark 审批 |

盘点快照：SQLite 约 14.4 MB；8 用户、5 角色、57 菜单、136 角色菜单关系；823 条本地 ticket 缓存、5 映射、2 Intake 草稿、2 快照、26 回复页、182 同步运行；当前无正式 RMA、任务、SN、supportOrders、benefitHistory。缓存行数不代表当前 Udesk 实际可见工单数，也不应作为同步完整性指标。

原有 ERP 还有销售、采购、库存等集合。隐藏导航不会删除这些数据；保留原始备份和兼容读取，避免把无关 ERP 功能混入售后领域。

## ADR-001：严格采用设计文档的 10 个 schema

继续模块化单体、单 PostgreSQL 数据库。schema 管理数据所有权，Go package/Repository/Port 管理代码访问边界；schema 本身不自动保证 DDD。

| Schema / 上下文 | 第一批表或能力 | 聚合与数据所有权 / 非职责 |
|---|---|---|
| `access_control` / Access | `principal`, `login_identity`, `credential`, `session`, `role`, `permission`, `role_permission`, `principal_role`, `scope_grant`, `ui_menu` | Principal 与授权；保留现有 RBAC permission codes；不拥有 Udesk Ticket 内容 |
| `support_access` / Support Access | `ticket_projection`, `ticket_message_projection`, `ticket_snapshot`, `ticket_field_definition`, `ticket_filter`, `ticket_filter_membership`, `agent_identity`, `agent_group`, `agent_group_member`, `principal_agent_mapping` | 外部工单引用、可查询只读投影、客服身份；不拥有 RMA 草稿/生命周期，不允许本地修改 Udesk 状态 |
| `rma` / RMA Case | `rma_intake`, `intake_reference`, `rma_case`, `rma_revision`, `rma_number_counter`, `case_reference`, `order_snapshot`, `solution_plan`, `case_note`, `customer_status_projection`, `customer_status_policy`, `attachment` | Intake 独立聚合，可未提交/失败/过期；正式 RMA 独立聚合，创建即 IN_PROGRESS；客户安全投影归此上下文 |
| `device` / Device & SN | `product_reference`, `device_profile`, `component`, `sn_binding`, `device_snapshot`, `data_conflict` | SKU/设备引用、整机与组件事实、MES 事实/绑定历史；不计算资格/质保结论 |
| `warranty` / Warranty | `warranty_policy`, `warranty_policy_version`, `warranty_rule`, `warranty_assessment`, `warranty_lineage`, `pause_interval`, `warranty_override` | 版本化政策、计算与证据；修正追加，不覆盖外部事实 |
| `solution` / Solution Policy | `solution_definition`, `solution_policy_version`, `eligibility_rule`, `task_template`, `task_template_node`, `task_template_dependency`, `eligibility_assessment`, `field_definition`, `root_cause_definition` | 可选择方案、资格/阶段/市场约束和模板；不拥有执行中的 Task，也不裁定审批结果 |
| `approval` / Approval | `approval_policy`, `approval_policy_version`, `approval_requirement`, `approval_task`, `approval_snapshot`, `approval_decision`, `approval_evidence` | 审批规则/保护字段、请求与结果；只有此上下文接受并裁定回调，不执行履约 |
| `fulfillment` / Fulfillment Orchestration | `task_plan`, `fulfillment_task`, `task_dependency`, `task_revision`, `dispatch_attempt`, `manual_completion_evidence`, `shipment`, `tracking_event`, `refund_action`, `benefit_delivery`, `task_event`, `sla_policy`, `sla_timer` | 运行时 DAG、任务门禁/执行、人工完成证据；消费审批结果，不能修改审批决定 |
| `integration` / Integration Gateway | `connection`, `external_reference`, `raw_payload`, `sync_checkpoint`, `sync_run`, `integration_job`, `integration_attempt`, `inbox_message`, `idempotency_receipt`, `interface_log`, `exception_item`, `migration_run`, `legacy_workspace_archive` | Connector/ACL/Adapter、同步/投递、幂等/外部引用；不承载整个业务状态机 |
| `audit` / Audit | `audit_entry`，按月分区 | 追加审计；普通应用只能 INSERT/SELECT；不拿审计日志替代领域实体 |

以上表名是实施建议；10 schema 与上下文职责来自设计文档。不是要求第一批建完所有未来表：先建当前功能必需表，未来表随能力通过 migration 添加。

### 所有权需要明确的几个交界

- `rma.solution_plan` 保存某个 RMA 选定方案的不可变业务快照；`solution.*` 保存可配置政策/模板；`fulfillment.task_plan` 保存实例化的执行图。三者通过版本与引用关联，各自只由所属模块写入。
- 工单创建的现有 `drafts` 迁入 `rma.rma_intake`，不继续放在 Udesk 模块内。一张 Ticket 可以关联多个 Intake/RMA；一个 Intake 至多生成一个 RMA。
- `support_access.principal_agent_mapping` 保存 CRM Principal ID 与源客服身份；CRM 是否可登录、授予何种角色由 Access 决定。源角色不能直接当成 CRM 授权。
- 当前商品表的设备/零件信息先经 `device.product_reference` 提供售后所需最小引用；完整销售目录不是本设计已定义的新上下文。原库存/采购/销售继续由兼容模块保存，不塞进 Device。
- Shopify 原始订单响应由 Integration 保存；RMA 使用经翻译的订单引用/时间戳快照。当前人工 `supportOrders` 标记 `source=MANUAL`，不能升级为已验证 Shopify 事实。
- 自定义字段定义按所属业务上下文保存；Udesk 字段属于 Support Access。RMA 与任务字段分开持久化，UI 可以统一展示。
- 附件文件使用对象存储；`rma.attachment` 管理 CRM 上传/业务证据引用，Udesk 外部附件引用属于 Support Access。禁止保存过期签名 URL 作为永久身份。

## ADR-002：跨上下文协作与事务

- 同一上下文内通过 Repository 写入，可使用 FK、唯一约束、检查约束。
- 跨上下文通过应用层 Port 传递领域事实/快照；异步使用带 `schema_version` 的事件。外部 DTO 由 ACL 翻译后才能进入业务服务。
- 默认不使用跨 schema 级联删除/更新和触发器执行业务。跨上下文 ID 是逻辑引用，完整性由 Port 校验、受控事务与对账保障；如需跨 schema FK，必须另有 ADR，不能默认加入。
- 读页面通过专属查询服务/读投影组合，不能让写模型随意跨模块 JOIN 改表。
- 文档 INV-02 明确允许创建 RMA 的跨上下文单库原子事务。由提交应用服务注入同一个 UnitOfWork，各模块经自己的 Port/Repository 在同一事务中写入；RMA Repository 不直接操作 fulfillment/approval 表。
- 外部网络请求全部在事务外。事务中只检验已取得的快照、版本、规则和权限。

### 提交事务

1. 事务外完成必要的 Udesk/Shopify/MES 查询和资格计算，记录证据来源、抓取时间、输入 hash、Intake revision、政策版本。
2. 开事务，锁定 Intake；确认未消费且输入版本一致。按统一锁顺序保护所需政策版本，禁止“评估旧数据、提交新输入”。
3. 经 Warranty/Solution Port 校验评估与当前允许的政策版本一致；不一致返回重新评估。
4. 同一事务 UPSERT `rma_number_counter(prefix, business_date)`；按 UTC 切日生成 AS/MC 编号。正式 RMA 创建为 IN_PROGRESS，编号不回收。
5. 写入 Case、选定 SolutionPlan 快照、TaskPlan/Tasks/Dependencies、ApprovalRequirement/保护字段快照；此时不创建外部 Lark 实例。
6. 消费 Intake，记录审计、Outbox、幂等成功结果，一起 COMMIT。
7. Worker 后续经 Port 推进审批/执行。任一步失败，业务创建全部回滚。

同一 Intake 并发提交必须返回同一个成功结果或明确冲突；相同 Idempotency-Key 和请求 hash 返回原结果，不同 hash 返回 409。

文档内部存在文字不一致：第 8.3 SQL 示意提到 SUBMITTED，但第 10.2 Intake 状态机使用 EVALUATING。实施以第 10 章为准，用 EVALUATING/CONSUMED 与版本一致性保护，不额外引入 SUBMITTED。已有状态/审批规则另有差异，迁移清单必须显式列出，不能借搬库静默改业务。

## ADR-003：物理模型、约束和并发

- CRM 新实体使用 UUID；外部 ID 使用 text（不能用 Udesk 工单号当主键）。保留 `legacy_id` 映射，现有链接/API ID 可通过适配层继续解析。
- 所有可租户化业务表显式 `tenant_id`；集成数据另有 `connection_id`。当前 tickets.Tenant 是源 URL，应映射为 connection，不能直接当作 CRM 租户 ID。
- 时间点用 `timestamptz`；签收/激活等日历日期用 `date`；政策记录计算时区。UTC 编号日期与质保业务日期分开。
- 金额用整数最小货币单位 + currency，不使用浮点；数量设置正整数约束。
- 聚合有 `version bigint`；更新使用 `WHERE id=? AND version=?` 并递增；0 行为并发冲突。If-Match 和内部 version 对应。
- `task_version` 是审批/执行保护的业务版本；`row_version` 是记录并发版本。普通状态流转不应自动生成新的审批业务版本。
- 业务状态用显式允许值约束；状态转换合法性、DAG 无环、资格评估等由领域服务保证，不能只靠 CHECK。
- 经常查询的字段单独列；JSONB 只用于原始响应、不可变证据/政策快照和灵活自定义字段。原始响应必须保留 provider/version/时间和 hash。

关键约束（所有租户局部唯一约束包含 tenant_id）：

| 对象 | 约束 |
|---|---|
| RMA | RMA No. 唯一（当前租户内）；Intake consumed_rma_id 与 Case intake_id 一对一；RMA 有版本 |
| 编号计数器 | `(tenant_id, prefix, business_date)` 唯一，事务 UPSERT |
| Ticket | `(tenant_id, connection_id, external_id)` 唯一；Ticket number 只是连接范围查询键 |
| 外部身份 | `(tenant_id, connection_id, agent_id)` 唯一；每连接的 Principal 映射约束明确，停用记录保留 |
| Task | 逻辑 Task ID 唯一；历史 `(tenant_id,rma_id,task_no,task_version)` 唯一；每个逻辑任务至多一个当前版本 |
| DispatchAttempt | `(tenant_id,task_id,task_version,operation,attempt_no)` 唯一；同操作有效/未决结果受部分唯一索引保护 |
| ApprovalTask | 同 task/version/policy 只有一个有效审批；Lark instance ID 按文档全局唯一，空值允许多条 |
| IntegrationJob | 幂等键在明确的 tenant/connection/operation 命名空间内唯一，按文档可组合成全局 idempotency_key |
| Inbox | `(source_system,source_account,external_event_id)` 唯一；独立消费者另登记 `(consumer,event_id)` 去重 |
| Device | `(tenant_id,whole_unit_sn_normalized)` 唯一；normalization 规则版本化，迁移先报告冲突 |
| Attachment | object_key 唯一；外部附件另保留 provider reference，不据文件名去重 |

UNKNOWN dispatch 不能因为 lease 过期就允许再次外发；先查询原操作结果、对账或经人工确认。部分唯一索引的“有效/未决”状态需覆盖该业务事实；lease/fencing 只解决 Worker 并发，不能保证下游 exactly-once。

### 核心查询索引

- 工单默认：`(tenant_id, connection_id, last_replied_at DESC NULLS LAST, external_id DESC)`。
- 一线：上述范围加 `assignee_id`；主管：加 `group_id`；保存筛选器成员在 `(tenant_id,connection_id,filter_id,ticket_id)` 建唯一索引与反向查询索引。
- 缺失回复时间始终末尾，keyset cursor 必须处理 null 分段；时间并列用稳定外部 ID。游标绑定 filter/sort/scope/权限版本，不能跨用户复用。
- RMA：owner/status/created_at；Task：plan/status、依赖前驱；Job/Outbox：可领取状态 + next_attempt_at 的部分索引。
- 列表/计数统一使用同一授权条件；大规模计数可独立缓存，显示其版本/同步时刻。
- 中文邮件全文检索不默认假定 PostgreSQL 内置分词满足需求；先验证，必要时提供专门搜索投影。

## ADR-004：Outbox、Worker 与缓存

- Outbox 属于发出事件的上下文，先在需要发事件的 schema 建 `outbox_event`；统一 Worker 经注册 Port 领取，不任意读写所有业务表。Integration 拥有 transport Job/Attempt/Inbox。
- 原子领取使用 `FOR UPDATE SKIP LOCKED`、lease、fencing token；网络 I/O 在领取事务提交后执行；完成时校验 token。
- 本地业务变化 + Outbox 同事务。异步投递至少一次；消费者按 event_id 去重，不能宣称端到端 exactly-once。
- 事件包括 event_id、aggregate_id、occurred_at、schema_version、trace_id、actor；任务事件携带 task_version/approval reference。
- PostgreSQL 第一阶段承接持久任务队列；MQ/Redis 不是上线前置。未来 Relay 可替换投递通道，业务事件契约不变。
- 工单同步：首次后台回填 + 可用的增量来源 + 周期校准；同步 checkpoint 只在完整窗口成功后推进。Udesk 更新时间查询/事件能力必须先验证。
- 保存筛选器的语义由 Udesk 拥有，缓存成员关系并标注 freshness；不能猜测复制源规则。
- 数据库是列表查询基础，Redis 可后加用于 metadata/query ID/count 缓存、共享限流和请求合并；清空缓存不能丢业务数据。
- 权限版本在授予/撤销/停用时递增；读取数据库和缓存都执行数据范围校验。外部转单可见性的延迟由源变更检测能力决定，须有明确 freshness 契约。

## ADR-005：角色与审计

`morpho_app` 作为运行应用角色，不应同时拥有业务 schema/table。当前它能 CREATE SCHEMA，但没有 CREATE ROLE；正式所有权与角色配置需要由数据库管理员/部署 migration 身份完成。

建议 DBA 配置：独立 NOLOGIN owner、migration 身份、运行 app、Worker、只读运维角色。运行角色不授 DDL，schema 禁止 public CREATE；audit 只授 INSERT/SELECT，表和分区由 owner/migration 身份拥有。若用 app 本身作为 owner，单纯 REVOKE UPDATE/DELETE 不能形成有效不可变保证。

模块化单体共用连接时，schema 权限不能区分某次 Go 模块调用。第一阶段用代码依赖/Repository 约束 + 架构测试；需要数据库强制模块隔离时，独立角色/连接池与凭证访问隔离作为后续强化，不声称一个全权限 app 角色能完成全部模块隔离。

可采用 RLS 作为租户防线，但必须验证 app 非 owner/BYPASSRLS、事务级 `SET LOCAL` 与连接池复用；RLS 不替代字段脱敏和客服/组级权限。

audit 按月分区，常规 >=2 年、财务 >=5 年。PostgreSQL 分区父表唯一约束必须包含分区键；审计全局事件去重不能靠不含分区键的父表唯一索引，应由独立去重登记或业务事务幂等保证。分区预创建与到期归档由受控维护任务执行。

## 现有数据迁移映射

| SQLite 来源 | PostgreSQL 去向与处理 |
|---|---|
| sys_user / JSON users | `access_control.principal/credential/login_identity`；核对重复来源、启停状态与哈希；不重置用户密码 |
| sys_role/menu/关联表 | Access 表与 ui_menu；保留 codes、角色自定义授予和禁用菜单 |
| sessions | 可选择迁移有效会话以降低切换影响，或明确安排重新登录；不保存明文 cookie |
| mappings | Support Access 身份映射 + Access scope grants；明确源组成员和 CRM 授权组是不同事实 |
| tickets/metadata/reply_pages | Support Access 投影、字段/筛选器、按 message ID 去重的沟通记录；保留 HTML 正文与原始响应引用 |
| snapshots/drafts/links | Ticket snapshot / RMA Intake / Case reference；保留当前草稿内容、owner、引用和历史 ID |
| runs | Integration sync_run；补齐 connection 和 actor 范围 |
| supportConfig.solutions/taskTypes | Solution 政策/模板版本；执行行为快照迁入 Fulfillment |
| supportConfig.rules | Approval 政策版本；保留现有语义，目标规则另行激活 |
| supportConfig.warrantyPolicy | Warranty policy/version/rules |
| products/serials | Device 最小商品引用与 SN；库存销售资料原样保留兼容模块 |
| supportOrders | RMA 手工订单引用/快照，明确人工来源 |
| rmas/rmaTasks | RMA / Fulfillment / Approval / Warranty immutable evidence，按显式状态映射导入 |
| benefitHistory | Fulfillment benefit_delivery，保留手动执行证据 |
| JSON audit | audit_entry，标记 legacy 来源，迁移不补造不存在的历史 |
| 其余 ERP JSON 集合 | 原始 SQLite 备份 + `integration.legacy_workspace_archive` 只读归档；仍启用的 ERP 兼容模块单独维护临时状态，售后上下文不得读写全局 app_state |

目标规则差异：文档 Phase 1 仅 Lark Login，但用户已要求保留密码/演示登录；本次数据库迁移保留现状，Lark 接入独立 feature。文档礼品卡/折扣码要求审批，现有礼品卡为 >$100 规则；文档退货换新等为 Phase 2，现有配置可用。迁移必须保留 legacy policy version 并报告差异；按设计激活新政策/Phase flags 单独提交，不能迁移时静默关闭功能或重写既有审批。数据库保留来源/phase/version，支持之后受控切换。

## 实施顺序与独立提交

| 阶段 / feature commit | 工作 | 完成标准 |
|---|---|---|
| 0. 领域/DDL 设计定稿 | 本计划、表字典、ERD、ownership/Port 契约、唯一约束/状态差异清单 | 每张表有唯一 owner；阶段范围和存量兼容规则明确 |
| 1. PostgreSQL 基础 | driver/config、连接池、10 schemas、migration ledger、受控初始化、角色 grants/SSL 配置 | 空库可部署；迁移锁阻止重复并发；应用启动不隐式改 schema |
| 2. Access + Integration 基础 | Principal/RBAC、会话策略、连接配置、幂等、审计、Outbox/Job/Inbox、legacy archive | 现有账号/权限不变；账号同步经 Port；权限和审计可验证 |
| 3. Support Access | Ticket/Messages/字段/筛选器投影、身份映射、同步 checkpoint；保留草稿引用 | 读取/详情/导出/附件范围一致；原始 HTML 不丢，自定义字段完整 |
| 4. Policy + Device + Warranty | 配置拆表与版本快照，商品/SN 引用、计算 Port；手工订单来源区分 | 现有质保边界测试通过；历史结论可重现；不伪造外部证据 |
| 5. Intake / RMA / Fulfillment / Approval | 规范化聚合、提交 UnitOfWork、任务 DAG、审批/证据、版本锁 | INV-01/02/04/08 原子性/并发/幂等测试通过，旧接口可兼容 |
| 6. 本地列表 + 同步/缓存 | PostgreSQL 全局查询/分页、后台 Udesk 刷新、freshness UI、配置 TTL、请求合并 | 翻页不再全量读源；筛选与权限准确；同步失败清晰，缓存可重建 |
| 7. 迁移演练与切换 | 导入 dry-run、差异报告、停写/最终导入/校验/切流 | 备份可恢复；业务/权限校验通过；两端服务恢复并保持可用 |

阶段 1–5 在隔离迁移/测试环境构建，在线 SQLite 继续服务；不让用户长期使用未完整迁移的混合售后写路径。跨阶段若临时保存兼容 state，必须有删除条件，不能让它成为最终模型。

实现路径建议保留 Go/Gin/GORM，拆出 `internal/accesscontrol`, `supportaccess`, `rma`, `device`, `warranty`, `solution`, `approval`, `fulfillment`, `integration`, `audit`；不因搬库重写前端。API compatibility adapters 保留已有页面与操作，逐步减少 bootstrap 全量加载。

## 导入、切换与回退

- 初次演练读取 SQLite 一致性备份（在线 SQLite backup API 或受控停写备份），不能只复制正在写入的主文件忽略 WAL。
- 使用 migration_run/import_batch/source hash 与 legacy ID 映射，导入可重跑。先检测账号冲突、SN 归一化冲突、孤立引用、JSON 字段类型/时间格式，再写入。
- 配置和核心业务表按父子依赖导入；账户/配置/草稿/快照逐项对账。零正式 RMA 是本次盘点事实，不允许脚本默认永远为空。
- Udesk 缓存做结构/权限和去重校验，不能只与源 total_count 比较；首轮后台校准后标记同步完整度。
- 演练与生产使用不同数据库或隔离测试实例；不能在目标数据库里创建测试账号、测试 RMA 后当成生产数据。
- 切换窗口短暂停写，备份、最终导入、核验、更新运行配置，恢复 API/前端。单一写入方；避免无补偿的 SQLite/PostgreSQL 双写。
- 切换前失败可继续旧服务。切换后 PostgreSQL 有新写入时，不能直接指回旧 SQLite：需停写、保存 PG 数据，并使用已验证反向导出/补偿迁移，或前向修复。
- 数据库密码仅通过环境/Secret Manager 注入；TLS 正式使用可校验 CA/主机名的 verify-full（需数据库证书条件支持）。本次只证实 TLS 加密，不代表证书身份已完成验证。
- 备份与 PITR/恢复演练、RPO/RTO 需在上线前落实。代码 migration down 不能替代数据恢复计划。

## 验收与可观测性

1. 所有权限测试在真实 PostgreSQL 上运行，包含普通客服/授权组/管理员、停用用户、导出、lookup、附件、缓存失效。
2. 两个独立后端并发提交同一 Intake、并发编号、同幂等键不同 payload、stale If-Match，验证数据库约束而不是进程 mutex。
3. 注入创建中途失败：不留下 RMA/Tasks/Counter/Audit/Outbox 的部分业务提交；失败 Intake 保持可修改，符合状态机。
4. 政策更新后历史快照不变化；保护字段修改使旧审批/未执行 Task 失效；迟到回调只审计。
5. 多 Worker lease/fencing、重复事件、UNKNOWN 外部动作、任务崩溃恢复；确认没有“超时即盲重发”。
6. 邮件表格/引用折叠、消息顺序、自定义字段、附件预览和双语 UI 回归。
7. 大量模拟工单数据在隔离测试库验证索引/EXPLAIN、游标、空时间/同时间、授权组与筛选器计数；不承诺未经压测的毫秒数。
8. 指标：DB query latency/连接池/锁等待、同步 lag、Udesk 429、待办年龄、失败/死信、缓存命中率、projection lag；日志使用 trace_id，不记录秘密和完整敏感响应。
9. 每个实现 feature 独立 commit；每次交付代码后重启两端并验证 `192.168.1.61` 上可用。

## 本次评审结果

推荐下一步产物：第一批 schema-qualified DDL、ERD、版本 migration 文件、SQLite 导入 dry-run 工具和数据差异报告。依照设计建设 10 schema 与模块边界；在可复现的业务/权限验证后切换 PostgreSQL，然后启用本地工单索引/后台同步。Lark、自动履约、Phase 2 能力独立推进，不与数据库迁移混成一次不可审查的大改。
