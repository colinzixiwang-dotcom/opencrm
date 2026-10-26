# 5186 小范围补发配置记录

配置日期：2026-10-26（北京时间）。按用户要求，仅对下面 3 个现有商品开启补发。通过 `/api/catalog/policy` 保存，使用 `expectedRevision` 并生成系统审计记录。

| SKU | 类型变更 | 允许补发 | 原单识别 | 质保类别 | 审计 ID |
| --- | --- | --- | --- | --- | --- |
| zuvi-halo-us | general → device | false → true | true（保留） | none（保留未配置） | AUD-d8e58ec57c43 |
| styling-concentrator-HS100 | general → part | false → true | true（保留） | none（保留未配置） | AUD-687d8bf63403 |
| gentle-air-attachment-HS100 | general → part | false → true | true（保留） | none（保留未配置） | AUD-91b66d27e97b |

选择条件：源状态为 Selling、源商品存在、商品名称明确；没有开放停用商品、待匹配商品、翻新机或其他地区整机。其余 101 个商品策略逐项核对未变。

此次配置仅影响 CRM 的补发候选。不会创建 RMA、生成补发任务、修改马邦商品或触发库存及发货操作。执行前后 RMA 和任务数量一致。

## 回退

在商品目录中逐个取消“允许补发”，将 SKU 类型恢复为“通用”，保留原单识别开关与质保类别，并填写回退原因。也可通过 `/api/catalog/policy` 读取当前 `policyRevision` 后提交同样的策略；不要复用旧 revision。回退不会删除历史 RMA 已保存的快照；待执行任务会在执行时重新校验补发许可。
