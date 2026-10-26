# Mabang order normalization and feasible synchronization plan

## Implemented in the 5186 worktree

`integrations/mabang` translates recent and history DTOs into the same CRM order
contract. Observed platform aliases are 16/Shopify, 2/Amazon, and 104/TikTokShop.
Unknown or conflicting identities remain unmapped, retain their raw codes, and
cannot pass RMA platform validation. Order lifecycle and catalog source statuses
use named states. Query partition codes 6/7 and 1/2 stay inside the adapter.

The contract includes normalized customer name/email/phones/city and source
metadata: a credential-free connection ID, API, raw codes, fetched-at timestamp,
and mapping version 2. Raw payloads remain evidence. Source timestamps without
an offset retain `timeZone=unspecified` and have no invented UTC time; timestamps
with an explicit offset also expose normalized UTC. Business query windows use
Shanghai time according to the API's documented day/night restrictions.

`remapmabang` validates all target rows before committing one transaction. It
updates only rebuildable order/catalog facts and preserves raw responses,
original fetch/index times, SKU policies and candidate/confirmed evidence.

```sh
./scripts/go.sh build -o ../.bin/remapmabang ./cmd/remapmabang
./.bin/remapmabang          # validate only
./.bin/remapmabang -apply  # atomic reprojection
```

The order center shows the timestamp of the latest **completed backfill**, even
if newer jobs fail. It explicitly states that continuous synchronization has
not yet been enabled. Individual detail reads never advance this timestamp.
There is no manual list refresh button. While mounted, the page checks the
local status/revision every ten seconds and updates the local list automatically
when its projection changes. It does not periodically repeat upstream searches.

## Verified upstream capabilities

Official documentation was read on 2026-10-26:

- Recent: <https://gwapi.mabangerp.com/web/#/api/v2?api=order-get-order-list-new>
- History: <https://gwapi.mabangerp.com/web/#/api/v2?api=get-history-order-list>

| Capability | Recent API | History API |
| --- | --- | --- |
| Updated-time range | `updateTimeStart`, `updateTimeEnd`; documented and sampled successfully | No documented updated-time filter; do not assume support |
| Payment-date scan | `paidtimeStart`, `paidtimeEnd` | `paidTime`, one date |
| Creation-time scan | `createDateStart`, `createDateEnd` | No documented equivalent |
| Exact ERP number | `platformOrderIds`; `allstatus=1` valid with this parameter | `platformOrderId`, bypasses time condition |
| Status coverage | Query both `status=6/7`, `canSend=3` for platform-number/date scans | Default status 3/4/5, query `canSend=1/2` |
| Pagination | `nextCursor`, `cursor`, documented maximum 1000 rows | `nextCursor`, `cursor`, documented 700 rows |
| Date availability | Four months; 07:00-19:00 Shanghai: recent seven-day windows; 19:00-07:00: four-month windows | Older-than-four-month historical range |

A bounded live read-only probe on 2026-10-26 used update date 2026-10-23,
`canSend=3`, `maxRows=5`. Status 7 returned five rows with further pages, including
orders paid in September but updated on October 23. Status 6 returned two rows.
For each branch, narrowing the range to one returned update timestamp (the same
start/end second) returned exactly one record at that timestamp. An exact recent
ERP-number request with `allstatus=1` also returned the intended order.

These observations establish that updated-time filtering works for the sampled
recent API windows and can find older-paid orders changed in that window. They
are not proof of complete delivery, every timezone convention, stable pagination
under concurrent changes, or unlimited historical change coverage. Probe output
in `.bin/order-capability-evidence.json` is local and excluded from Git; this
report includes no customer details or credentials.

## Proposed tasks, not separate upstream endpoints

Only normalization and the local status/list presentation above are enabled by
this change. The following are application jobs to implement in the next phase:

| Task | Feasible mechanism | Limits and enablement conditions |
| --- | --- | --- |
| Five-minute recent increment | Recent updated-time ranges, both status partitions, every cursor page | Persistent watermarks, overlap and restart tests first; bound daytime catch-up to documented windows |
| Nightly seven-day repair | Repeat recent payment/creation/date scans with idempotent upserts | Payment-only scans cannot claim unpaid-order coverage; include a verified discovery path for unpaid records |
| Rolling recent reconciliation | Re-read bounded day windows at night | Respect four-month availability, API budget and paging; do not rescan all four months every night by default |
| Boundary reconciliation | Overlapping dates around routing boundary, verify known references across APIs | A routing heuristic is not proof of precise archival timing; errors never count as empty |
| Earlier history backfill | Existing daily history scans and checkpoints | Payment-date coverage only; no historical change-feed guarantee |
| Historical hot-order verification | Read known source references when used or through a bounded queue | Not a historical incremental API and cannot discover all unseen historical changes |

Before enabling the recent worker: capture a fixed end time, split multi-day
windows, overlap the last successful watermark, exhaust both branches/pages,
and commit progress atomically. Never advance the successful watermark after a
partial failure. Reject responses whose update timestamps contradict the requested
window. A late/older observation must not overwrite a newer source revision.
Use a per-connection persistent lease and shared budget across processes; reserve
capacity for interactive requests. A failed/stale worker must resume on restart.

The UI must receive this worker's real completion timestamp separately from
historical backfill completion. It will continue to update local results without
a manual refresh control. Historical changes require rolling reconciliation or
an independently verified change/event API; none is assumed here.
