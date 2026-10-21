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
          ["Order amount", `${o.currency} ${o.amount}`],
          [
            "Query source",
            tr(
              o.querySource === "history"
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
export function OriginalOrderLookup({ value: v, onChange }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [candidates, setCandidates] = useState([]),
    [selected, setSelected] = useState(""),
    [history, setHistory] = useState(false);
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
    setBusy(true);
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
      if (operation === "lookup") setHistory(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="original-order-lookup"
      aria-label={tr("Confirm original order")}
    >
      <div className="support-section-title">
        <h3>{tr("1. Confirm original order")}</h3>
        {v.orderConfirmationId && (
          <span className="original-order-confirmed">
            {tr("Original order confirmed")}
          </span>
        )}
      </div>
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
      <details
        open={history}
        onToggle={(e) => setHistory(e.currentTarget.open)}
      >
        <summary>{tr("Historical order lookup options")}</summary>
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
      </details>
      {error && (
        <p className="form-error" role="alert">
          {tr(error)}
        </p>
      )}
      {candidates.map((c) => (
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
                    {tr("Not mapped to a supported Morpho device SKU")}
                  </small>
                )}
              </span>
            </label>
          ))}
        </section>
      ))}
      {candidates.length > 0 && (
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
