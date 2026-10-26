import React, { useState, useEffect, useRef } from "react";
import { api, useWorkspace } from "./context";
import { tr, intlLocale } from "./i18n";
import {
  Heading,
  Panel,
  Button,
  SearchControl,
  SortControl,
  Pagination,
  LoadingState,
} from "./components";
import { OriginalOrderSummary } from "./original-order";
const orderStatus = {
  AwaitingShipment: "Awaiting shipment",
  Shipped: "Shipped",
  Completed: "Completed",
  Voided: "Voided",
  Unknown: "Unknown",
  1: "Unpaid",
  2: "Awaiting shipment",
  3: "Shipped",
  4: "Completed",
  5: "Voided",
};
function OrderDetail({ id, onClose }) {
  const [result, setResult] = useState(null),
    [error, setError] = useState("");
  const ref = useRef();
  useEffect(() => {
    ref.current.showModal();
    const controller = new window.AbortController();
    api(`/api/orders/${encodeURIComponent(id)}`, { signal: controller.signal })
      .then(setResult)
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => controller.abort();
  }, [id]);
  return (
    <dialog
      ref={ref}
      className="modal support-dialog wide order-detail-dialog"
      aria-label={tr("Order details")}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <header className="modal-header">
        <div>
          <span className="eyebrow">{tr("Order center")}</span>
          <h2>{result?.order.platformNumber || tr("Order details")}</h2>
          <p>{tr("Live order from Mabang. Read-only.")}</p>
        </div>
        <Button onClick={onClose}>Close</Button>
      </header>
      <div className="modal-body">
        {error ? (
          <p role="alert" className="form-error">
            {tr(error)}
          </p>
        ) : result ? (
          <OriginalOrderSummary confirmation={{ order: result.order }} />
        ) : (
          <LoadingState
            label="Loading order details…"
            variant="detail"
            rows={5}
          />
        )}
      </div>
    </dialog>
  );
}
export function OrderCenter() {
  const { state } = useWorkspace(),
    codes = state.permissionCodes || [];
  const has = (cap) =>
    codes.includes("*:*:*") || codes.includes(`erp:orders:${cap}`);
  const list = has("list"),
    search = has("search"),
    detail = has("detail");
  const [page, setPage] = useState(1),
    [sort, setSort] = useState("paid_desc"),
    [number, setNumber] = useState(""),
    [searchNumber, setSearchNumber] = useState(""),
    [data, setData] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState(""),
    [jobs, setJobs] = useState([]),
    [sync, setSync] = useState(null),
    [tick, setTick] = useState(0);
  const lastRevision = useRef("");
  const queryPath = useRef("");
  useEffect(() => {
    if (!list && !searchNumber) {
      setData(null);
      return;
    }
    const controller = new window.AbortController();
    const path = searchNumber
      ? `/api/orders/search?number=${encodeURIComponent(searchNumber)}`
      : `/api/orders?page=${page}&sort=${sort}`;
    const changed = queryPath.current !== path;
    queryPath.current = path;
    if (changed) { setBusy(true); setData(null); }
    setError("");
    api(path, { signal: controller.signal })
      .then(setData)
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [list, page, sort, searchNumber, tick]);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api("/api/orders/status")
        .then((v) => {
          if (!alive) return;
          setJobs(v.jobs || []);
          setSync(v);
          if (v.indexRevision && lastRevision.current && v.indexRevision !== lastRevision.current && list && !searchNumber)
            setTick((t) => t + 1);
          lastRevision.current = v.indexRevision || "";
        })
        .catch(() => {});
    load();
    const timer = window.setInterval(load, 10000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [list, searchNumber]);
  const job = jobs[0];
  return (
    <>
      <Heading subtitle="Find original orders and inspect their source information." />
      {sync && (
        <section className="order-index-status" aria-label={tr("Order synchronization status")}>
          <div>
            <strong>{tr("Last successful order sync")}: {sync.lastSuccessfulSyncAt
              ? new Intl.DateTimeFormat(intlLocale(), { dateStyle: "medium", timeStyle: "medium", timeZone: "Asia/Shanghai" }).format(new Date(sync.lastSuccessfulSyncAt))
              : "—"}</strong>
            <p>{tr("Latest completed backfill; continuous order synchronization is not enabled.")}</p>
          </div>
        </section>
      )}
      {job && (
        <section className="order-index-status">
          <div>
            <strong>
              {tr(
                job.status === "completed"
                  ? "Order index ready"
                  : job.status === "failed"
                    ? "Order backfill interrupted"
                    : "Order backfill in progress",
              )}
            </strong>
            <p>
              {job.fromDate} — {job.toDate} · {job.completedDays}{" "}
              {tr("days completed")} · {job.rows.toLocaleString()}{" "}
              {tr("source rows processed")}
            </p>
            {job.status !== "completed" && (
              <small>
                {tr("Current payment date")}: {job.currentDate}
              </small>
            )}
            {job.error && (
              <p className="form-error" role="alert">
                {tr(job.error)}
              </p>
            )}
          </div>
          <span>
            {tr("Updated at")}:{" "}
            {new Intl.DateTimeFormat(intlLocale(), {
              dateStyle: "medium",
              timeStyle: "medium",
              timeZone: "Asia/Shanghai",
            }).format(new Date(job.updatedAt))}
          </span>
        </section>
      )}
      <Panel className="order-center-panel">
        <div className="list-toolbar order-center-toolbar">
          {search && (
            <form
              className="order-center-search"
              onSubmit={(e) => {
                e.preventDefault();
                if (number.trim()) {
                  setPage(1);
                  setSearchNumber(number.trim());
                  setTick((t) => t + 1);
                }
              }}
            >
              <SearchControl
                value={number}
                onChange={setNumber}
                label="Platform order number"
                placeholder="Enter exact platform order number…"
                required
              />
              <Button
                kind="primary"
                disabled={busy || !number.trim()}
                type="submit"
              >
                Search order
              </Button>
            </form>
          )}
          {list && (
            <div className="order-center-sort">
              {searchNumber && (
                <Button
                  onClick={() => {
                    setSearchNumber("");
                    setNumber("");
                    setPage(1);
                  }}
                >
                  All orders
                </Button>
              )}
              {!searchNumber && (
                <SortControl
                  value={sort}
                  onChange={(v) => {
                    setSort(v);
                    setPage(1);
                  }}
                  options={[
                    { value: "paid_desc", label: "Payment time: newest first" },
                    { value: "paid_asc", label: "Payment time: oldest first" },
                    {
                      value: "indexed_desc",
                      label: "Indexed time: newest first",
                    },
                  ]}
                />
              )}
            </div>
          )}
        </div>
        {error && (
          <p className="form-error order-center-error" role="alert">
            {tr(error)}
          </p>
        )}
        {busy ? (
          <LoadingState label="Loading orders…" />
        ) : data ? (
          <>
            <div className="table-wrap">
              <table className="data-table order-center-table">
                <thead>
                  <tr>
                    {[
                      "Platform order number",
                      "Shop",
                      "Purchased platform",
                      "Payment time",
                      "Order status",
                      "Query source",
                    ].map((x) => (
                      <th key={x}>{tr(x)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((o) => (
                    <tr key={o.id}>
                      <td data-label={tr("Platform order number")}>
                        {detail ? (
                          <button
                            className="order-number-link"
                            onClick={() => setSelected(o.id)}
                          >
                            {o.platformNumber || o.sourceNumber}
                          </button>
                        ) : (
                          <strong>{o.platformNumber || o.sourceNumber}</strong>
                        )}
                        <small>
                          {tr("Mabang order number")}: {o.sourceNumber}
                        </small>
                      </td>
                      <td data-label={tr("Shop")}>{o.shop || "—"}</td>
                      <td data-label={tr("Purchased platform")}>
                        {o.platform || "—"}
                      </td>
                      <td data-label={tr("Payment time")}>{o.paidAt || "—"}</td>
                      <td data-label={tr("Order status")}>
                        <span className="catalog-status">
                          {tr(orderStatus[o.status] || o.status || "—")}
                        </span>
                      </td>
                      <td data-label={tr("Query source")}>
                        {tr(
                          o.querySource === "history"
                            ? "Historical orders"
                            : "Recent orders",
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!data.items.length && (
                <div className="empty-state">{tr("No matching orders.")}</div>
              )}
            </div>
            {!searchNumber && list ? (
              <Pagination
                page={page}
                totalPages={data.totalPages}
                onPrevious={() => setPage((v) => v - 1)}
                onNext={() => setPage((v) => v + 1)}
                context={tr("{count} orders", { count: data.total })}
              />
            ) : (
              <p className="order-center-result-count">
                {tr("{count} orders", { count: data.total })}
              </p>
            )}
          </>
        ) : (
          !error && (
            <div className="empty-state">
              {tr(
                list
                  ? "Order data is initializing."
                  : "Enter a platform order number to search. Order list access is not enabled for your account.",
              )}
            </div>
          )
        )}
      </Panel>
      {selected && detail && (
        <OrderDetail id={selected} onClose={() => setSelected("")} />
      )}
    </>
  );
}
