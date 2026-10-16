# RMA and support operations

The RMA workspace is built into the existing React/Gin application and uses its persistent SQLite database. No new external service is required. Open **RMAs**, **Task center**, **Awaiting dispatch**, **Support orders**, **Serial numbers**, **Cards & promo codes**, or **Support configuration** from the sidebar. The Harbor design language is retained.

## Quick start

1. In **Product**, add or classify each SKU as Device, Part, or General. For a custom support part, choose Printhead/Accessory/Component/Other and its compatible device SKUs. An empty compatibility list means universal. Every device and part remains a separate SKU row.
2. Optionally register local support orders and device/printhead serials. Printheads can link to a parent device SN. Existing ERP sales are searchable in Support orders when the user also has sales access. These records are local; they are not synced with a marketplace.
3. In **Support configuration**, configure platforms, root causes, solution task graphs, approval rules, task types and custom fields. Four starter solutions and six task types are provided; no example RMAs, support orders or serials are added to your real workspace.
4. An operator opens **Create RMA**, or creates one from a support order. Enter support ticket number, order number, purchased platform, affected SKU, optional registered SN, root cause, description, and proposed solution. Fill the values/SKUs/custom inputs requested by the solution's fixed tasks. Users cannot add independent task types or remove tasks during creation.
5. An administrator reviews each approval-pending task in Task center. Completing prerequisite tasks unlocks dependent tasks. Record dispatch, return receipt, refund transaction references, delivered codes, and any configured execution fields as the work happens outside Harbor.

## Ownership and permissions

- The server sets the creator from the authenticated session. Payload-supplied owner IDs are ignored.
- Non-administrators can see only the RMAs they created, their generated tasks and their benefit history. The same policy applies to bootstrap responses, direct RMA detail requests, CSV exports and global search. Foreign RMA IDs return 404.
- An active `admin` role can see all RMAs. Configuration is administrator-only. Administrators review approvals and record task execution; creators with the task-edit grant can edit their own unstarted task details and add case notes.
- RuoYi menu/button grants still determine page access and allowed actions. Operators receive the new operational pages plus RMA creation, notes and own-task editing. Analysts receive read access to their own support records. Task center, execution/review actions and Support configuration are granted to the administrator by default.
- The migration adds menus/grants once, preserves existing role assignments and does not overwrite custom roles. Administrators can adjust the new page/button grants through the existing role editor. Ownership and administrator-only configuration/review/execution checks are enforced in addition to those grants.
- Support order and serial reference registries are shared with users granted those pages. They do not expose other creators' RMA records or case-history links.

## Solutions and task DAGs

A solution contains 1–30 task nodes. Each has a stable key, task type, optional default value/SKU/quantity and zero or more dependency keys. Nodes with no dependencies can progress in parallel. A node may wait on multiple other nodes. The server rejects duplicate keys, unknown dependencies and cycles. Renaming/removing nodes in the editor also updates their dependency references.

Task types include **Send gift card**, **Send part(s)**, **Send device**, **Return device**, **Refund**, and **Send promo code**. Administrators can add custom manual task types and configure monetary inputs, required product/quantity, code/reference requirements, logistics direction, and an always-approve flag. Built-in execution behavior is protected; display names and enabled status can be edited. Disabling a task type prevents new RMAs using it while existing task snapshots remain processable.

Creating an RMA snapshots its solution and each task type. Later solution edits do not add/remove tasks from existing RMAs. Task values can be edited before work starts; that change re-evaluates current approval rules and discards any previous approval for the edited task. Completed or started tasks cannot be reconfigured. Reviewer/action requests require the task's current revision, so a stale approval cannot authorize a changed amount.

## Approvals

**Every built-in refund and every inbound return task requires approval**, including custom inbound task types. These requirements cannot be switched off. An administrator can add other requirements through task-type settings or approval rules.

A rule chooses a task type (or any type), a condition field, comparison and value. Supported fields are total task value in USD cents, quantity, purchased platform key, root-cause key, primary-cause key, and affected product ID. Comparisons are greater than, greater than or equal to, equals, and always; text fields support equals/always. Matching rules combine with OR: any match requires approval. Rules cannot waive mandatory approvals.

The starter gift-card rule requires approval for values **strictly greater than $100**; exactly $100 does not match it. Monetary values mean the total value of that task, not a per-unit amount. RMA owners cannot bypass approval by editing a previously approved task. Existing unchanged tasks retain their evaluated policy; new rules apply to new RMAs and to later edits of unstarted task details.

Approvals are independent of dependency completion: an administrator can approve a refund while its return task is still incomplete. The refund remains blocked until the returned device is recorded as received. Rejection puts the case into Needs attention; an authorized creator may revise unstarted task details to submit it for a fresh policy evaluation and review.

## Execution, logistics and history

Task statuses are Pending approval, Blocked, Ready, In progress, Completed, or Rejected. RMA status is derived from its tasks. Work can start only when approval is satisfied and all dependencies are completed.

- Monetary tasks require a positive value before execution.
- Product tasks require a SKU and whole quantity. Built-in device/part tasks validate the SKU type and configured part compatibility.
- Dispatch records require carrier and tracking. A dispatch changes the task to In progress; return receipt/other completion is a separate step.
- Refund completion requires a transaction reference. Gift-card/promo completion requires the code or delivery reference that was actually sent.
- **Awaiting dispatch** defaults to one row per RMA and also provides By task mode. It includes approval-pending/blocked logistics tasks and can filter inbound returns separately from outbound devices/parts. An RMA leaves when all its logistics tasks have a dispatch recorded.
- Completing a gift-card/promo task creates one immutable history entry. Repeated/completed requests cannot create another history entry. API idempotency keys also protect retries.
- Task event history captures actor, time, review reason/decision or execution action, and reviewed task values/revision. Case notes are retained separately.

These actions **record fulfillment performed outside Harbor**. They do not issue/send gift cards or coupons, transfer/refund money, buy shipping labels, contact customers, or change inventory/accounting automatically. Carrier, payment and marketplace adapters require actual provider integrations; those are not configured. A recorded dispatch/completion is an administrator's confirmation of outside work.

## Root causes and customization

Root causes are secondary labels under **Device issue**, **User issue**, or **Logistics issue**. Administrators can add, rename, enable/disable labels and restrict them to selected device/part SKUs. A blank SKU list applies to all SKUs. The creation form filters to enabled, applicable causes; the server validates that restriction. Historical RMAs retain their selected cause/platform/solution names.

Custom fields support text, long text, select options, nonnegative whole numbers and dates. They can be enabled/disabled and required/optional on **RMA, task input, task execution, product, support order and serial** forms. Task/input/execution fields can apply to a specific task type. Required execution fields are checked only on completion. Disabling a field removes it from entry forms while preserving previously saved values; hidden fields cannot be overwritten through a new payload.

Support lists automatically expose enabled custom fields as filter options. Product custom values also appear as catalog columns and filters, in text search, and in the edit form. All new lists provide text search and relevant dropdown/status/date filters. Timestamp filters and displayed dates use the company timezone; order purchase dates remain calendar dates. Global search recognizes visible RMA IDs/tickets/orders, registered serials, support orders and recorded benefit codes. No arbitrary scripts are evaluated; new external integrations or fundamentally new execution behavior still require code.

## Persistence and recovery

The additive migration initializes `supportConfig`, `rmas`, `rmaTasks`, `supportOrders`, `serials` and `benefitHistory` inside the existing transactional workspace state. It also adds seven RuoYi pages and eight action grants. Original ERP business collections and user/role assignments are preserved.

The complete pre-upgrade SQLite backup is retained in ignored **`data/pre-rma-v3.sqlite`**. Stop the server before restoring a full database. To roll back to the old application, restore that pre-RMA database along with the matching old code; the old application did not enforce RMA ownership. Business JSON exports are not a full database/permission backup.

## Verification

Run `npm run check`, `npm test`, `npm run vet`, `./scripts/go.sh test -race ./...`, and `npm run test:browser`. For only the new browser suite, use `npm run test:rma`. Set `CHROME_EXECUTABLE` to an installed compatible Chromium executable if needed. Tests use isolated temporary databases and do not add test RMAs or test users to the delivered workspace.

## Warranty and solution eligibility

Settings → **Warranty rules** configures the activation grace period (default 14 days), coverage periods (device 12 months, 1080 printhead 3 months, 3200 printhead 6 months), and optional SKU/market/platform overrides. Administrator access and the `warranty.save` grant are required. Updates check the policy revision and write an audit entry. Product forms classify printheads as 1080 or 3200; devices use device coverage automatically.

Rules follow revision 443, appendices A/B, of the [target design](https://zuvi.sg.larksuite.com/docx/VAdIduVsioO8m7xGpE1ljIUogwd). Devices start at the earlier of activation or delivery plus the grace period. During the grace period, unknown activation means insufficient evidence. Bundled printheads use the device start with their printhead coverage period; standalone printheads start the day after delivery. Coverage includes the start and excludes the end date; calendar-month additions clamp to the last day of the destination month. Eligibility uses the company's current calendar date.

Support configuration → Solutions adds **Requires active warranty**, eligible SKU restrictions and eligible platform restrictions. Legacy solutions infer warranty requirements for device/part replacement and return-plus-refund plans. Goodwill and refund-only plans do not require coverage. Existing return workflows remain available; this change does not implement the target's Phase 1/2 rollout flags.

The creation form previews eligibility; the server recalculates it inside the creation transaction. Missing, expired, future or conflicting evidence blocks creation without saving an RMA, tasks, audit mutation or idempotency receipt. Rules with more specified dimensions win; equally specific matches block rather than silently choosing. A market is required when applicable market-specific rules exist. Each successful RMA retains assessment dates, evidence, policy revision and matched rule snapshot. Historical cases are not re-evaluated when administrators edit policies.

Delivery/activation dates are currently agent-entered facts, explicitly labeled as such; no MES/Shopify verification or approved warranty override is implied. For replacements, enter original device dates and optionally its serial reference. The original reference is recorded as evidence, not independently verified lineage. Repair-pause adjustments and approved manual warranty corrections remain outside this feature. The model reserves `pauseIntervals` for later implementation.

Run `npm run test:warranty` for browser/API checks and `npm test` for date boundaries, atomicity, scoped rules, policy snapshots and permission checks.
