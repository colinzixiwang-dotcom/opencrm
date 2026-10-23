import React, { useState } from "react";
import { api, useWorkspace } from "./context";
import { tr, intlLocale } from "./i18n";
import { Button, Note } from "./components";

export function OriginalOrderSummary({ confirmation }) {
  const { state: s } = useWorkspace();
  if (!confirmation?.order) return null;
  const { order: o } = confirmation;
  return (
    <section className="original-order-summary">
      <div className="detail-grid">
        {[
          ["Platform order number", o.platformNumber],
          ["Mabang order number", o.sourceNumber],
          ["Purchased platform", o.platform],
          ["Shop", o.shop],
          ["Payment time", o.paidAt],
          ["Shipment time", o.shippedAt],
          [
            "Order amount",
            o.currency && o.amount ? `${o.currency} ${o.amount}` : "",
          ],
          [
            "Query source",
            tr(
              o.provider === "manual"
                ? "Manually entered order"
                : o.querySource === "history"
                  ? "Historical orders"
                  : "Recent orders",
            ),
          ],
        ]
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div className="detail-field" key={k}>
              <small>{tr(k)}</small>
              <strong>{v}</strong>
            </div>
          ))}
      </div>
      <div className="original-order-items">
        {o.items
          ?.filter((i) => !confirmation.itemId || i.id === confirmation.itemId)
          .map((i) => (
            <div key={i.id}>
              <strong>{i.sku}</strong>
              <span>
                {i.name} × {i.quantity}
              </span>
            </div>
          ))}
      </div>
      {confirmation.manualEvidence && (
        <div className="manual-order-evidence">
          <strong>{tr("Manual purchase evidence")}</strong>
          <p>{confirmation.manualEvidence.reference}</p>
          <small>
            {tr("Manual entry reason")}: {confirmation.manualEvidence.reason}
          </small>
        </div>
      )}
      {confirmation.confirmedAt && (
        <p className="help-text">
          {tr("Confirmed by")} {confirmation.confirmedBy} ·{" "}
          {new Intl.DateTimeFormat(intlLocale(), {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone: s.settings.timezone,
          }).format(new Date(confirmation.confirmedAt))}
        </p>
      )}
    </section>
  );
}
export function OriginalOrderLookup({
  value: v,
  onChange,
  onBusyChange,
  locked = false,
}) {
  const [working, setBusy] = useState(false),
    [error, setError] = useState(""),
    [candidates, setCandidates] = useState([]),
    [selected, setSelected] = useState(""),
    [history, setHistory] = useState(false);
  const busy = working || locked;
  const markBusy = (value) => {
    setBusy(value);
    onBusyChange?.(value);
  };
  const reset = (patch) => {
    setCandidates([]);
    setSelected("");
    setError("");
    onChange({
      ...v,
      ...patch,
      orderConfirmationId: "",
      orderConfirmation: null,
      productId: "",
      platform: "",
    });
  };
  const run = async (operation) => {
    markBusy(true);
    setError("");
    try {
      if (operation === "lookup") {
        onChange({
          ...v,
          orderConfirmationId: "",
          orderConfirmation: null,
          productId: "",
          platform: "",
        });
        setCandidates([]);
        setSelected("");
        const r = await api("/api/original-orders/lookup", {
          method: "POST",
          body: JSON.stringify({
            draftId: v.draftId,
            orderNumber: v.orderNumber,
            paidDate: v.orderPaidDate,
            shop: v.orderShop,
          }),
        });
        setCandidates(r.items);
      } else {
        const [candidateId, itemId] = JSON.parse(selected);
        const r = await api("/api/original-orders/confirm", {
          method: "POST",
          body: JSON.stringify({ draftId: v.draftId, candidateId, itemId }),
        });
        onChange({
          ...v,
          orderConfirmationId: r.confirmationId,
          orderConfirmation: r,
          productId: r.productId,
          platform: r.order.platform,
          rootCauseId: "",
          sn: "",
        });
        setCandidates([]);
      }
    } catch (e) {
      setError(e.message);
      if (operation === "lookup" && e.code === "history_identifier_required")
        setHistory(true);
    } finally {
      markBusy(false);
    }
  };
  return (
    <section
      className="original-order-lookup"
      aria-label={tr("Confirm original order")}
    >
      <div className="support-section-title">
        <h3>{tr("Original order")}</h3>
        {v.orderConfirmationId && (
          <span className="original-order-confirmed">
            {tr("Original order confirmed")}
          </span>
        )}
      </div>
      <div
        className="rma-order-modes"
        role="group"
        aria-label={tr("Order entry method")}
      >
        <Button
          kind={v.orderMode !== "manual" ? "secondary" : "quiet"}
          aria-pressed={v.orderMode !== "manual"}
          disabled={busy}
          onClick={() => {
            if (v.orderMode === "manual") reset({ orderMode: "lookup" });
          }}
        >
          Look up order
        </Button>
        <Button
          kind={v.orderMode === "manual" ? "secondary" : "quiet"}
          aria-pressed={v.orderMode === "manual"}
          disabled={busy}
          onClick={() => {
            if (v.orderMode !== "manual") reset({ orderMode: "manual" });
          }}
        >
          Enter order manually
        </Button>
      </div>
      {v.orderMode === "manual" ? (
        <ManualOrderEntry
          value={v}
          busy={busy}
          onChange={(patch) =>
            reset({ manualOrder: { ...v.manualOrder, ...patch } })
          }
          onNumberChange={(orderNumber) => reset({ orderNumber })}
          onConfirm={async () => {
            markBusy(true);
            setError("");
            try {
              const r = await api("/api/original-orders/manual", {
                method: "POST",
                body: JSON.stringify({
                  ...v.manualOrder,
                  draftId: v.draftId,
                  orderNumber: v.orderNumber,
                }),
              });
              onChange({
                ...v,
                orderConfirmationId: r.confirmationId,
                orderConfirmation: r,
                productId: r.productId,
                platform: r.order.platform,
              });
            } catch (e) {
              setError(e.message);
            } finally {
              markBusy(false);
            }
          }}
        />
      ) : (
        <>
          <p className="help-text">
            {tr(
              "Use the platform order number. Recent orders are checked first, then historical orders. The original order is never modified.",
            )}
          </p>
          <div className="form-grid">
            <label>
              {tr("Platform order number")}
              <input
                value={v.orderNumber}
                required
                maxLength={160}
                disabled={busy}
                onChange={(e) => reset({ orderNumber: e.target.value })}
              />
            </label>
            <div className="original-order-search">
              <Button
                disabled={busy || !v.orderNumber.trim()}
                onClick={() => run("lookup")}
              >
                {busy ? "Looking up order…" : "Look up original order"}
              </Button>
            </div>
          </div>
          {history && (
            <section className="original-order-history">
              <p className="help-text">
                {tr(
                  "Add a payment date to continue the order search. Shop is optional.",
                )}
              </p>
              <div className="form-grid">
                <label>
                  {tr("Payment date (for historical lookup)")}
                  <input
                    type="date"
                    disabled={busy}
                    value={v.orderPaidDate || ""}
                    onChange={(e) => reset({ orderPaidDate: e.target.value })}
                  />
                </label>
                <label>
                  {tr("Shop (optional)")}
                  <input
                    disabled={busy}
                    value={v.orderShop || ""}
                    maxLength={160}
                    onChange={(e) => reset({ orderShop: e.target.value })}
                  />
                </label>
              </div>
              <p className="help-text">
                {tr(
                  "Historical orders require a saved Mabang number mapping or a payment date. Results must match the platform order number exactly.",
                )}
              </p>
            </section>
          )}
        </>
      )}
      {error && (
        <p className="form-error" role="alert">
          {tr(error)}
        </p>
      )}
      {v.orderMode !== "manual" &&
        candidates.map((c) => (
          <section key={c.id} className="original-order-candidate">
            <OriginalOrderSummary confirmation={c} />
            {c.items.map((i) => (
              <label className="original-item-choice" key={i.id}>
                <input
                  type="radio"
                  name="originalItem"
                  disabled={!i.matched || busy}
                  checked={selected === JSON.stringify([c.id, i.id])}
                  onChange={() => setSelected(JSON.stringify([c.id, i.id]))}
                />
                <span>
                  {i.sku} × {i.quantity}
                  {!i.matched && (
                    <small>
                      {tr("Original SKU is not enabled in the catalog")}
                    </small>
                  )}
                </span>
              </label>
            ))}
          </section>
        ))}
      {v.orderMode !== "manual" && candidates.length > 0 && (
        <Button
          kind="primary"
          disabled={busy || !selected}
          onClick={() => run("confirm")}
        >
          Confirm original order and item
        </Button>
      )}
      {v.orderConfirmationId && (
        <>
          <OriginalOrderSummary confirmation={v.orderConfirmation} />
          <Note>
            {tr(
              "Order confirmed. Delivery and activation evidence must be supplied separately; payment and shipment dates do not prove warranty coverage.",
            )}
          </Note>
        </>
      )}
    </section>
  );
}

function ManualOrderEntry({
  value: v,
  busy,
  onChange,
  onNumberChange,
  onConfirm,
}) {
  const { state: s } = useWorkspace(),
    m = v.manualOrder || {};
  const devices = s.products.filter(
    (p) =>
      p.productType === "device" && !/colorbox/i.test(p.sku + " " + p.name),
  );
  const valid =
    v.orderNumber.trim() &&
    m.platform &&
    m.productId &&
    m.paidDate &&
    Number.isInteger(Number(m.quantity)) &&
    Number(m.quantity) > 0 &&
    m.evidenceReference?.trim() &&
    m.entryReason?.trim();
  return (
    <section className="manual-order-entry">
      <p className="help-text">
        {tr(
          "Manual orders are recorded as agent-provided evidence, not verified by Mabang. Warranty checks still apply.",
        )}
      </p>
      <div className="form-grid">
        <label>
          {tr("Platform order number")}
          <input
            value={v.orderNumber}
            disabled={busy}
            required
            maxLength={160}
            onChange={(e) => onNumberChange(e.target.value)}
          />
        </label>
        <label>
          {tr("Purchased platform")}
          <select
            aria-label={tr("Purchased platform")}
            required
            disabled={busy}
            value={m.platform || ""}
            onChange={(e) => onChange({ platform: e.target.value })}
          >
            <option value="">{tr("Choose platform…")}</option>
            {s.supportConfig.platforms
              .filter((p) => p.enabled)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {tr(p.name)}
                </option>
              ))}
          </select>
        </label>
        <label>
          {tr("Original order SKU")}
          <select
            aria-label={tr("Original order SKU")}
            required
            disabled={busy}
            value={m.productId || ""}
            onChange={(e) => onChange({ productId: e.target.value })}
          >
            <option value="">{tr("Choose SKU…")}</option>
            {devices.map((p) => (
              <option key={p.id} value={p.id}>
                {p.sku} · {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {tr("Order quantity")}
          <input
            type="number"
            min={1}
            max={1000000}
            step={1}
            value={m.quantity || ""}
            required
            disabled={busy}
            onChange={(e) => onChange({ quantity: e.target.value })}
          />
        </label>
        <label>
          {tr("Payment date")}
          <input
            type="date"
            value={m.paidDate || ""}
            required
            disabled={busy}
            onChange={(e) => onChange({ paidDate: e.target.value })}
          />
        </label>
        <label>
          {tr("Shop (optional)")}
          <input
            value={m.shop || ""}
            disabled={busy}
            maxLength={160}
            onChange={(e) => onChange({ shop: e.target.value })}
          />
        </label>
        <label className="full-field">
          {tr("Manual purchase evidence")}
          <textarea
            value={m.evidenceReference || ""}
            required
            disabled={busy}
            maxLength={1000}
            rows={2}
            onChange={(e) => onChange({ evidenceReference: e.target.value })}
          />
        </label>
        <label className="full-field">
          {tr("Manual entry reason")}
          <textarea
            value={m.entryReason || ""}
            required
            disabled={busy}
            maxLength={2000}
            rows={2}
            onChange={(e) => onChange({ entryReason: e.target.value })}
          />
        </label>
      </div>
      {!devices.length && (
        <p className="help-text">
          {tr(
            "Enable original order recognition for a SKU in the product catalog before confirming an order.",
          )}
        </p>
      )}
      <Button
        kind="primary"
        disabled={busy || !valid || !!v.orderConfirmationId}
        onClick={onConfirm}
      >
        {busy ? "Saving…" : "Confirm manual order"}
      </Button>
    </section>
  );
}
