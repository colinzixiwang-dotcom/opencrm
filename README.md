# Harbor ERP

A working, local ERP inspired by the Lingxing frontend investigation. It connects product, purchase, inventory, fulfillment, sales, service, finance, and reporting workflows in a compact browser interface.

**This is an independent implementation.** It does not use Lingxing credentials or private APIs, copy its proprietary backend, or claim feature parity with its hundreds of routes.

## Start

```sh
./start.sh
```

Open **http://127.0.0.1:4317**. The launcher uses a supported `node` from your path, or the installed Codex bundled Node runtime when available. To select one explicitly:

```sh
HARBOR_NODE=/absolute/path/to/node ./start.sh
```

Node **24.15+ within 24.x, or 26+** is required for the built-in SQLite API. There are **no runtime package dependencies and no build step**. Alternatively, with a supported Node version:

```sh
node server.mjs
```

`PORT` changes the listening port. `DB_PATH` changes the SQLite path. The server binds only to `127.0.0.1`. Data defaults to `data/harbor.sqlite`, with SQLite WAL sidecars. Runtime data is ignored by Git.

### Example accounts

| Account | Email | Password | Access |
|---|---|---|---|
| Administrator | `admin@harbor.local` | `HarborDemo!2026` | All implemented actions |
| Operator | `operator@harbor.local` | `HarborDemo!2026` | Products, suppliers, purchases, inventory, transfers, sales, campaigns, tickets, tasks |
| Analyst | `analyst@harbor.local` | `HarborDemo!2026` | Read-only |

The sign-in screen has shortcuts for these accounts. They use example data. New users can be created in Settings → Users & roles. Permissions are checked by the server for every mutation, not just hidden in the interface. Disabled users lose access on their next authenticated request.

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
| Settings | Company/timezone preferences, user roles/access, audit trail, business snapshot export, transparent integration status |

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

Every mutation operates on a cloned snapshot, validates invariants, and commits in a SQLite `BEGIN IMMEDIATE` transaction. Failed multi-line actions roll back. Mutations support `Idempotency-Key`: replaying the same key and payload returns the prior result without applying it twice; reuse for a different payload is rejected.

## Data and recovery

The application persists its business state in a SQLite JSON document (`app_state`), with separate `sessions` and `request_receipts` tables. This small-workspace design serializes mutations and is not intended as a multi-tenant, high-volume ERP storage architecture.

To back up everything, stop the server, then copy the `data/` directory. Restore by replacing that directory while the server is stopped. Settings also offers a portable **business snapshot** JSON export; it excludes users/passwords/sessions and has no import/restore UI. CSV exports are real downloads and neutralize spreadsheet formula-like text.

To start a fresh example workspace, stop the server and choose a new `DB_PATH`. Keep the existing database if its changes matter.

## Integrations and scope

Amazon, Shopify, 1688, carrier services, and Lingxing are **not connected**. No store authorization or external messaging occurs. Advertising status changes affect the local record only. There is no ASIN/MSKU pairing engine, external STA execution, marketplace data sync, tax/FX, statutory accounting, rich dashboard builder, or the complete 203-feature Lingxing navigation catalog.

This is a local implementation with tested workflows, not a production deployment. The example accounts, single-currency accounting, coarse roles, and lack of multi-tenant isolation are explicit design boundaries. Only local HTTP is supported; the session cookie is HttpOnly/SameSite Strict and is not a hosted TLS deployment configuration.

## Tests

Domain and HTTP tests require no third-party packages:

```sh
npm test
npm run check
```

For browser tests, install the optional development dependency and a browser:

```sh
npm install
npx playwright install chromium
npm run test:e2e
```

An existing Chrome executable may be used instead of installing a browser:

```sh
CHROME_EXECUTABLE="/absolute/path/to/chrome" npm run test:e2e
```

`PLAYWRIGHT_PATH` can point to an existing Playwright installation. The browser suite starts a separate server and temporary SQLite database; it does not modify your running workspace. Screenshots and its result JSON go to ignored `test-results/`.

Coverage includes atomic partial receipts, reservation isolation, over-receipt/return/payment rejection, transfer valuation, fractional-cost cent conservation, historical COGS, timezone reporting, persistent sessions/data after restart, idempotency replay, role enforcement, disabled-user sessions, formula-safe export, all 12 module screens, connected browser workflows, mobile navigation, and no browser errors. See `docs/validation.md` for the delivered verification result.

## Structure

```text
server.mjs          HTTP, authentication, SQLite transactions, exports
lib/domain.mjs      Validation, workflow rules, valuation, reports, example data
public/app.js       Browser UI, forms, navigation, charting, downloads
public/style.css    Responsive desktop/mobile interface
tests/              Domain, HTTP, and browser workflow tests
data/               Runtime database (ignored)
```

Source is tracked in a standalone Git repository on `codex/lingxing-erp`. No database, credentials from external services, downloaded Lingxing code, or test-generated business data is committed.
