# Harbor ERP

A working, local ERP and configurable RMA workspace inspired by the Lingxing frontend investigation. It connects product, purchase, inventory, fulfillment, sales, service, finance, and reporting workflows in a compact browser interface.

**This is an independent implementation.** It does not use Lingxing credentials or private APIs, copy its proprietary backend, or claim feature parity with its hundreds of routes.

## Start

```sh
./start.sh
```

Open **http://127.0.0.1:4317**. The launcher installs missing npm dependencies, builds the React frontend with Vite, compiles the Gin server, and runs the Go binary. Node is used only for development/build/test tooling; the running application is served by Go.

Requirements: **Node 22.19+ (22.x), 24.11+ (24.x), or 26+**, **Go 1.25+**, and a C compiler for the SQLite driver (Xcode command-line tools on macOS). The launcher can use the installed Codex Node runtime and the workspace-local Go toolchain. Elsewhere, install these tools on PATH or provide `HARBOR_NODE` / `HARBOR_GO`:

```sh
HARBOR_NODE=/absolute/path/to/node HARBOR_GO=/absolute/path/to/go ./start.sh
```

`PORT` changes the listening port. `DB_PATH` changes the SQLite path. `DIST_DIR` changes the built frontend directory. The server binds only to `127.0.0.1`. Data defaults to `data/harbor.sqlite`, with SQLite WAL sidecars. Runtime data is ignored by Git.

For frontend development, run the Go backend on 4317 and `npm run dev` in another terminal. Vite serves React on 5173 and proxies `/api` to Gin. For a prebuilt launch without Node:

```sh
npm ci && npm run build
./scripts/go.sh build -o ../.bin/harbor ./cmd/harbor
./.bin/harbor
```

### Example accounts

| Account | Email | Password | Access |
|---|---|---|---|
| Administrator | `admin@harbor.local` | `HarborDemo!2026` | All implemented actions |
| Operator | `operator@harbor.local` | `HarborDemo!2026` | Products, suppliers, purchases, inventory, transfers, sales, campaigns, tickets, tasks |
| Analyst | `analyst@harbor.local` | `HarborDemo!2026` | Read-only |

The sign-in screen has shortcuts for these accounts. They use example data. New users can be created in Settings → Users & roles. Settings also includes **Role permissions**, **Menus & buttons**, and **Assign roles**. Permissions are checked by the server for every mutation and protected read. Disabled users lose access on their next authenticated request.

## RMA workspace (version 3)

Open **RMAs** to create cases and search your own records. Administrators see all cases. **Support configuration** manages solution DAGs, independent task approvals, root causes, platforms, task types and custom fields without changing code. **Task center**, **Awaiting dispatch**, **Support orders**, **Serial numbers**, and **Cards & promo codes** provide the connected support workflow. Product now distinguishes device and custom support-part SKUs, including printheads and device compatibility.

Returns and refunds always require approval; the starter gift-card rule requires approval above $100. Work is recorded locally; issuing codes, sending shipments and transferring/refunding money still happen in external services. [Read the full RMA guide](docs/rma.md) for setup, policies, permissions and boundaries.

## Implemented workflows

| Area | Working behavior |
|---|---|
| Overview | Live KPIs, daily revenue chart, top products, approvals, stock alerts, tickets, and recent audit activity |
| Product | Create/edit products; SKU uniqueness; SPU, supplier, costs, price, category, lead time, reorder point; searchable/sortable catalog |
| Purchase | Multi-line drafts → submission → approval → ordered → partial/full receipts; supplier records; partial/full supplier payments |
| Inventory | Warehouse stock positions, reserved/available quantities, exact carrying value, explicit adjustments, movement ledger, warehouse creation |
| FBA | FBA inventory and explainable reorder-point suggestions linked to transfer creation |
| Logistics | Multi-line transfers → reservation → dispatch → receipt; tracking reference, ETA, carrier, and freight tracking |
| Sales | Multi-line orders → confirmation/reservation → shipping → completion; customer payments; partial/full returned quantities and collected-payment refunds |
| Advertising | Manual campaign records, budget, spend, attributed sales, ACOS/ROAS, local pause/activate |
| Service | Internal tickets, linked orders, priorities, notes, open/in-progress/resolved states |
| Finance | Revenue/COGS/profit, operating expenses, recorded payments, receivables, payables, on-hand/transit inventory values |
| Statistics | Date/channel filters, SKU performance, daily chart, real CSV download |
| Tools | Tasks, completion/reopening, unit-profit calculator with explicit inputs |
| Settings | Company/timezone preferences, users, custom roles, multiple-role assignment, page/button permissions, menu visibility/order, audit trail, business snapshot export, integration status |

Search tables, sort supported column headings, use the global product/document search, and export the record collections. Forms validate inputs in the browser and on the server. All tables display all matching records; pagination and large-data virtualization are not implemented.

## Try a connected workflow

1. Create a product with a unique SKU and a selling price.
2. Create a purchase order for it, selecting a supplier and receiving warehouse.
3. Submit, approve, and place the order. Receive some or all quantities.
4. Check Warehouse: stock, value, and the receipt ledger entry update together.
5. Create a sales order from that warehouse. Confirm it to reserve stock, then ship it to recognize sales and product cost.
6. Record the customer payment. Return a subset of shipped units to restore stock, reverse the relevant sales/cost, and refund any collected payment above the revised order value.
7. Create a transfer to an FBA/overseas warehouse. Reserve, dispatch, and receive it; stock value moves through in-transit inventory without being created or lost.
8. Check Finance and Statistics. Each view uses the same saved business records.

## Accounting and operational rules

- Currency is **USD only**. All financial amounts are integer cents. Quantities are whole units.
- Inventory stores exact total carrying value. Displayed average unit cost is rounded, but removals allocate exact cents with integer arithmetic. Transfers conserve cost, and repeated partial returns ultimately restore the original captured cost exactly.
- Catalog reference cost does not revalue existing inventory. Receiving purchases or positive adjustments changes weighted-average cost.
- Confirmed sales and reserved transfers lock stock. Available stock is on-hand minus locked stock. Other documents cannot consume those locks.
- Dispatch removes source stock and moves its value into transit. Receiving a transfer restores that exact value at the destination.
- Revenue and COGS are recognized at sales shipment. Cost is captured at that time; later purchases do not rewrite historical cost.
- Returns **restate the original sale's shipment date** in reports. They restore goods at their captured cost. Damaged/non-restockable returns are not implemented.
- All recorded expenses reduce operating profit. Campaign spend and shipment freight are tracking fields; record an expense separately when it should affect profit.
- Receivables include confirmed/shipped/completed orders; payables include approved/ordered/received purchases. Payments affect those balances, not revenue recognition.
- No over-receipt, over-return, over-payment, negative available inventory, same-warehouse transfer, or duplicate product line is accepted.
- Purchases with receipts or recorded payments cannot be cancelled. Paid sales cannot be cancelled before shipment; shipped returns are the implemented refund route. Standalone payment reversal is not implemented.
- Report day boundaries use the company timezone. Expense/payment date fields are explicit calendar dates. Channel filters apply to sales; expenses are not allocated by channel.
- The stock coverage setting is stored for future forecasting. The implemented suggestions use each product's reorder point, not a demand forecasting model.

Every mutation operates on a cloned snapshot, validates invariants, and commits in a serialized GORM/SQLite transaction. Failed multi-line actions roll back. Mutations support `Idempotency-Key`: replaying the same key and payload returns the prior result without applying it twice; reuse for a different payload is rejected.

## Data and recovery

The application persists its business state in a SQLite JSON document (`app_state`), with separate `sessions` and `request_receipts` tables. RuoYi permissions use normalized `sys_user`, `sys_role`, `sys_menu`, `sys_user_role`, and `sys_role_menu` tables. Those normalized tables are authoritative for access; the legacy user entries are retained for migration compatibility. This small-workspace design serializes mutations and is not intended as a multi-tenant, high-volume ERP storage architecture.

To back up everything, stop the server, then copy the `data/` directory. Restore by replacing that directory while the server is stopped. Settings also offers a portable **business snapshot** JSON export; it excludes users/passwords/sessions and has no import/restore UI. CSV exports are real downloads and neutralize spreadsheet formula-like text.

To start a fresh example workspace, stop the server and choose a new `DB_PATH`. Keep the existing database if its changes matter.

## Integrations and scope

Amazon, Shopify, 1688, carrier services, and Lingxing are **not connected**. No store authorization or external messaging occurs. Advertising status changes affect the local record only. There is no ASIN/MSKU pairing engine, external STA execution, marketplace data sync, tax/FX, statutory accounting, rich dashboard builder, or the complete 203-feature Lingxing navigation catalog.

This is a local implementation with tested workflows, not a production deployment. The example accounts, single-currency accounting, lack of department/row-level data scopes, and lack of multi-tenant isolation are explicit design boundaries. Only local HTTP is supported; the session cookie is HttpOnly/SameSite Strict and is not a hosted TLS deployment configuration.

## Permissions: RuoYi-Go adaptation

The backend adapts the MIT-licensed community Go port [lostvip-com/ruoyi-go](https://github.com/lostvip-com/ruoyi-go), discovered through [RuoYi](https://ruoyi.vip/). It reuses the role/menu/user model and menu-permission evaluation approach. This is a focused adaptation, not the complete upstream application. No RuoYi frontend, templates, or visual styles are used. See [provenance and license](THIRD_PARTY_NOTICES.md).

- Custom roles grant page access and individual actions such as `erp:product:add` and `system:role:edit`.
- Users can hold multiple roles; enabled-role grants are combined.
- Disabled roles, accounts, and permissions are re-evaluated on authenticated requests; no re-login is needed for server enforcement. Refresh the workspace to update visible buttons/menus.
- A hidden menu retains its permission; a disabled menu loses its own permission. Page and action grants are separate, following RuoYi's flat permission model. The role editor selects a parent page when granting an action and clears its action grants when unchecking that page.
- Administrator access is protected against removal of the last active administrator and self-lockout. Administrator has wildcard access.
- Route/permission identifiers are fixed by backend code. Administrators may edit menu labels, order, visibility, and enabled state.
- Products, warehouses, and company settings are shared reference data available to authenticated users for document forms. Business document collections, reports, exports, user lists, and permission management have server-side access checks. Page access is not a field-level confidentiality policy.
- RMA ownership is enforced on the server. General department/organization data scopes, tenant isolation, SSO, Redis, job scheduling, code generation, and arbitrary new route creation are not included. These are not implied by the RuoYi adaptation.

## Migration

The Go server opens the existing SQLite database and initializes RuoYi user/role/menu tables on first launch. Business collections and preferences are retained. Existing scrypt password hashes remain valid; new accounts use bcrypt. Existing session rows are compatible. Stop the old server before launching Go; do not run both against the same database.

Before replacing the old server, the existing local database was tested on a consistent copy: all 14 business collections and settings were unchanged and the legacy administrator login worked. A complete pre-framework SQLite backup is retained in ignored `data/pre-react-gin.sqlite`. The RMA upgrade has a separate `data/pre-rma-v3.sqlite` backup.

## Tests

```sh
npm ci
npm run check
npm test
./scripts/go.sh vet ./...
./scripts/go.sh test -race ./...
npx playwright install chromium
npm run test:browser   # ERP, RMA and expanded UI/API/SQLite audit
```

An existing Chrome executable may be selected with `CHROME_EXECUTABLE=/absolute/path/to/chrome npm run test:e2e`. Browser tests start a separate Go server and temporary SQLite database. They do not modify the delivered workspace. Screenshots and JSON reports go to ignored `test-results/`. `npm run test:all` runs lint, build, Go/frontend tests, vet and all three browser suites. GitHub Actions repeats these checks and the race detector for pushes and pull requests.

`npm run test:migration` verifies migration of the existing local legacy database on a temporary copy; set `MIGRATION_DB` to choose another legacy database. It requires the original example administrator credentials. This is an optional local migration check, separate from the portable unit/browser suites.

See [validation results](docs/validation.md) for coverage and limitations.

## Structure

```text
frontend/src/             React components, forms, pages, context, Harbor styling
frontend/vite.config.js   Build and development proxy
backend/cmd/harbor/       Go server entry point
backend/internal/httpapi/ Gin routes, authentication, exports
backend/internal/domain/ ERP validation, workflows, valuation, reporting
backend/internal/ruoyi/   Adapted RuoYi RBAC models and permission service
backend/internal/store/   SQLite persistence and transactional mutations
backend/internal/support/ Configurable RMA domain, ownership and workflow engine
backend/third_party/      Upstream MIT license
scripts/go.sh             Go toolchain resolver
tests/                    Browser workflows and legacy migration verification
data/                     Runtime database and migration backup (ignored)
```

Source is tracked in a standalone Git repository on `codex/rma-workflows`. The previous vanilla-JS/Node implementation remains in Git history. No database, external credentials, or private Lingxing code is committed.

## Warranty eligibility and language

RMA creation now checks solution/SKU/platform eligibility and warranty coverage on the server before any case or tasks are saved. Configure versioned rules in **Settings → Warranty rules** and solution requirements in **Support configuration → Solutions & DAG**. Device defaults are 12 months with a 14-day activation grace period; 1080 and 3200 printheads default to 3 and 6 months. Product forms include printhead warranty classification. See the [warranty guide](docs/rma.md#warranty-and-solution-eligibility) for evidence, date boundaries, scoped overrides and limitations.

Choose **English / 简体中文** on the login screen, in the workspace header or in a form dialog. Language preferences persist in this browser; switching does not navigate, reset forms, change business values or change currency. Navigation, page text, form labels, actions, statuses, built-in configuration labels and validation messages have a shared Chinese translation catalog. User-entered product names, notes, references and editable configuration values retain their original content. Date/number formatting follows the selected language while business date calculation still follows the company timezone.

Translations live in `frontend/src/locales/zh-CN.json`; English source messages are the catalog keys. `frontend/src/i18n.js` handles lookup, placeholders, dynamic validation messages and status labels. API contracts, identifiers and persisted enum values remain language-independent. API errors remain in canonical English and are translated at the presentation boundary. New UI strings should use `tr`, with identifiers in separate `value` attributes.

Run `npm run test:warranty` and `npm run test:i18n` for the added browser checks. `npm run test:browser` includes both alongside the original suites, and `npm test` includes localization tests.
