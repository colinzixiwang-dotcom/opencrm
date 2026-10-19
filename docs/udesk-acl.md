# CRM / Udesk 防腐层

实施日期：2026-10-19。适用于当前 Go 单体与 PostgreSQL，不新增服务或中间件。

## 上下文与契约所有权

| 上游 | 下游 / Owner | 集成方式 | 契约 / 职责 |
| --- | --- | --- | --- |
| Udesk | Integration 内的 Udesk adapter | ACL | 源 HTTP、签名、分页、字段与错误翻译 |
| Udesk adapter | Support Access | 消费者定义的 port | `supportsource.TicketReader`、`SyncSource`、`DirectoryReader` |
| 来源客服组目录 | Support Access 归属聚合 | 规范化引用 | 来源组 ID / 名称；Morpho 成员规则仍由本地配置决定 |
| 来源账号目录 | Access Control / 账号同步用例 | 明确映射 | 保留 CRM 角色映射及管理员覆盖；未知源角色不扩大权限 |
| Support Access | RMA | 来源引用与冻结证据 | provider / tenant / ID / number、创建时快照；RMA 保有自己的规则和事务 |
| 工单应用服务 | HTTP / React | CRM Published Language v2 | 规范化工单、动态字段、消息、附件和同步信息 |

消费侧契约位于 `backend/internal/supportsource`。Udesk 协议只由 `integrations/udesk` 处理，工单应用服务不 import Udesk client，也不拼接 Udesk API 路径。组合根仍可注入现有 Client；Client 实现 port 时委派给 Adapter，因此继续共享同一个节流预算。测试可以注入独立 adapter 或完整 port 替身。

`Ticket` 是外部信息的读模型，不是 CRM 工单聚合；不为同步数据虚构事务不变量。售后组归属配置继续是 Support Access 的聚合，RMA 草稿、提交、质保及方案规则保持原有事务边界。

## 翻译规则

- `reference` 包含 provider、tenant、外部 ID；number 是展示工单号。Udesk 跳转链接由 adapter 根据外部 ID 构造。
- 状态、渠道保留来源代码与标签，未知值原样保留，不推断成其他状态。
- 自定义字段统一为 key、label、kind、options 和 customValues；未识别字段保留，选项树统一为 label / children。系统附加字段作为 field values 返回，React 不识别 Udesk 原字段名。
- 回复输出为 messages，作者统一为 id / name / kind，内部备注统一为 internal。adapter 负责将源系统倒序分页翻译为全局正序分页。
- 附件统一为 reference、name、kind、size、origin、messageId。reference 不含临时签名参数；下载时在实时授权后的源记录中重新解析最新地址。
- 工单附件与回复附件保留各自归属；没有自动汇总或跨区域去重。卡片全部显示，只有预览弹窗分页。
- HTML 消毒、历史引用折叠、邮件表格和视觉呈现继续在前端 renderer 中完成，不由 ACL 生成 HTML 布局。
- 原始 evidence 仅用于持久化、兼容 presenter 与授权后的附件解析，不作为产品归属或用户权限的依据，不序列化进 v2。

## 数据流与权限

后台每分钟使用低优先级来源预算执行完整扫描，应用服务在同一个 PG 事务中发布新 generation。列表仍只查询 PG：归属 SQL 过滤后全局排序、分页。Udesk 筛选器仍由源系统定义，PG 保存完整结果 ID 集合，不自行推断复杂筛选器条件。

详情、回复、附件、工单号查询、RMA 创建和提交继续实时校验来源工单的最新客服组。附件解析复用当前请求已经取得的详情，避免在解析回复附件时再次读取同张详情。跨请求不缓存授权结果。所有活跃 CRM 用户共享配置的 Morpho 范围，账号映射不再决定工单可见范围。

非管理员联系方式脱敏、回复作者邮箱移除、个人 RMA 链接范围仍由应用服务处理。v1 / v2 都从同一个策略处理后的结果呈现，不存在额外旁路。

Gin middleware 保留登录、Host / Origin、基础页面权限等入口检查。Morpho 归属不放进 middleware。源请求节流、重试和错误分类属于外部请求基础设施，可同时供后台与交互链路使用。

## PostgreSQL migration 6

复用原有 schema、表、索引与数据。在 support_access 的 tickets、metadata、snapshots、reply_pages 中增量加入：

- `normalized jsonb`：可重建的 CRM 投影；动态字段在 JSONB 内，不按自定义字段增加 SQL 列。
- `mapping_version integer`：当前映射版本为 1；不同于 schema migration 版本 6 和 API 契约版本 2。

快照另加 group_id / provider，旧 Udesk 快照由一次性迁移填充，使 RMA 事务不再解析 Udesk JSON 进行归属判断。现有 raw、快照 ID、草稿、关联均不删除或改写。

已有工单的 normalized 尚未生成时，provider codec 可以离线解析 raw；不会因列表读取而向 Udesk 发请求。之后后台同步 / 单张实时读取逐步生成新版投影。mapping_version 改变时，读取可回退 codec，再通过同步重建。metadata 的 catalog 规范化文档缺失时也可离线翻译旧字段定义。

同步运行与完整代次状态仍在 integration；查询投影、筛选器成员和归属配置仍在 support_access；RMA drafts / links 仍在 rma。历史证据快照表暂留原位置，作为现有 RMA 关联的证据，不在本次迁移中移动 schema 或重写历史。

## 失败模式

| 失败 | 行为 / 恢复 |
| --- | --- |
| 超时、临时 5xx、限流 | client 对 429 / 5xx 有限重试，网络超时直接返回失败；共用统一预算。对外分类为 source_unavailable / source_rate_limited，HTTP 503；deadline 为 504。错误不包含签名 URL、token 或源响应正文 |
| 来源不存在 / 查询无效 | 来源 404 映射为 404；无效回复页映射为 400 |
| 源业务拒绝、格式损坏 | source_rejected / source_invalid_response，502；不当作空成功结果 |
| 目录、工单页或消息页缺少集合字段 | 拒绝该次读取；不能将损坏响应误认为合法空目录、停用全部账号或发布空索引 |
| 中间工单页重复 / 缺失 | 拒绝扫描，不发布新 generation；保留上一成功时间和范围 |
| 最后页完全重复第一页 | 保留已实测的租户兼容规则，只在最后页允许；不放宽中间页 |
| 附件签名过期 | 重新获取实时授权后的源记录来解析地址；任意非本工单地址仍拒绝 |
| 来源转组、配置修改 | 详情与敏感操作实时检查；本地配置修改立即影响 PG；列表仍有异步延迟，超过现有 15 分钟新鲜度阈值暂停列表 |

client 不为后台预占长串未来请求槽位；等待中的交互请求优先取得下一可用槽位，后台与交互仍消耗同一预算。已开始的 HTTP 请求不被中断。当前预算是单进程实例内共享；多实例背景扫描已用 PG advisory lock 去重，但多实例交互配额没有分布式限流。横向扩容前需按租户统一该预算。持续交互高负载也可能推迟后台更新，需根据同步延迟指标调整配额。

ACL 不会凭空减少全量扫描页数，不会消除异步列表的同步延迟，也不会提供源 API 没有的可靠增量能力。

## API 兼容窗口

React 请求 `Accept: application/vnd.morpho.support.v2+json`；也支持 `?contract=2`，例如 CSV 下载。v2 返回 ticket / sourceUrl、messages / currentPage / totalPages / totalCount、规范化 fields / templates / filters，不返回 source、Udesk 原始 JSON 或内部兼容 carrier。响应带 `Vary: Accept`，现有 no-store middleware 保留。

没有声明 v2 的既有客户端暂时继续收到 v1 source / udeskUrl、replies / meta、源字段定义。恢复源形状的代码集中在 `integrations/udesk/compatibility.go`，不在业务服务或 React 内。排序参数保留 v1 别名，React 使用 repliedAt / updatedAt / createdAt / number / assigneeName。

v2 导出使用 number、assigneeName 和 ticket_json；v1 导出保留旧列。两者都使用同一授权查询与脱敏结果，并保持 CSV 公式转义。

兼容策略：至少保留本次迁移与下一次部署的回滚窗口。移除 v1 前核实所有已知客户端和导出调用均已迁移；通过单独变更删除兼容 presenter 与旧排序别名，不在本次上线时静默移除。后续 v2 的可选字段可增量扩展；破坏性变更使用新契约版本并保留兼容窗口。

## 验证

- Adapter 契约测试：身份与跳转、动态字段及嵌套选项、跨页消息顺序、最终重复页、中途重复页、附件归属、格式损坏、错误分类与交互预算。
- PG / 应用测试：旧记录离线读取及脱敏、mapping version、migration 6 幂等与旧证据保持、现有同步/权限/配置/RMA 测试。
- HTTP：v1 兼容、v2 无原始 DTO、两版相同 Morpho 归属限制。
- 浏览器：字段/问题详情、Outlook 与 Samsung 邮件、附件全量列表与预览切换、RMA 草稿、中英文和手机宽度。
