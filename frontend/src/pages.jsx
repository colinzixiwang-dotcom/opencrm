import React, { useState } from "react";
import {
  useWorkspace,
  money,
  num,
  title,
  total,
  formatDate,
  today,
} from "./context";
import {
  Heading,
  Panel,
  PanelHeading,
  Stat,
  Table,
  ProductCell,
  DocCell,
  Icon,
  Button,
  Badge,
  NewButton,
  Export,
  Tabs,
  Note,
  Chart,
  Period,
  Transition,
  FormButton,
} from "./components";
const col = (label, render, key) => ({ label, render, key });
const lookup = (list, id) => list.find((x) => x.id === id)?.name || id || "—";
function SummaryLines({ record }) {
  const { state } = useWorkspace();
  return record.lines.map((l) => (
    <small key={l.productId} className="line-summary">
      {state.products.find((x) => x.id === l.productId)?.sku} × {l.qty}
      {l.received > 0 && <span>{l.received} received</span>}
    </small>
  ));
}
export function Overview() {
  const { state: s, report: r, go } = useWorkspace();
  const pending = s.purchases.filter((x) => x.status === "pending").length,
    low = s.stocks.filter(
      (x) =>
        x.onHand - x.locked <
        (s.products.find((p) => p.id === x.productId)?.reorderPoint || 0),
    ).length,
    tickets = s.tickets.filter((x) => x.status !== "resolved").length;
  return (
    <>
      <Heading>
        <div className="date-chip">
          <Icon name="clock" />
          {formatDate(today(s.settings.timezone))}
        </div>
        <Period />
      </Heading>
      <div className="overview-summary">
        <span>
          <span className="online-dot" />
          Workspace up to date
        </span>
        <span>
          Example workspace · {s.products.length} products ·{" "}
          {s.warehouses.length} warehouses
        </span>
      </div>
      <section className="stat-grid">
        <Stat
          label="Net sales"
          value={money(r.revenueCents)}
          caption="Recognized when orders ship"
          featured
          icon="sales"
        />
        <Stat
          label="Gross profit"
          value={money(r.grossProfitCents)}
          caption={`${r.revenueCents ? Math.round((r.grossProfitCents / r.revenueCents) * 100) : 0}% margin · after product cost`}
          icon="finance"
        />
        <Stat
          label="Inventory value"
          value={money(r.stockValueCents)}
          caption="Moving average · on-hand stock"
          icon="warehouse"
        />
        <Stat
          label="Orders shipped"
          value={num(r.orders)}
          caption={`${num(r.units)} units sold · net of returns`}
          icon="logistics"
        />
      </section>
      <div className="dashboard-grid">
        <Panel className="performance-panel">
          <PanelHeading
            title="Sales performance"
            subtitle="Recognized revenue by shipping date"
          >
            <span className="legend-dot">Net sales</span>
          </PanelHeading>
          <Chart report={r} />
          <div className="chart-summary">
            {[
              [
                "Average order",
                r.orders ? Math.round(r.revenueCents / r.orders) : 0,
              ],
              ["Product cost", r.cogsCents],
              ["Operating expenses", r.expenseCents],
            ].map(([l, v]) => (
              <div key={l}>
                <small>{l}</small>
                <strong>{money(v)}</strong>
              </div>
            ))}
          </div>
        </Panel>
        <Panel className="attention-panel">
          <PanelHeading
            title="Needs your attention"
            subtitle="A little focus goes a long way."
          >
            <span className="count-circle">{pending + low + tickets}</span>
          </PanelHeading>
          {[
            [
              "purchase",
              "Purchase approvals",
              "Ready for your review",
              pending,
              "amber",
            ],
            [
              "warehouse",
              "Low-stock positions",
              "Below product reorder point",
              low,
              "rose",
            ],
            [
              "service",
              "Open customer tickets",
              "Keep the conversation moving",
              tickets,
              "blue",
            ],
          ].map(([p, label, caption, value, color]) => (
            <button key={p} className="attention-row" onClick={() => go(p)}>
              <span className={"attention-icon " + color}>
                <Icon name={p} />
              </span>
              <span>
                <strong>{label}</strong>
                <small>{caption}</small>
              </span>
              <b>{value}</b>
              <Icon name="chevron" />
            </button>
          ))}
          <div className="attention-note">
            <Icon name="check" />
            Purchases, sales, and stock stay connected.
          </div>
        </Panel>
        <Panel className="top-products">
          <PanelHeading
            title="Products in focus"
            subtitle="Your top products by net sales."
          >
            <button className="text-button" onClick={() => go("statistics")}>
              View performance <Icon name="arrow" />
            </button>
          </PanelHeading>
          <Table
            search={false}
            limit={4}
            idKey="productId"
            rows={r.products}
            columns={[
              col("Product", (x) => (
                <ProductCell
                  product={s.products.find((p) => p.id === x.productId)}
                />
              )),
              col("Units sold", (x) => num(x.units)),
              col("Net sales", (x) => <strong>{money(x.revenueCents)}</strong>),
              col(
                "Gross margin",
                (x) =>
                  `${x.revenueCents ? Math.round(((x.revenueCents - x.cogsCents) / x.revenueCents) * 100) : 0}%`,
              ),
            ]}
          />
        </Panel>
        <Panel className="activity-panel">
          <PanelHeading
            title="Recent activity"
            subtitle="A trail of every important change."
          >
            <Icon name="clock" />
          </PanelHeading>
          <div className="activity-list">
            {s.audit.slice(0, 5).map((a) => (
              <div className="activity-item" key={a.id}>
                <span className="activity-dot" />
                <div>
                  <strong>{title(a.action.replace(".", " "))}</strong>
                  <small>
                    {a.actor} · {a.reference}
                  </small>
                </div>
                <time>{formatDate(a.at, s.settings.timezone)}</time>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </>
  );
}
export function Products({ query = "" }) {
  const { state: s, can, setModal } = useWorkspace();
  return (
    <>
      <Heading>
        <Export collection="products" />
        <NewButton
          label="Add product"
          type="product"
          permission="product.create"
        />
      </Heading>
      <Panel>
        <Table
          initialQuery={query}
          rows={s.products}
          columns={[
            col("Product / SKU", (p) => <ProductCell product={p} />, "name"),
            col(
              "Category",
              (p) => <span className="category">{p.category}</span>,
              "category",
            ),
            col("Supplier", (p) => lookup(s.suppliers, p.supplierId)),
            col("Purchase cost", (p) => money(p.costCents), "costCents"),
            col("Selling price", (p) => money(p.priceCents), "priceCents"),
            col("On hand", (p) =>
              num(
                s.stocks
                  .filter((x) => x.productId === p.id)
                  .reduce((a, x) => a + x.onHand, 0),
              ),
            ),
            col("Reorder point", (p) => p.reorderPoint, "reorderPoint"),
            col(
              "",
              (p) =>
                can("product.update") && (
                  <button
                    className="icon-button"
                    aria-label={"Edit " + p.sku}
                    onClick={() => setModal({ type: "product", id: p.id })}
                  >
                    <Icon name="edit" />
                  </button>
                ),
            ),
          ]}
        />
      </Panel>
      <Note icon="product">
        SKU identifies a local product; SPU groups variants. Inventory cost
        changes through receipts, not catalog edits.
      </Note>
    </>
  );
}
export function Purchasing({ query = "" }) {
  const { state: s, can } = useWorkspace();
  const [tab, setTab] = useState("orders");
  const supplier = tab === "suppliers";
  const actions = (o) => (
    <div className="row-actions">
      {(
        {
          draft: [["Submit", "pending"]],
          pending: [
            ["Approve", "approved"],
            ["Return to draft", "draft"],
          ],
          approved: [["Place order", "ordered"]],
        }[o.status] || []
      ).map(([label, status]) => (
        <Transition
          key={status}
          action="purchase.transition"
          id={o.id}
          status={status}
        >
          {label}
        </Transition>
      ))}
      {["ordered", "partial"].includes(o.status) && (
        <FormButton
          type="receive"
          id={o.id}
          permission="purchase.receive"
          kind="small primary"
        >
          Receive
        </FormButton>
      )}
      {!["draft", "pending", "cancelled"].includes(o.status) &&
        o.paidCents < total(o) && (
          <FormButton
            type="purchase-payment"
            id={o.id}
            permission="purchase.pay"
          >
            Pay
          </FormButton>
        )}
      {["draft", "pending", "approved", "ordered"].includes(o.status) &&
        !o.paidCents &&
        !o.lines.some((l) => l.received) && (
          <Transition
            action="purchase.transition"
            id={o.id}
            status="cancelled"
            kind="small danger-quiet"
          >
            Cancel
          </Transition>
        )}
    </div>
  );
  return (
    <>
      <Heading>
        <Export collection={supplier ? "suppliers" : "purchases"} />
        <NewButton
          label={supplier ? "Add supplier" : "New purchase order"}
          type={supplier ? "supplier" : "purchase"}
          permission={supplier ? "supplier.create" : "purchase.create"}
        />
      </Heading>
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          ["orders", "Purchase orders", s.purchases.length],
          ["suppliers", "Suppliers", s.suppliers.length],
        ]}
      />
      {supplier ? (
        <Panel>
          <Table
            key="suppliers"
            rows={s.suppliers}
            columns={[
              col("Supplier", (r) => <strong>{r.name}</strong>, "name"),
              col("Contact", (r) => r.contact),
              col("Email", (r) => r.email),
              col("Payment terms", (r) => r.terms),
              col(
                "Orders",
                (r) => s.purchases.filter((x) => x.supplierId === r.id).length,
              ),
            ]}
          />
        </Panel>
      ) : (
        <>
          <section className="stat-grid compact">
            <Stat
              label="Awaiting approval"
              value={s.purchases.filter((x) => x.status === "pending").length}
              caption="Review and approve purchasing"
            />
            <Stat
              label="Awaiting receipt"
              value={
                s.purchases.filter((x) =>
                  ["ordered", "partial"].includes(x.status),
                ).length
              }
              caption="Ordered · partial receipts"
            />
            <Stat
              label="Outstanding payable"
              value={money(s.report.outstandingPurchaseCents)}
              caption="Approved orders minus payments"
            />
          </section>
          <Panel>
            <Table
              key="orders"
              initialQuery={query}
              statuses={[
                "draft",
                "pending",
                "approved",
                "ordered",
                "partial",
                "received",
                "cancelled",
              ]}
              rows={s.purchases}
              columns={[
                col("Order", (o) => <DocCell record={o} />),
                col("Supplier / warehouse", (o) => (
                  <>
                    <strong>{lookup(s.suppliers, o.supplierId)}</strong>
                    <small className="cell-sub">
                      {lookup(s.warehouses, o.warehouseId)}
                    </small>
                  </>
                )),
                col("Items", (o) => <SummaryLines record={o} />),
                col("Total", (o) => (
                  <>
                    <strong>{money(total(o))}</strong>
                    <small className="cell-sub">
                      {money(o.paidCents)} paid
                    </small>
                  </>
                )),
                col(
                  "Expected",
                  (o) => formatDate(o.expectedDate),
                  "expectedDate",
                ),
                col("Status", (o) => <Badge value={o.status} />, "status"),
                col("Actions", actions),
              ]}
            />
          </Panel>
        </>
      )}
    </>
  );
}
export function Sales({ query = "" }) {
  const { state: s } = useWorkspace();
  const actions = (o) => {
    const next = {
      draft: ["Confirm", "confirmed"],
      confirmed: ["Ship", "shipped"],
      shipped: ["Complete", "completed"],
    }[o.status];
    return (
      <div className="row-actions">
        {next && (
          <Transition action="sale.transition" id={o.id} status={next[1]}>
            {next[0]}
          </Transition>
        )}
        {["draft", "confirmed"].includes(o.status) && !o.paidCents && (
          <Transition
            action="sale.transition"
            id={o.id}
            status="cancelled"
            kind="small danger-quiet"
          >
            Cancel
          </Transition>
        )}
        {!["draft", "cancelled"].includes(o.status) &&
          o.paidCents < total(o) - o.refundCents && (
            <FormButton type="sale-payment" id={o.id} permission="sale.pay">
              Record payment
            </FormButton>
          )}
        {["shipped", "completed"].includes(o.status) &&
          o.lines.some((l) => l.returned < l.qty) && (
            <FormButton type="return" id={o.id} permission="sale.return">
              Return
            </FormButton>
          )}
      </div>
    );
  };
  return (
    <>
      <Heading>
        <Export collection="sales" />
        <NewButton
          label="New sales order"
          type="sale"
          permission="sale.create"
        />
      </Heading>
      <section className="stat-grid compact">
        <Stat
          label="Net sales"
          value={money(s.report.revenueCents)}
          caption="Shipped orders · net of returns"
        />
        <Stat
          label="To fulfill"
          value={s.sales.filter((x) => x.status === "confirmed").length}
          caption="Confirmed and stock reserved"
        />
        <Stat
          label="Outstanding receivable"
          value={money(s.report.outstandingSalesCents)}
          caption="Confirmed orders minus payments"
        />
      </section>
      <Panel>
        <Table
          initialQuery={query}
          statuses={["draft", "confirmed", "shipped", "completed", "cancelled"]}
          rows={s.sales}
          columns={[
            col("Order", (o) => <DocCell record={o} />),
            col(
              "Customer",
              (o) => (
                <>
                  <strong>{o.customer}</strong>
                  <small className="cell-sub">{o.channel}</small>
                </>
              ),
              "customer",
            ),
            col("Items / warehouse", (o) => (
              <>
                <SummaryLines record={o} />
                <small className="cell-sub">
                  {lookup(s.warehouses, o.warehouseId)}
                </small>
              </>
            )),
            col("Net total", (o) => (
              <>
                <strong>{money(total(o) - o.refundCents)}</strong>
                {o.refundCents > 0 && (
                  <small className="cell-sub">
                    {money(o.refundCents)} returned
                  </small>
                )}
              </>
            )),
            col("Payment", (o) => (
              <Badge
                value={
                  o.paidCents >= total(o) - o.refundCents &&
                  o.status !== "draft"
                    ? "paid"
                    : o.paidCents
                      ? "partial"
                      : "unpaid"
                }
              />
            )),
            col("Status", (o) => <Badge value={o.status} />, "status"),
            col("Actions", actions),
          ]}
        />
      </Panel>
    </>
  );
}
export function Inventory() {
  const { state: s } = useWorkspace();
  const [tab, setTab] = useState("stock");
  return (
    <>
      <Heading>
        {tab !== "warehouses" && (
          <Export collection={tab === "stock" ? "stocks" : "movements"} />
        )}
        <NewButton
          label={tab === "warehouses" ? "Add warehouse" : "Adjust inventory"}
          type={tab === "warehouses" ? "warehouse" : "adjust"}
          permission={
            tab === "warehouses" ? "warehouse.create" : "inventory.adjust"
          }
        />
      </Heading>
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          ["stock", "Stock positions", s.stocks.length],
          ["movements", "Movement ledger", s.movements.length],
          ["warehouses", "Warehouses", s.warehouses.length],
        ]}
      />
      {tab === "warehouses" ? (
        <div className="warehouse-cards">
          {s.warehouses.map((w) => (
            <Panel className="warehouse-card" key={w.id}>
              <span className="warehouse-symbol">
                <Icon name="warehouse" />
              </span>
              <Badge value={w.type} />
              <h2>{w.name}</h2>
              <p>{w.location}</p>
              <div className="warehouse-totals">
                <div>
                  <small>On-hand units</small>
                  <strong>
                    {num(
                      s.stocks
                        .filter((x) => x.warehouseId === w.id)
                        .reduce((a, x) => a + x.onHand, 0),
                    )}
                  </strong>
                </div>
                <div>
                  <small>Inventory value</small>
                  <strong>
                    {money(
                      s.stocks
                        .filter((x) => x.warehouseId === w.id)
                        .reduce((a, x) => a + x.valueCents, 0),
                    )}
                  </strong>
                </div>
              </div>
            </Panel>
          ))}
        </div>
      ) : tab === "movements" ? (
        <Panel>
          <Table
            key={tab}
            rows={s.movements}
            columns={[
              col("Date", (r) => formatDate(r.createdAt), "createdAt"),
              col("Product", (r) => (
                <strong>
                  {s.products.find((p) => p.id === r.productId)?.sku}
                </strong>
              )),
              col("Warehouse", (r) => lookup(s.warehouses, r.warehouseId)),
              col("Movement", (r) => <Badge value={r.kind} />),
              col("Quantity", (r) => (
                <strong className={r.delta > 0 ? "positive" : "negative"}>
                  {r.delta > 0 ? "+" : ""}
                  {r.delta}
                </strong>
              )),
              col("Unit cost", (r) => money(r.unitCostCents)),
              col("Reference / reason", (r) => r.reference),
              col("After", (r) => num(r.onHandAfter)),
            ]}
          />
        </Panel>
      ) : (
        <>
          <section className="stat-grid compact">
            <Stat
              label="Available units"
              value={num(s.stocks.reduce((n, x) => n + x.onHand - x.locked, 0))}
              caption="On hand minus reserved"
            />
            <Stat
              label="Reserved units"
              value={num(s.stocks.reduce((n, x) => n + x.locked, 0))}
              caption="Confirmed sales and shipments"
            />
            <Stat
              label="In-transit value"
              value={money(s.report.transitValueCents)}
              caption="Dispatched, not yet received"
            />
          </section>
          <Panel>
            <Table
              key={tab}
              rows={s.stocks.map((r) => ({
                ...r,
                sku: s.products.find((p) => p.id === r.productId)?.sku,
                warehouse: lookup(s.warehouses, r.warehouseId),
              }))}
              columns={[
                col("Product", (r) => (
                  <ProductCell
                    product={s.products.find((p) => p.id === r.productId)}
                  />
                )),
                col("Warehouse", (r) => r.warehouse, "warehouse"),
                col("On hand", (r) => num(r.onHand), "onHand"),
                col("Reserved", (r) => num(r.locked), "locked"),
                col("Available", (r) => (
                  <strong>{num(r.onHand - r.locked)}</strong>
                )),
                col(
                  "Average cost",
                  (r) => money(r.averageCostCents),
                  "averageCostCents",
                ),
                col("Stock value", (r) => money(r.valueCents)),
                col("Health", (r) => (
                  <Badge
                    value={
                      r.onHand - r.locked <
                      (s.products.find((p) => p.id === r.productId)
                        ?.reorderPoint || 0)
                        ? "low_stock"
                        : "healthy"
                    }
                  />
                )),
              ]}
            />
          </Panel>
        </>
      )}
    </>
  );
}
export function Logistics({ embedded = false, query = "" }) {
  const { state: s } = useWorkspace();
  return (
    <>
      {!embedded && (
        <Heading>
          <Export collection="shipments" />
          <NewButton
            label="Create transfer"
            type="shipment"
            permission="shipment.create"
          />
        </Heading>
      )}
      <section className="stat-grid compact">
        <Stat
          label="Planned transfers"
          value={
            s.shipments.filter((x) => ["draft", "reserved"].includes(x.status))
              .length
          }
          caption="Prepare and reserve available stock"
        />
        <Stat
          label="In transit"
          value={s.shipments.filter((x) => x.status === "in_transit").length}
          caption="Waiting for destination receipt"
        />
        <Stat
          label="Received"
          value={s.shipments.filter((x) => x.status === "received").length}
          caption="Stock available at destination"
        />
      </section>
      <Panel>
        <Table
          initialQuery={query}
          statuses={[
            "draft",
            "reserved",
            "in_transit",
            "received",
            "cancelled",
          ]}
          rows={s.shipments}
          empty="No transfers yet."
          columns={[
            col("Shipment", (r) => <DocCell record={r} />),
            col("Route", (r) => (
              <>
                <strong>{lookup(s.warehouses, r.sourceId)}</strong>
                <small className="cell-sub">
                  → {lookup(s.warehouses, r.destinationId)}
                </small>
              </>
            )),
            col("Items", (r) => <SummaryLines record={r} />),
            col("Carrier / tracking", (r) => (
              <>
                <strong>{r.carrier}</strong>
                <small className="cell-sub">
                  {r.tracking || "Not assigned"}
                </small>
              </>
            )),
            col("Freight", (r) => money(r.freightCents)),
            col("ETA", (r) => formatDate(r.expectedDate), "expectedDate"),
            col("Status", (r) => <Badge value={r.status} />, "status"),
            col("Actions", (r) => {
              const n = {
                draft: ["Reserve stock", "reserved"],
                reserved: ["Dispatch", "in_transit"],
                in_transit: ["Receive transfer", "received"],
              }[r.status];
              return (
                <div className="row-actions">
                  {n && (
                    <Transition
                      action="shipment.transition"
                      id={r.id}
                      status={n[1]}
                    >
                      {n[0]}
                    </Transition>
                  )}
                  {["draft", "reserved"].includes(r.status) && (
                    <Transition
                      action="shipment.transition"
                      id={r.id}
                      status="cancelled"
                      kind="small danger-quiet"
                    >
                      Cancel
                    </Transition>
                  )}
                </div>
              );
            }),
          ]}
        />
      </Panel>
      <Note icon="logistics">
        Internal transfers preserve product cost. Freight is tracked separately;
        record an expense to include it in profit. External STA and carrier APIs
        are not connected.
      </Note>
    </>
  );
}
export function FBA() {
  const { state: s, can, setModal } = useWorkspace(),
    [tab, setTab] = useState("replenishment");
  const rows = s.stocks
    .filter(
      (r) => s.warehouses.find((w) => w.id === r.warehouseId)?.type === "fba",
    )
    .map((r) => ({
      ...r,
      product: s.products.find((p) => p.id === r.productId),
    }));
  return (
    <>
      <Heading>
        {tab === "transfers" && (
          <NewButton
            label="Create transfer"
            type="shipment"
            permission="shipment.create"
          />
        )}
      </Heading>
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          ["replenishment", "Replenishment"],
          ["transfers", "Transfers"],
          ["fba-stock", "FBA stock"],
        ]}
      />
      {tab === "transfers" ? (
        <Logistics embedded />
      ) : (
        <>
          <Note icon="alert">
            Suggestions use a transparent local rule: replenish to twice the
            product reorder point. This is not Lingxing’s forecasting algorithm.
          </Note>
          <Panel>
            <Table
              search={false}
              rows={
                tab === "fba-stock"
                  ? rows
                  : rows.filter(
                      (r) => r.onHand - r.locked < r.product.reorderPoint,
                    )
              }
              empty="FBA positions are above their reorder points."
              columns={[
                col("Product", (r) => <ProductCell product={r.product} />),
                col("Destination", (r) => lookup(s.warehouses, r.warehouseId)),
                col("Available", (r) => r.onHand - r.locked),
                col("Reorder point", (r) => r.product.reorderPoint),
                col("Suggested quantity", (r) => (
                  <strong>
                    {Math.max(
                      0,
                      r.product.reorderPoint * 2 - r.onHand + r.locked,
                    )}
                  </strong>
                )),
                col("Lead time", (r) => `${r.product.leadDays} days`),
                col(
                  "",
                  (r) =>
                    can("shipment.create") && (
                      <Button
                        kind="small primary"
                        onClick={() =>
                          setModal({
                            type: "shipment",
                            initial: {
                              productId: r.productId,
                              destinationId: r.warehouseId,
                              qty:
                                r.product.reorderPoint * 2 -
                                r.onHand +
                                r.locked,
                            },
                          })
                        }
                      >
                        Plan transfer
                      </Button>
                    ),
                ),
              ]}
            />
          </Panel>
        </>
      )}
    </>
  );
}
export function Advertising() {
  const { state: s } = useWorkspace();
  return (
    <>
      <Heading>
        <NewButton
          label="Record campaign"
          type="campaign"
          permission="campaign.create"
        />
      </Heading>
      <Note icon="advertising">
        Campaigns are manually recorded. Pausing changes the local record only.
        Spend is not automatically booked as a finance expense.
      </Note>
      <Panel>
        <Table
          rows={s.campaigns}
          columns={[
            col(
              "Campaign",
              (r) => (
                <>
                  <strong>{r.name}</strong>
                  <small className="cell-sub">
                    {r.channel} · manual record
                  </small>
                </>
              ),
              "name",
            ),
            col("Budget", (r) => money(r.budgetCents)),
            col("Spend", (r) => money(r.spendCents)),
            col("Attributed sales", (r) => money(r.attributedSalesCents)),
            col("ACOS", (r) =>
              r.attributedSalesCents
                ? `${((r.spendCents / r.attributedSalesCents) * 100).toFixed(1)}%`
                : "—",
            ),
            col("ROAS", (r) =>
              r.spendCents
                ? `${(r.attributedSalesCents / r.spendCents).toFixed(2)}×`
                : "—",
            ),
            col("Status", (r) => <Badge value={r.status} />),
            col("", (r) => (
              <Transition
                action="campaign.update"
                id={r.id}
                status={r.status === "active" ? "paused" : "active"}
                kind="small"
              >
                {r.status === "active" ? "Pause" : "Activate"}
              </Transition>
            )),
          ]}
        />
      </Panel>
    </>
  );
}
export function Service() {
  const { state: s, setModal } = useWorkspace();
  return (
    <>
      <Heading>
        <Export collection="tickets" />
        <NewButton
          label="New ticket"
          type="ticket"
          permission="ticket.create"
        />
      </Heading>
      <Panel>
        <Table
          statuses={["open", "in_progress", "resolved"]}
          rows={s.tickets}
          columns={[
            col("Ticket", (r) => <DocCell record={r} />),
            col("Subject / customer", (r) => (
              <>
                <strong>{r.subject}</strong>
                <small className="cell-sub">
                  {r.customer} {r.orderId && "· " + r.orderId}
                </small>
              </>
            )),
            col("Category", (r) => r.category),
            col("Priority", (r) => <Badge value={r.priority} />),
            col("Status", (r) => <Badge value={r.status} />, "status"),
            col("Notes", (r) => r.notes.length),
            col("Actions", (r) => (
              <div className="row-actions">
                <Button
                  kind="small"
                  onClick={() => setModal({ type: "ticket-view", id: r.id })}
                >
                  View notes
                </Button>
                <Transition
                  action="ticket.transition"
                  id={r.id}
                  status={
                    r.status === "resolved"
                      ? "open"
                      : r.status === "open"
                        ? "in_progress"
                        : "resolved"
                  }
                >
                  {r.status === "resolved"
                    ? "Reopen"
                    : r.status === "open"
                      ? "Start"
                      : "Resolve"}
                </Transition>
              </div>
            )),
          ]}
        />
      </Panel>
      <Note icon="service">
        Tickets and notes are internal records. No emails or marketplace
        messages are sent.
      </Note>
    </>
  );
}
export function Finance() {
  const { state: s } = useWorkspace(),
    [tab, setTab] = useState("summary"),
    r = s.report;
  return (
    <>
      <Heading>
        {tab !== "summary" && <Export collection={tab} />}
        <NewButton
          label="Record expense"
          type="expense"
          permission="expense.create"
        />
      </Heading>
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          ["summary", "Overview"],
          ["payments", "Payments", s.payments.length],
          ["expenses", "Expenses", s.expenses.length],
        ]}
      />
      {tab === "payments" ? (
        <Panel>
          <Table
            key={tab}
            rows={s.payments}
            columns={[
              col("Payment", (r) => <DocCell record={r} />),
              col("Direction", (r) => <Badge value={r.kind} />),
              col("Document", (r) => (
                <strong className="mono">{r.reference}</strong>
              )),
              col(
                "Amount",
                (r) => (
                  <strong
                    className={r.kind === "inflow" ? "positive" : "negative"}
                  >
                    {r.kind === "inflow" ? "+" : "−"}
                    {money(r.amountCents)}
                  </strong>
                ),
                "amountCents",
              ),
              col("Date", (r) => formatDate(r.date), "date"),
              col("Note", (r) => r.note),
              col("Recorded by", (r) => r.actor),
            ]}
          />
        </Panel>
      ) : tab === "expenses" ? (
        <Panel>
          <Table
            key={tab}
            rows={s.expenses}
            columns={[
              col("Expense", (r) => <DocCell record={r} />),
              col("Description", (r) => <strong>{r.description}</strong>),
              col("Category", (r) => r.category, "category"),
              col("Date", (r) => formatDate(r.date), "date"),
              col("Amount", (r) => money(r.amountCents), "amountCents"),
            ]}
          />
        </Panel>
      ) : (
        <>
          <section className="stat-grid">
            <Stat
              featured
              label="Net sales"
              value={money(r.revenueCents)}
              caption="Shipped sales less returns"
            />
            <Stat
              label="Gross profit"
              value={money(r.grossProfitCents)}
              caption="Sales less captured product cost"
            />
            <Stat
              label="Expenses"
              value={money(r.expenseCents)}
              caption="Recorded operating expenses"
            />
            <Stat
              label="Net operating profit"
              value={money(r.netProfitCents)}
              caption="Gross profit less expenses"
            />
          </section>
          <div className="two-columns">
            <Panel>
              <PanelHeading title="Outstanding balances" />
              {[
                ["Accounts receivable", r.outstandingSalesCents],
                ["Accounts payable", r.outstandingPurchaseCents],
                ["On-hand inventory", r.stockValueCents],
                ["Inventory in transit", r.transitValueCents],
              ].map(([l, v]) => (
                <div key={l} className="balance-row">
                  <span>{l}</span>
                  <strong>{money(v)}</strong>
                </div>
              ))}
            </Panel>
            <Panel className="finance-definition">
              <h2>A consistent view of profit.</h2>
              <p>
                Revenue is recognized when an order ships. Product cost is
                captured from moving-average inventory at that moment. Returns
                reverse both sales and cost.
              </p>
              <p>
                Expenses reduce operating profit. Payments affect receivables
                and payables, not revenue recognition.
              </p>
              <small>
                USD only · no tax, marketplace fees, FX, or statutory accounting
              </small>
            </Panel>
          </div>
        </>
      )}
    </>
  );
}
export function Statistics() {
  const {
    state: s,
    report: r,
    setFilters,
    setPeriod,
    filters,
    notify,
  } = useWorkspace();
  const [from, setFrom] = useState(filters.from),
    [to, setTo] = useState(filters.to),
    [channel, setChannel] = useState(filters.channel);
  const apply = () => {
    if (from && to && from > to) {
      notify("The start date must be before the end date.", "error");
      return;
    }
    setFilters({ from, to, channel });
    setPeriod("custom");
    notify("Report updated.");
  };
  const exportReport = () => {
    const rows = [
      [
        "SKU",
        "Product",
        "Units",
        "Net sales USD",
        "COGS USD",
        "Gross profit USD",
      ],
      ...r.products.map((p) => [
        s.products.find((x) => x.id === p.productId)?.sku,
        s.products.find((x) => x.id === p.productId)?.name,
        p.units,
        p.revenueCents / 100,
        p.cogsCents / 100,
        (p.revenueCents - p.cogsCents) / 100,
      ]),
    ];
    download(
      "harbor-performance.csv",
      "\uFEFF" +
        rows
          .map((row) =>
            row
              .map(
                (v) =>
                  '"' +
                  String(v)
                    .replace(/^[=+\-@]/, "'$&")
                    .replaceAll('"', '""') +
                  '"',
              )
              .join(","),
          )
          .join("\r\n"),
      "text/csv",
    );
  };
  return (
    <>
      <Heading>
        <Period />
        <Button kind="secondary" onClick={exportReport}>
          <Icon name="download" />
          Export report
        </Button>
      </Heading>
      <div className="report-filter">
        <label>
          From
          <input
            id="report-from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label>
          To
          <input
            id="report-to"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <label>
          Channel
          <select
            id="report-channel"
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
          >
            <option value="all">All channels</option>
            {["Amazon", "Shopify", "Direct", "Wholesale"].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </label>
        <Button kind="primary" onClick={apply}>
          Apply filters
        </Button>
        <span>Shipment date · returns restate the original sale</span>
      </div>
      <section className="stat-grid compact">
        <Stat
          label="Net sales"
          value={money(r.revenueCents)}
          caption="After returned units"
        />
        <Stat
          label="Units sold"
          value={num(r.units)}
          caption={`${r.orders} shipped orders`}
        />
        <Stat
          label="Gross margin"
          value={
            r.revenueCents
              ? `${((r.grossProfitCents / r.revenueCents) * 100).toFixed(1)}%`
              : "—"
          }
          caption="Net sales less product cost"
        />
      </section>
      <Panel>
        <PanelHeading
          title="Product performance"
          subtitle="Local SKU is the supported aggregation dimension."
        />
        <Chart report={r} />
        <Table
          search={false}
          idKey="productId"
          rows={r.products}
          columns={[
            col("Product", (p) => (
              <ProductCell
                product={s.products.find((x) => x.id === p.productId)}
              />
            )),
            col("Units", (p) => num(p.units)),
            col("Net sales", (p) => money(p.revenueCents)),
            col("Product cost", (p) => money(p.cogsCents)),
            col("Gross profit", (p) => (
              <strong>{money(p.revenueCents - p.cogsCents)}</strong>
            )),
            col("Margin", (p) =>
              p.revenueCents
                ? `${(((p.revenueCents - p.cogsCents) / p.revenueCents) * 100).toFixed(1)}%`
                : "—",
            ),
          ]}
        />
      </Panel>
    </>
  );
}
function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
export function Tools() {
  const { state: s } = useWorkspace(),
    [tab, setTab] = useState("tasks");
  return (
    <>
      <Heading>
        {tab === "tasks" && (
          <NewButton label="New task" type="task" permission="task.create" />
        )}
      </Heading>
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          [
            "tasks",
            "Operational tasks",
            s.tasks.filter((x) => x.status === "open").length,
          ],
          ["calculator", "Profit calculator"],
        ]}
      />
      {tab === "calculator" ? (
        <Calculator />
      ) : (
        <Panel>
          <Table
            rows={s.tasks}
            statuses={["open", "done"]}
            columns={[
              col("Task", (r) => <strong>{r.title}</strong>, "title"),
              col("Owner", (r) => r.owner, "owner"),
              col("Due date", (r) => formatDate(r.dueDate), "dueDate"),
              col("Priority", (r) => <Badge value={r.priority} />),
              col("Status", (r) => <Badge value={r.status} />),
              col("", (r) => (
                <Transition
                  action="task.transition"
                  id={r.id}
                  status={r.status === "done" ? "open" : "done"}
                  kind="small"
                >
                  {r.status === "done" ? "Reopen" : "Mark done"}
                </Transition>
              )),
            ]}
          />
        </Panel>
      )}
    </>
  );
}
function Calculator() {
  const [v, setV] = useState({
    price: "29.90",
    cost: "8.50",
    shipping: "3.20",
    other: "1.00",
    fee: "15",
    ads: "10",
  });
  const n = Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, Number(x)]),
    ),
    valid =
      Object.values(n).every((x) => Number.isFinite(x) && x >= 0) &&
      n.fee <= 100 &&
      n.ads <= 100,
    fees = (n.price * (n.fee + n.ads)) / 100,
    profit = n.price - n.cost - n.shipping - n.other - fees;
  return (
    <Panel className="calculator-panel">
      <div>
        <span className="eyebrow">UNIT ECONOMICS</span>
        <h2>Know the room in your margin.</h2>
        <p>
          Calculate an estimate from a selling price and the costs you enter.
        </p>
        <form id="calculator-form">
          <div className="form-grid">
            {[
              ["price", "Selling price ($)"],
              ["cost", "Product cost ($)"],
              ["shipping", "Shipping / unit ($)"],
              ["other", "Other costs / unit ($)"],
              ["fee", "Marketplace fee (%)"],
              ["ads", "Advertising / sale (%)"],
            ].map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  name={key}
                  type="number"
                  min="0"
                  step="0.01"
                  max={["fee", "ads"].includes(key) ? 100 : undefined}
                  value={v[key]}
                  onChange={(e) => setV({ ...v, [key]: e.target.value })}
                />
              </label>
            ))}
          </div>
        </form>
      </div>
      <div id="calculator-result" className="calculator-result">
        {valid ? (
          <>
            <span className="eyebrow">ESTIMATED PROFIT / UNIT</span>
            <div
              className={"calculator-value " + (profit < 0 ? "negative" : "")}
            >
              {money(Math.round(profit * 100))}
            </div>
            <span className="calculator-margin">
              {n.price ? ((profit / n.price) * 100).toFixed(1) + "%" : "—"} net
              margin
            </span>
            <div className="calc-breakdown">
              <span>Product + shipping + other</span>
              <strong>
                {money(Math.round((n.cost + n.shipping + n.other) * 100))}
              </strong>
              <span>Marketplace + advertising</span>
              <strong>{money(Math.round(fees * 100))}</strong>
              <span>Selling price</span>
              <strong>{money(Math.round(n.price * 100))}</strong>
            </div>
            <p>
              Planning estimate only. This does not change catalog prices or
              finance records.
            </p>
          </>
        ) : (
          <p>Enter nonnegative costs and percentages between 0 and 100.</p>
        )}
      </div>
    </Panel>
  );
}
