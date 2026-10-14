# Version 3 validation

Verified on **15 October 2026** on macOS arm64 with Go **1.27.2**, Gin **1.11.0**, GORM **1.31.1**, Node **24.19.0**, React **19.3.0**, Vite **7.3.7**, and Playwright **1.62.1**.

## Results

- **38 passing Go tests:** 13 ERP domain, 12 HTTP/integration, and 13 support workflow tests.
- `go test -race ./...` and `go vet ./...` passed.
- Frontend ESLint and production build passed.
- **29 browser checkpoints:** 19 existing ERP workflows plus 10 RMA workflows.
- Both browser suites reported zero JavaScript page errors.
- Existing workspace migration passed on an isolated copy. A direct comparison of the running app with `data/pre-rma-v3.sqlite` also confirmed that all 14 original business collections, settings, and revision were retained. Seven new pages and starter support configuration were added, with no QA RMAs/orders/serials added to the real workspace.

## RMA browser checkpoints

1. device and custom printhead SKUs, compatibility, and product filters.
2. admin creates required custom fields, SKU-specific root causes, and a five-node solution DAG without code.
3. support orders and linked device / printhead serials can be created and searched.
4. creator selects one solution and creates all five tasks with three independent approvals.
5. a second agent cannot see the case in UI, detail API, task data, or CSV exports.
6. admin reviews tasks independently while dependencies continue to block execution.
7. return receipt unlocks refund and parts; dispatch queue clears and all tasks complete.
8. sent gift card and promo code history supports type filters and code search.
9. admin-configured product and execution fields work; changing a gift value triggers a new approval.
10. owner case notes, completed-case visibility, responsive layout, and zero JavaScript errors.

## Backend edge cases

Tests cover trusted creator assignment; owner-filtered bootstrap, detail and CSV access; administrator visibility; atomic rejected operations; exact $100 approval boundaries; mandatory refund, built-in return and custom inbound-return approval; independent reviews and execution dependencies; return dispatch versus receipt; review invalidation after task edits; stale revision rejection; positive execution amounts; required refund/code references; exactly-once benefit history; request idempotency; cyclic/missing/duplicate DAG nodes; historical solution snapshots; root-cause enablement and SKU applicability; custom task types; required/custom select fields; execution field validation; serial uniqueness/type/parent validation; additive permission migration; and preservation of disabled custom fields without accepting hidden-field writes.

The original suite also retains purchase approval/partial receipts, inventory reservations and exact cent conservation, returns/refunds, warehouse transfers, historical COGS, timezone reports, login/session persistence, RBAC, exports, throttling, settings, mobile navigation and profit-calculator checks.

## Visual checks

Reviewed desktop RMA list and workflow configuration, task center, benefit history, and mobile RMA list at 390 × 844. The existing Harbor styling is preserved. Tables scroll within their containers; the tested mobile page has no document-level overflow. Native dialogs retain labels and focus management. This is not a formal accessibility certification.

![RMA owner list](screenshots/rma-owner-list.png)

![Task center](screenshots/rma-task-center.png)

![Configurable solution workflow](screenshots/rma-dag-editor.png)

![Mobile RMA list](screenshots/rma-mobile.png)

## Scope

These results apply to the documented local workflows and representative edge cases. They do not establish production load capacity, complete Lingxing/RuoYi parity, external carrier/payment/marketplace compatibility, tenant isolation, general department data scopes, or exhaustive security/accessibility coverage. RMA ownership is implemented. Issuing/sending gift cards or promo codes, refunds and shipments are performed externally and recorded here.

See [the RMA guide](rma.md) for configuration, permissions, execution and recovery. Repeat with `npm run check`, `npm test`, `npm run vet`, `./scripts/go.sh test -race ./...`, `npm run test:browser`, and optional `npm run test:migration`. Browser screenshots and JSON reports are generated under ignored `test-results/`; committed screenshots show only test data.
