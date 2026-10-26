import React, { useEffect, useRef, useState } from "react";
import { api, useWorkspace } from "./context";
import { tr, intlLocale } from "./i18n";
import {
  Heading,
  Panel,
  Table,
  Button,
  FilterControl,
  ListToolbar,
  Note,
} from "./components";
const sourceStatuses = {
  Automatic: "Automatically created",
  Development: "Awaiting development",
  Selling: "Selling",
  Clearance: "Clearance",
  Discontinued: "Discontinued",
  Unknown: "Unknown",

};

// Legacy snapshots retain source codes; filter choices use the current contract only.
const sourceStatusLabel = (value) => sourceStatuses[value] || ({
  1: "Automatically created",
  2: "Awaiting development",
  3: "Selling",
  4: "Clearance",
  5: "Discontinued",
})[value] || value;
const stamp = (v) =>
  v
    ? new Intl.DateTimeFormat(intlLocale(), {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Asia/Shanghai",
      }).format(new Date(v))
    : "—";
const col = (label, render, key) => ({ label, render, key });
function CatalogSync() {
  const { state, reload } = useWorkspace();
  const admin = state.currentUser.roles?.includes("admin");
  const [runs, setRuns] = useState([]),
    [from, setFrom] = useState("2015-01-01"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const completed = useRef("");
  useEffect(() => {
    let live = true;
    const load = () =>
      api("/api/catalog/status")
        .then((v) => {
          if (!live) return;
          setRuns(v.runs || []);
          const last = (v.runs || []).find((r) => r.status === "completed");
          if (last && last.id !== completed.current) {
            completed.current = last.id;
            reload();
          }
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    load();
    const timer = window.setInterval(load, 5000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [reload]);
  const run = runs[0],
    last = runs.find((r) => r.status === "completed");
  const sync = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await api("/api/catalog/sync", {
        method: "POST",
        body: JSON.stringify({ fromDate: from }),
      });
      setRuns([r, ...runs]);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="catalog-sync">
      <div>
        <strong>{tr("Mabang catalog")}</strong>
        <p>
          {run?.status === "running"
            ? `${tr("Synchronizing catalog…")} · ${run.calls || 0} ${tr("requests")}`
            : last
              ? `${tr("Last successful sync")}: ${stamp(last.finishedAt)}`
              : tr("Catalog has not been synchronized.")}
        </p>
        {last && (
          <small>
            {tr("Catalog coverage starts")}: {last.fromDate} ·{" "}
            {last.productCount} SKU · {tr("Read-only ERP connection")}
          </small>
        )}
      </div>
      {admin && (
        <div className="catalog-sync-actions">
          <label>
            {tr("Catalog coverage starts")}
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              max={new Date().toISOString().slice(0, 10)}
            />
          </label>
          <Button
            kind="secondary"
            disabled={busy || run?.status === "running"}
            onClick={sync}
          >
            {tr("Sync catalog and inventory")}
          </Button>
        </div>
      )}
      {(error || run?.error) && (
        <p className="form-error" role="alert">
          {tr(error || run.error)}
        </p>
      )}
    </section>
  );
}
function ProductDetail({ product: p, onClose }) {
  const { state, reload } = useWorkspace();
  const admin = state.currentUser.roles?.includes("admin");
  const ref = useRef(null);
  const [v, setV] = useState({
      productType: p.productType || "general",
      warrantyClass: p.warrantyClass || "none",
      allowOriginal: !!p.allowOriginal,
      allowReship: !!p.allowReship,
      reason: "",
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    ref.current.showModal();
  }, []);
  const set = (k, x) => setV({ ...v, [k]: x });
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/api/catalog/policy", {
        method: "POST",
        body: JSON.stringify({
          ...v,
          id: p.id,
          expectedRevision: p.policyRevision,
        }),
      });
      await reload();
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const source = p.sourceSnapshot || {};
  const audits = (state.audit || []).filter(
    (a) => a.action === "catalog.policy" && a.reference === p.id,
  );
  return (
    <dialog
      ref={ref}
      className="modal catalog-detail"
      aria-label={p.sku}
      onCancel={onClose}
    >
      <div className="modal-header">
        <div>
          <span className="eyebrow">{tr("SKU details")}</span>
          <h2>{p.sku}</h2>
          <p>{p.name}</p>
        </div>
        <button
          className="icon-button"
          aria-label={tr("Close dialog")}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <div className="modal-body">
        <div className="catalog-product-lead">
          {p.image && (
            <img src={p.image} alt={p.name} referrerPolicy="no-referrer" />
          )}
          <dl className="catalog-facts">
            {[
              ["English name", p.nameEn],
              [
                "Source status",
                tr(sourceStatusLabel(p.sourceStatus)),
              ],
              ["Category", p.category],
              ["Master SKU", p.masterSku],
              ["Virtual SKUs", p.aliases?.join(", ")],
              ["Weight", source.weight],
              [
                "Dimensions",
                [source.length, source.width, source.height]
                  .filter(Boolean)
                  .join(" × "),
              ],
              ["Last successful sync", stamp(p.syncedAt)],
            ]
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <div key={k}>
                  <dt>{tr(k)}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
          </dl>
        </div>
        {source.warehouse?.length > 0 && (
          <section>
            <h3>{tr("Linked warehouses")}</h3>
            <p className="help-text">
              {tr("Warehouse links do not represent inventory quantities.")}
            </p>
            <div className="catalog-chips">
              {source.warehouse.map((w) => (
                <span key={w.warehouseId}>{w.warehouseName}</span>
              ))}
            </div>
          </section>
        )}
        <form onSubmit={save}>
          <div className="support-section-title">
            <h3>{tr("RMA SKU policy")}</h3>
            <small>{tr("CRM configuration only")}</small>
          </div>
          <p className="help-text">
            {tr(
              "Original order recognition and reshipment eligibility are independent. ERP status does not enable reshipment.",
            )}
          </p>
          <fieldset disabled={!admin || busy} className="catalog-policy">
            <div className="form-grid">
              <label>
                {tr("SKU type")}
                <select
                  aria-label={tr("SKU type")}
                  value={v.productType}
                  onChange={(e) => set("productType", e.target.value)}
                >
                  {["general", "device", "part"].map((k) => (
                    <option key={k} value={k}>
                      {tr(k)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {tr("Warranty class")}
                <select
                  aria-label={tr("Warranty class")}
                  value={v.warrantyClass}
                  onChange={(e) => set("warrantyClass", e.target.value)}
                >
                  {["none", "device", "printhead_1080", "printhead_3200"].map(
                    (k) => (
                      <option key={k} value={k}>
                        {tr(k)}
                      </option>
                    ),
                  )}
                </select>
              </label>
            </div>
            <label className="catalog-check">
              <input
                type="checkbox"
                checked={v.allowOriginal}
                onChange={(e) => set("allowOriginal", e.target.checked)}
              />
              {tr("Allow original order recognition")}
            </label>
            <label className="catalog-check">
              <input
                type="checkbox"
                checked={v.allowReship}
                onChange={(e) => set("allowReship", e.target.checked)}
              />
              {tr("Allow reshipment")}
            </label>
            {admin && (
              <label>
                {tr("Configuration reason")}
                <textarea
                  required
                  maxLength={1000}
                  value={v.reason}
                  onChange={(e) => set("reason", e.target.value)}
                />
              </label>
            )}
          </fieldset>
          {error && (
            <p className="form-error" role="alert">
              {tr(error)}
            </p>
          )}
          <div className="catalog-dialog-actions">
            <Button kind="secondary" onClick={onClose}>
              Close
            </Button>
            {admin && (
              <button className="btn primary" type="submit" disabled={busy}>
                {tr("Save configuration")}
              </button>
            )}
          </div>
        </form>
        {audits.length > 0 && (
          <details>
            <summary>{tr("View change history")}</summary>
            {audits.map((a) => (
              <div className="catalog-policy-history" key={a.id}>
                <strong>
                  {a.actor} · {stamp(a.at)}
                </strong>
                <p>{a.reason}</p>
                {[
                  "productType",
                  "warrantyClass",
                  "allowOriginal",
                  "allowReship",
                ]
                  .filter((k) => a.before?.[k] !== a.after?.[k])
                  .map((k) => (
                    <p key={k}>
                      {tr(
                        {
                          productType: "SKU type",
                          warrantyClass: "Warranty class",
                          allowOriginal: "Allow original order recognition",
                          allowReship: "Allow reshipment",
                        }[k],
                      )}
                      :{" "}
                      {typeof a.before?.[k] === "boolean"
                        ? tr(a.before[k] ? "Enabled" : "Disabled")
                        : tr(a.before?.[k] || "none")}{" "}
                      →{" "}
                      {typeof a.after?.[k] === "boolean"
                        ? tr(a.after[k] ? "Enabled" : "Disabled")
                        : tr(a.after?.[k] || "none")}
                    </p>
                  ))}
              </div>
            ))}
          </details>
        )}
      </div>
    </dialog>
  );
}
export function CatalogProducts() {
  const { state: s } = useWorkspace();
  const [status, setStatus] = useState(""),
    [eligibility, setEligibility] = useState(""),
    [selected, setSelected] = useState(null);
  const products = s.products.filter((p) => p.source === "mabang");
  const rows = products
    .filter(
      (p) =>
        (!status || p.sourceStatus === status) &&
        (!eligibility ||
          (eligibility === "enabled" ? p.allowReship : !p.allowReship)),
    )
    .map((p) => ({
      id: p.id,
      sku: p.sku,
      name: p.name,
      category: p.category,
      sourceStatus: p.sourceStatus,
      masterSku: p.masterSku,
      aliases: (p.aliases || []).join(", "),
      allowReship: p.allowReship,
      allowOriginal: p.allowOriginal,
    }));
  return (
    <>
      <Heading subtitle="Browse ERP SKUs and configure what customer service may reship." />
      <CatalogSync />
      <div className="catalog-stats">
        <Panel>
          <small>{tr("Inventory SKUs")}</small>
          <strong>{products.length}</strong>
        </Panel>
        <Panel>
          <small>{tr("Reship candidates to review")}</small>
          <strong>
            {products.filter((p) => p.reshipCandidate && !p.allowReship).length}
          </strong>
        </Panel>
        <Panel>
          <small>{tr("Enabled for reshipment")}</small>
          <strong>{products.filter((p) => p.allowReship).length}</strong>
        </Panel>
      </div>
      <Panel className="catalog-products">
        <ListToolbar>
          <FilterControl
            label="Source status"
            value={status}
            onChange={setStatus}
            options={[
              { value: "", label: "All statuses" },
              ...Object.entries(sourceStatuses).map(([value, label]) => ({
                value,
                label,
              })),
            ]}
          />
          <FilterControl
            label="Reshipment eligibility"
            value={eligibility}
            onChange={setEligibility}
            options={[
              { value: "", label: "All SKUs" },
              { value: "enabled", label: "Enabled for reshipment" },
              { value: "disabled", label: "Not enabled for reshipment" },
            ]}
          />
        </ListToolbar>
        <Table
          rows={rows}
          empty="No imported SKUs yet. Synchronize the Mabang catalog first."
          columns={[
            col(
              "Product / SKU",
              (p) => {
                const source = products.find((x) => x.id === p.id);
                return (
                  <button
                    className="catalog-product-cell"
                    onClick={() => setSelected(source)}
                  >
                    {source.image && (
                      <img
                        loading="lazy"
                        src={source.image}
                        alt=""
                        referrerPolicy="no-referrer"
                      />
                    )}
                    <span>
                      <strong>{p.sku}</strong>
                      <small>{p.name}</small>
                    </span>
                  </button>
                );
              },
              "sku",
            ),
            col(
              "Source status",
              (p) => (
                <span className={"catalog-status status-" + p.sourceStatus}>
                  {tr(sourceStatusLabel(p.sourceStatus))}
                </span>
              ),
              "sourceStatus",
            ),
            col("Category", (p) => p.category || "—", "category"),
            col("Master SKU", (p) => p.masterSku || "—", "masterSku"),
            col("Virtual SKUs", (p) => (
              <span className="catalog-aliases" title={p.aliases}>
                {p.aliases || "—"}
              </span>
            )),
            col("RMA SKU policy", (p) => (
              <div className="catalog-policy-labels">
                <span>
                  {tr(
                    p.allowOriginal
                      ? "Original order recognized"
                      : "Original order blocked",
                  )}
                </span>
                <strong>
                  {tr(
                    p.allowReship
                      ? "Enabled for reshipment"
                      : "Not enabled for reshipment",
                  )}
                </strong>
              </div>
            )),
          ]}
        />
      </Panel>
      {selected && (
        <ProductDetail
          key={selected.id}
          product={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}
export function CatalogInventory() {
  const { state: s } = useWorkspace();
  const [warehouse, setWarehouse] = useState("");
  const positions = s.catalogInventory || [];
  const names = [...new Set(positions.map((p) => p.warehouse))];
  const rows = positions
    .filter((p) => !warehouse || p.warehouse === warehouse)
    .map((p) => ({
      ...p,
      name: s.products.find((x) => x.sku === p.sku)?.name || "",
      onHand: p.onHand === "" ? null : Number(p.onHand),
      available: p.available === "" ? null : Number(p.available),
    }));
  return (
    <>
      <Heading subtitle="Warehouse balances read from Mabang. Quantities are snapshots, not reservations." />
      <Panel>
        <div className="catalog-inventory-heading">
          <div>
            <h2>{tr("ERP inventory")}</h2>
            <p className="help-text">
              {tr("Last successful sync")}: {stamp(positions[0]?.syncedAt)}
            </p>
          </div>
          <span>
            {names.length} {tr("warehouses")} · {positions.length}{" "}
            {tr("stock positions")}
          </span>
        </div>
        <ListToolbar>
          <FilterControl
            label="Warehouse"
            value={warehouse}
            onChange={setWarehouse}
            options={[
              { value: "", label: "All warehouses" },
              ...names.map((value) => ({ value, label: value })),
            ]}
          />
        </ListToolbar>
        <Table
          rows={rows}
          empty="No ERP inventory snapshot. Synchronize from the product catalog."
          columns={[
            col(
              "Product / SKU",
              (p) => (
                <>
                  <strong>{p.sku}</strong>
                  <small className="cell-sub">{p.name}</small>
                </>
              ),
              "sku",
            ),
            col("Warehouse", (p) => p.warehouse, "warehouse"),
            col("On hand", (p) => p.onHand ?? "—", "onHand"),
            col("Available", (p) => p.available ?? "—", "available"),
            col("Awaiting shipment", (p) => p.waiting || "—"),
            col("Purchase in transit", (p) => p.purchasing || "—"),
            col("Transfer in transit", (p) => p.transfer || "—"),
            col("Bin location", (p) => p.grid || "—"),
          ]}
        />
      </Panel>
      <Note>
        {tr(
          "Inventory is read-only. RMA creation records reshipment needs without reserving stock or creating ERP orders.",
        )}
      </Note>
    </>
  );
}
