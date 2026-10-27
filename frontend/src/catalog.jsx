import React, { useEffect, useRef, useState } from "react";
import { api, useWorkspace } from "./context";
import { tr, intlLocale } from "./i18n";
import {
  Heading,
  Panel,
  Table,
  Button,
  FilterControl,
  Icon,
  SearchControl,
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
export function CatalogSync() {
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
function RelatedProductRow({ product, checked, onChange }) {
  const Tag = onChange ? "label" : "div";
  return (
    <Tag className={`catalog-device-option${checked ? " is-selected" : ""}${onChange ? "" : " is-readonly"}`}>
      {onChange && <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />}
      <span className="catalog-device-thumb" aria-hidden="true">
        <Icon name="product" />
        {product.image && <img src={product.image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={e => { e.currentTarget.style.display = "none"; }} />}
      </span>
      <span className="catalog-device-copy">
        <strong>{product.name || product.nameEn || product.sku}</strong>
        <small>{product.sku}</small>
      </span>
    </Tag>
  );
}

function ProductDetail({ product: p, onClose }) {
  const { state, reload } = useWorkspace();
  const grants = state.permissionCodes || [];
  const canQueryStock = ["*:*:*", "erp:warehouse:view", "erp:fba:view"].some(code => grants.includes(code));
  const [stock, setStock] = useState(null), [stockBusy, setStockBusy] = useState(false), [stockError, setStockError] = useState("");
  const queryStock = async () => {
    setStockBusy(true);
    setStockError("");
    try {
      setStock(await api(`/api/catalog/products/${encodeURIComponent(p.id)}/inventory`));
    } catch (e) { setStockError(e.message); }
    finally { setStockBusy(false); }
  };
  const admin = state.currentUser.roles?.includes("admin");
  const ref = useRef(null);
  const [v, setV] = useState({
      productType: p.productType || "general",
      warrantyClass: p.warrantyClass || "none",
      reshipRequiresApproval: p.reshipRequiresApproval ?? !p.allowReship,
      deviceIds: p.deviceIds || [],
      isBundle: !!p.isBundle,
      classificationNote: p.classificationNote || "",
      reason: "",
    }),
    [busy, setBusy] = useState(false),
    [deviceSearch, setDeviceSearch] = useState(""),
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
  const policyValue = value => Array.isArray(value)
    ? value.map(id => state.products.find(item => item.id === id)?.sku || id).join(", ") || "—"
    : typeof value === "boolean" ? tr(value ? "Enabled" : "Disabled") : tr(value || "none");
  const compatibleChoices = state.products.filter(d => d.productType === "device" && `${d.sku} ${d.name} ${d.nameEn || ""}`.toLowerCase().includes(deviceSearch.trim().toLowerCase()));
  const compatibleParts = state.products.filter(x => ["part", "consumable"].includes(x.productType) && x.deviceIds?.includes(p.id));
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
        {(source.warehouse?.length > 0 || canQueryStock) && (
          <section className="catalog-warehouse-section">
            <div className="catalog-section-heading">
              <h3>{tr("Warehouse inventory")}</h3>
              {canQueryStock && <Button onClick={queryStock} disabled={stockBusy}>{tr(stockBusy ? "Querying inventory…" : "Query inventory")}</Button>}
            </div>
            <p className="help-text">
              {stock ? `${tr("Inventory queried at")}: ${stamp(stock.queriedAt)}` : tr("Warehouse links do not represent inventory quantities.")}
            </p>
            {stockError && <p role="alert" className="error">{stockError}</p>}
            {stock && <div className="table-scroll"><table><thead><tr><th>{tr("Warehouse name")}</th><th>{tr("Available")}</th><th>{tr("On hand")}</th><th>{tr("Awaiting shipment")}</th></tr></thead><tbody>
              {stock.positions.map(w => <tr key={w.warehouseId}><td>{w.warehouse || w.warehouseId}</td><td>{w.available === "" ? "—" : w.available}</td><td>{w.onHand === "" ? "—" : w.onHand}</td><td>{w.waiting === "" ? "—" : w.waiting}</td></tr>)}
              {!stock.positions.length && <tr><td colSpan="4">{tr("No warehouse inventory returned.")}</td></tr>}
            </tbody></table></div>}
            {!stock &&
            <div className="catalog-chips">
              {(source.warehouse || []).map((w) => (
                <span key={w.warehouseId}>{w.warehouseName}</span>
              ))}
            </div>}
          </section>
        )}
        <form id="catalog-policy-form" className="catalog-policy-form" onSubmit={save}>
          <div className="catalog-section-heading">
            <h3>{tr("RMA SKU policy")}</h3>
            <span>{tr("CRM configuration only")}</span>
          </div>
          <p className="help-text">
            {tr(
              "Configure product classification, compatible devices and reshipment approval.",
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
                  {["general", "device", "part", "consumable", "other"].map((k) => (
                    <option key={k} value={k}>
                      {tr(k === "general" ? "Unclassified" : k === "device" ? "Device" : k === "part" ? "Accessory" : k === "consumable" ? "Consumable" : "Other / service")}
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
                  <option value="none">{tr("none")}</option>
                  {(state.supportConfig.warrantyPolicy.classes || []).map(cls => <option key={cls.id} value={cls.id}>{tr(cls.name)}</option>)}
                </select>
              </label>
            </div>
            <label className="catalog-classification-note">{tr("Classification notes")}
              <textarea aria-label={tr("Classification notes")} rows="2" maxLength="1000" value={v.classificationNote} onChange={e => set("classificationNote", e.target.value)} />
            </label>
            <div className="catalog-policy-options">
            <label className={`catalog-check ${v.isBundle ? "is-selected" : ""}`}>
              <input type="checkbox" checked={v.isBundle} onChange={e => set("isBundle", e.target.checked)} aria-label={tr("Sold as a bundle")} />
              <span><strong>{tr("Sold as a bundle")}</strong><small>{tr("A bundle keeps its sales SKU; components are not automatically expanded.")}</small></span>
            </label>
            <label className={`catalog-check ${v.reshipRequiresApproval ? "is-selected" : ""}`}>
              <input
                type="checkbox"
                aria-label={tr("Reshipment requires approval")}
                checked={v.reshipRequiresApproval}
                onChange={(e) => set("reshipRequiresApproval", e.target.checked)}
              />
              <span>
                <strong>{tr("Reshipment requires approval")}</strong>
                <small>{tr("Create a pending approval task before this SKU can be dispatched.")}</small>
              </span>
            </label>
            </div>
            {["part", "consumable"].includes(v.productType) && (
              <div className="catalog-compatibility">
                <div className="catalog-compatibility-heading">
                  <strong>{tr("Compatible devices")}</strong>
                  <span>{tr("{count} devices selected", { count: v.deviceIds.length })}</span>
                </div>
                <SearchControl label="Search compatible devices" placeholder="Search SKU or product name" value={deviceSearch} onChange={setDeviceSearch} />
                <div className="catalog-device-options">
                  {compatibleChoices.map(d => (
                    <RelatedProductRow key={d.id} product={d} checked={v.deviceIds.includes(d.id)} onChange={checked => set("deviceIds", checked ? [...v.deviceIds, d.id] : v.deviceIds.filter(id => id !== d.id))} />
                  ))}
                  {!compatibleChoices.length && <p className="catalog-device-empty">{tr("No matching products")}</p>}
                </div>
                <small>{tr("Select one or more devices. Unconfigured compatibility does not permit replacement for another product.")}</small>
              </div>
            )}
            {v.productType === "device" && (
              <div className="catalog-compatibility"><strong>{tr("Compatible accessories and consumables")}</strong>
                <div className="catalog-device-options">{compatibleParts.map(item => <RelatedProductRow key={item.id} product={item} />)}
                  {!compatibleParts.length && <p className="catalog-device-empty">{tr("No compatible items configured")}</p>}
                </div>
              </div>
            )}
            {admin && (
              <label className="catalog-policy-reason">
                {tr("Configuration reason")}
                <textarea
                  required
                  rows={2}
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
                  "reshipRequiresApproval",
                  "deviceIds",
                  "isBundle",
                  "classificationNote",
                ]
                  .filter((k) => a.before?.[k] !== a.after?.[k])
                  .map((k) => (
                    <p key={k}>
                      {tr(
                        {
                          productType: "SKU type",
                          warrantyClass: "Warranty class",
                          reshipRequiresApproval: "Reshipment requires approval",
                          deviceIds: "Compatible devices",
                          isBundle: "Sold as a bundle",
                          classificationNote: "Classification notes",
                        }[k],
                      )}
                      :{" "}
                      {policyValue(a.before?.[k])}{" "}
                      →{" "}
                      {policyValue(a.after?.[k])}
                    </p>
                  ))}
              </div>
            ))}
          </details>
        )}
      </div>
      <footer className="catalog-dialog-actions">
        <small>{tr("CRM configuration only")}</small>
        <Button kind="secondary" onClick={onClose}>Close</Button>
        {admin && (
          <button className="btn primary" form="catalog-policy-form" type="submit" disabled={busy}>
            {tr("Save configuration")}
          </button>
        )}
      </footer>
    </dialog>
  );
}
export function CatalogProducts() {
  const { state: s, reload, notify } = useWorkspace();
  const [status, setStatus] = useState(""),
    [eligibility, setEligibility] = useState(""),
    [productType, setProductType] = useState(""),
    [selected, setSelected] = useState(null);
  useEffect(() => {
    let active = true, pending = false;
    const refresh = async () => {
      if (selected || pending || document.visibilityState === "hidden") return;
      pending = true;
      try {
        await reload();
      } catch (e) {
        if (active && e.status !== 401) notify(e.message, "error");
      } finally {
        pending = false;
      }
    };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [reload, notify, selected]);
  const products = s.products.filter((p) => p.source === "mabang");
  const rows = products
    .filter(
      (p) =>
        (!status || p.sourceStatus === status) &&
        (!productType || (p.productType || "general") === productType) &&
        (!eligibility ||
          (eligibility === "approval" ? (p.reshipRequiresApproval ?? !p.allowReship) : !(p.reshipRequiresApproval ?? !p.allowReship))),
    )
    .map((p) => ({
      id: p.id,
      sku: p.sku,
      name: p.name,
      category: p.category,
      sourceStatus: p.sourceStatus,
      masterSku: p.masterSku,
      aliases: (p.aliases || []).join(", "),
      productType: p.productType || "general",
      warrantyClass: tr(s.supportConfig.warrantyPolicy.classes?.find((cls) => cls.id === p.warrantyClass)?.name || p.warrantyClass || "none"),
      isBundle: !!p.isBundle,
      reshipRequiresApproval: p.reshipRequiresApproval ?? !p.allowReship,
    }));
  return (
    <>
      <Heading subtitle="Manage product types, compatible devices and reshipment approval." />
      <Panel className="catalog-products">
        <Table
          toolbarControls={<>
          <FilterControl label="SKU type" value={productType} onChange={setProductType} options={[
            {value: "", label: "All types"}, {value: "device", label: "Device"}, {value: "part", label: "Accessory"}, {value: "consumable", label: "Consumable"}, {value: "other", label: "Other / service"}, {value: "general", label: "Unclassified"}
          ]} />
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
            label="Reshipment approval"
            value={eligibility}
            onChange={setEligibility}
            options={[
              { value: "", label: "All SKUs" },
              { value: "approval", label: "Approval required" },
              { value: "direct", label: "No approval required" },
            ]}
          />
</>
}
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
            col("SKU type", p => <>{tr(({device: "Device", part: "Accessory", consumable: "Consumable", other: "Other / service", general: "Unclassified"})[p.productType])}{p.isBundle && <small className="cell-sub">{tr("Bundle")}</small>}</>, "productType"),
            col("Master SKU", p => p.masterSku || "—", "masterSku"),
            col("Warranty class", p => p.warrantyClass, "warrantyClass"),
            col("Reshipment approval", p => (
              <span className={p.reshipRequiresApproval ? "catalog-approval-required" : "catalog-approval-standard"}>
                {tr(p.reshipRequiresApproval ? "Approval required" : "No approval required")}
              </span>
            ), "reshipRequiresApproval"),
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
