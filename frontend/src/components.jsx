import { tr } from "./i18n";
import React, { useState, useMemo } from "react";
import { paths } from "./icons";
import { useWorkspace, title, money, num, formatDate } from "./context";
export const nav = [
  ["home", "Overview"],
  ["rma", "RMAs"],
  ["rmatasks", "Task center"],
  ["rmalogistics", "Awaiting dispatch"],
  ["supportorders", "Support orders"],
  ["serials", "Serial numbers"],
  ["benefits", "Cards & promo codes"],
  ["rmaconfig", "Support configuration"],
  ["product", "Product"],
  ["sales", "Sales"],
  ["fba", "FBA"],
  ["purchase", "Purchase"],
  ["warehouse", "Warehouse"],
  ["logistics", "Logistics"],
  ["advertising", "Advertising"],
  ["service", "Ticket center"],
  ["finance", "Finance"],
  ["statistics", "Statistics"],
  ["tools", "Tools"],
  ["settings", "Settings"],
];
export const disabledModules = new Set([
  "fba",
  "advertising",
  "finance",
  "statistics",
  "tools",
  "sales",
  "purchase",
]);
export const info = {
  rma: [
    "Return merchandise authorizations",
    "Every case, its solution, and the work needed to resolve it.",
  ],
  rmatasks: [
    "Support task center",
    "Review approvals and coordinate each step of every RMA.",
  ],
  rmalogistics: [
    "Awaiting dispatch",
    "A focused queue for replacements, parts, and returns that have not shipped.",
  ],
  supportorders: [
    "Support order search",
    "Find purchases across platforms and connect them to customer care.",
  ],
  serials: [
    "Serial number registry",
    "Trace devices and printheads by serial, SKU, and order.",
  ],
  benefits: [
    "Gift cards & promo codes",
    "A searchable history of recorded customer goodwill.",
  ],
  rmaconfig: [
    "Support configuration",
    "Configure solutions, approvals, root causes, and custom fields.",
  ],
  home: [
    "Your operation, at a glance.",
    "A connected view of sales, stock, and the work ahead.",
  ],
  product: ["Product catalog", "The details behind every product you sell."],
  sales: ["Sales orders", "From confirmed demand to fulfilled orders."],
  fba: ["Fulfillment", "Keep your marketplace stock moving."],
  purchase: [
    "Purchasing",
    "Plan, approve, order, and receive with confidence.",
  ],
  warehouse: ["Inventory", "Know what’s available, reserved, and on the move."],
  logistics: ["Logistics", "Track every transfer from departure to arrival."],
  advertising: [
    "Advertising",
    "Record campaign performance and keep spending in view.",
  ],
  service: [
    "Ticket center",
    "A clear queue for questions, issues, and returns.",
  ],
  finance: ["Finance", "Reconcile costs, payments, and operating results."],
  statistics: [
    "Performance",
    "Turn operating activity into a clearer picture.",
  ],
  tools: [
    "Operations tools",
    "Small tools that keep the bigger picture on track.",
  ],
  settings: [
    "Workspace settings",
    "Your company, warehouses, and access controls.",
  ],
};
export const Icon = ({ name, className = "" }) => (
  <svg
    className={"icon " + className}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={paths[name] || paths.product} />
  </svg>
);
export const Badge = ({ value }) => (
  <span className={"badge " + value}>
    <i />
    {title(value)}
  </span>
);
export function Button({ children, onClick, kind = "quiet", ...props }) {
  return (
    <button
      type="button"
      className={"btn " + kind}
      onClick={onClick}
      {...props}
    >
      {React.Children.map(children, (child) =>
        typeof child === "string" ? tr(child) : child,
      )}
    </button>
  );
}
export function NewButton({ label, type, permission, initial }) {
  const { can, setModal } = useWorkspace();
  return can(permission) ? (
    <Button
      kind="primary"
      data-form={type}
      onClick={() => setModal({ type, initial })}
    >
      <Icon name="plus" />
      {tr(label)}
    </Button>
  ) : null;
}
export const Export = ({ collection }) => (
  <a className="btn secondary" href={"/api/export/" + collection} download>
    <Icon name="download" />
    {tr("Export")}
  </a>
);
export function Heading({ children, page: override }) {
  const { page } = useWorkspace();
  const p = override || page;
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">
          {p === "home"
            ? tr("OPERATIONS / OVERVIEW")
            : tr("WORKSPACE") +
              " / " +
              tr(nav.find((x) => x[0] === p)?.[1] || p)}
        </div>
        <h1>{tr(info[p]?.[0])}</h1>
        <p>{tr(info[p]?.[1])}</p>
      </div>
      <div className="heading-actions">{children}</div>
    </div>
  );
}
export const Panel = ({ children, className = "" }) => (
  <section className={"panel " + className}>{children}</section>
);
export const PanelHeading = ({ title, subtitle, children }) => (
  <div className="panel-heading">
    <div>
      <h2>{tr(title)}</h2>
      {subtitle && <p>{tr(subtitle)}</p>}
    </div>
    {children}
  </div>
);
export const Tabs = ({ items, value, onChange }) => (
  <div className="tabs" role="tablist">
    {items.map(([key, label, count]) => (
      <button
        key={key}
        className={"tab " + (key === value ? "active" : "")}
        role="tab"
        aria-selected={key === value}
        onClick={() => onChange(key)}
      >
        {tr(label)}
        {count != null && <span>{count}</span>}
      </button>
    ))}
  </div>
);
export const Note = ({ children, icon = "check" }) => (
  <div className="info-strip">
    <Icon name={icon} />
    {children}
  </div>
);
export const Stat = ({
  label,
  value,
  caption,
  featured = false,
  icon = "statistics",
}) => (
  <article className={"stat-card " + (featured ? "featured" : "")}>
    <div className="stat-label">
      {tr(label)}
      <span>
        <Icon name={icon} />
      </span>
    </div>
    <div className="stat-value">{value}</div>
    <div className="stat-caption">{tr(caption)}</div>
  </article>
);
export function ProductCell({ product }) {
  const { state } = useWorkspace();
  if (!product) return "—";
  return (
    <div className="product-cell">
      <span
        className={"product-swatch c" + (state.products.indexOf(product) % 6)}
      >
        <Icon name="product" />
      </span>
      <div>
        <strong>{product.name}</strong>
        <small>{product.sku}</small>
      </div>
    </div>
  );
}
export function DocCell({ record }) {
  const { state } = useWorkspace();
  return (
    <>
      <strong className="mono document-id">{record.id}</strong>
      <small className="cell-sub">
        {formatDate(record.createdAt, state.settings.timezone)}
      </small>
    </>
  );
}
export function Chart({ report }) {
  const values = report.daily.length
      ? report.daily.map((x) => x.revenueCents)
      : [0, 0],
    max = Math.max(...values, 1),
    xs = (i) => 30 + (i * 705) / (values.length - 1 || 1),
    ys = (v) => 160 - (v / max) * 140,
    points = values.map((v, i) => `${xs(i)},${ys(v)}`).join(" ");
  return (
    <svg
      className="revenue-chart"
      viewBox="0 0 800 225"
      role="img"
      aria-label={tr("Revenue by shipping date")}
    >
      <defs>
        <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#347d64" stopOpacity=".22" />
          <stop offset="100%" stopColor="#347d64" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0, 1, 2, 3].map((i) => (
        <g key={i}>
          <line
            x1="30"
            y1={25 + i * 45}
            x2="750"
            y2={25 + i * 45}
            stroke="#e9eeeb"
            strokeDasharray="4 5"
          />
          <text x="758" y={29 + i * 45} fill="#65765e" fontSize="10">
            {money(Math.round(max * (1 - i / 3)))}
          </text>
        </g>
      ))}
      <polygon
        points={`${xs(0)},160 ${points} ${xs(values.length - 1)},160`}
        fill="url(#chart-fill)"
      />
      <polyline
        points={points}
        fill="none"
        stroke="#347d64"
        strokeWidth="2.5"
      />
      {values.map((v, i) => (
        <circle
          key={i}
          cx={xs(i)}
          cy={ys(v)}
          r="3.2"
          fill="white"
          stroke="#347d64"
          strokeWidth="2"
        >
          <title>
            {report.daily[i]?.date}: {money(v)}
          </title>
        </circle>
      ))}
      {report.daily
        .filter(
          (_, i) =>
            i === 0 ||
            i === report.daily.length - 1 ||
            i % Math.ceil(report.daily.length / 5) === 0,
        )
        .map((d) => (
          <text
            key={d.date}
            x={xs(report.daily.indexOf(d))}
            y="204"
            fill="#65765e"
            fontSize="11"
          >
            {d.date.slice(5)}
          </text>
        ))}
    </svg>
  );
}
export function Period() {
  const { period, setPeriod } = useWorkspace();
  return (
    <select
      id="period-select"
      aria-label={tr("Reporting period")}
      value={period}
      onChange={(e) => setPeriod(e.target.value)}
    >
      <option value="30">{tr("Last 30 days")}</option>
      <option value="7">{tr("Last 7 days")}</option>
      <option value="all">{tr("All time")}</option>
      {period === "custom" && (
        <option value="custom">{tr("Custom range")}</option>
      )}
    </select>
  );
}
// Shared list controls keep local and remote work queues visually consistent.
export function ListToolbar({ children, actions }) {
  return (
    <div className="table-toolbar list-toolbar">
      <div className="list-controls">{children}</div>
      {actions && <div className="toolbar-right">{actions}</div>}
    </div>
  );
}
export function SearchControl({
  value,
  onChange,
  label = "Search records",
  placeholder = "Search records…",
  id,
  required = false,
}) {
  return (
    <label className="search-field">
      <Icon name="search" />
      <input
        id={id}
        aria-label={tr(label)}
        placeholder={tr(placeholder)}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
      />
    </label>
  );
}
export function FilterControl({
  value,
  onChange,
  label = "Filter status",
  options = [],
  disabled = false,
  id,
  icon = "filter",
}) {
  return (
    <label className="filter-select">
      <Icon name={icon} />
      <select
        id={id}
        aria-label={tr(label)}
        title={tr(label)}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {tr(o.label)}
          </option>
        ))}
      </select>
    </label>
  );
}
export function SortControl(props) {
  return <FilterControl {...props} label={props.label || "Sort records"} />;
}
export function LoadingState({
  label = "Loading…",
  variant = "list",
  rows = 5,
}) {
  return (
    <div
      className={"loading-state loading-" + variant}
      role="status"
      aria-label={tr(label)}
      aria-live="polite"
    >
      <div className="loading-caption">
        <span className="loading-spinner" aria-hidden="true" />
        <span>{tr(label)}</span>
      </div>
      <div className="loading-skeleton" aria-hidden="true">
        {Array.from({ length: rows }, (_, i) => (
          <div className="skeleton-row" key={i}>
            <span className="skeleton-avatar" />
            <div>
              <span className="skeleton-line" />
              <span className="skeleton-line skeleton-short" />
            </div>
            <span className="skeleton-pill" />
          </div>
        ))}
      </div>
    </div>
  );
}
export function Pagination({
  page,
  totalPages,
  onPrevious,
  onNext,
  hasNext,
  disabled = false,
  context,
  label = "Pagination",
}) {
  const total = totalPages == null ? null : Math.max(1, totalPages);
  return (
    <nav className="pagination" aria-label={tr(label)}>
      {context && <span className="pagination-context">{context}</span>}
      <div className="pagination-controls">
        <button
          type="button"
          className="pagination-button"
          aria-label={tr("Previous")}
          disabled={disabled || page <= 1}
          onClick={onPrevious}
        >
          <span aria-hidden="true">‹</span>
          {tr("Previous")}
        </button>
        <span className="pagination-position" aria-live="polite">
          <strong>{tr("Page {page}", { page })}</strong>
          <span className="pagination-divider">/</span>
          <span>
            {total == null
              ? tr("Total pages pending")
              : tr("{total} pages total", { total })}
          </span>
        </span>
        <button
          type="button"
          className="pagination-button"
          aria-label={tr("Next")}
          disabled={disabled || !(hasNext ?? (total != null && page < total))}
          onClick={onNext}
        >
          {tr("Next")}
          <span aria-hidden="true">›</span>
        </button>
      </div>
    </nav>
  );
}
export function Table({
  columns,
  rows,
  empty = "No records yet.",
  search = true,
  statuses = [],
  initialQuery = "",
  idKey = "id",
  limit,
}) {
  const { state } = useWorkspace();
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState(initialQuery),
    [status, setStatus] = useState("all"),
    [sort, setSort] = useState({ key: "", dir: 1 });
  const list = useMemo(() => {
    let out = rows.filter(
      (r) =>
        (status === "all" || r.status === status) &&
        (!query ||
          JSON.stringify(r).toLowerCase().includes(query.toLowerCase()) ||
          r.lines?.some((l) => {
            const p = state.products.find((p) => p.id === l.productId);
            return (
              p &&
              (p.name + " " + p.sku).toLowerCase().includes(query.toLowerCase())
            );
          })),
    );
    if (sort.key)
      out = [...out].sort(
        (a, b) =>
          (typeof a[sort.key] === "number"
            ? a[sort.key] - b[sort.key]
            : String(a[sort.key] ?? "").localeCompare(
                String(b[sort.key] ?? ""),
              )) * sort.dir,
      );
    return limit ? out.slice(0, limit) : out;
  }, [rows, status, query, sort, limit, state.products]);
  const pageSize = limit || 20;
  const totalPages = Math.max(1, Math.ceil(list.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const visible = list.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );
  return (
    <>
      {search && (
        <ListToolbar
          actions={
            <>
              {statuses.length > 0 && (
                <FilterControl
                  id="status-filter"
                  value={status}
                  onChange={(v) => {
                    setStatus(v);
                    setPage(1);
                  }}
                  options={[
                    { value: "all", label: "All statuses" },
                    ...statuses.map((s) => ({ value: s, label: title(s) })),
                  ]}
                />
              )}
              <SortControl
                value={sort.key ? sort.key + ":" + sort.dir : ""}
                onChange={(v) => {
                  const [key, dir] = v.split(":");
                  setSort({ key, dir: Number(dir) || 1 });
                }}
                options={[
                  { value: "", label: "Default order" },
                  ...columns
                    .filter((c) => c.key)
                    .flatMap((c) => [
                      { value: c.key + ":1", label: tr(c.label) + " ↑" },
                      { value: c.key + ":-1", label: tr(c.label) + " ↓" },
                    ]),
                ]}
              />
              <span className="table-context">
                <Icon name="check" />
                {tr("Saved locally")}
              </span>
            </>
          }
        >
          <SearchControl id="record-search" value={query} onChange={setQuery} />
        </ListToolbar>
      )}
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {columns.map((c, i) => (
                <th
                  key={i}
                  tabIndex={c.key ? 0 : undefined}
                  role={c.key ? "button" : undefined}
                  aria-label={tr(c.key ? "Sort by " + c.label : undefined)}
                  onClick={() =>
                    c.key &&
                    setSort({
                      key: c.key,
                      dir: sort.key === c.key ? -sort.dir : 1,
                    })
                  }
                  onKeyDown={(e) => {
                    if (c.key && ["Enter", " "].includes(e.key)) {
                      e.preventDefault();
                      setSort({
                        key: c.key,
                        dir: sort.key === c.key ? -sort.dir : 1,
                      });
                    }
                  }}
                >
                  {tr(c.label)}
                  {c.key && (
                    <span className="sort-indicator">
                      {sort.key === c.key ? (sort.dir === 1 ? "↑" : "↓") : "↕"}
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.length ? (
              visible.map((r, i) => (
                <tr key={r[idKey] ?? i} data-row-id={r[idKey]}>
                  {columns.map((c, j) => (
                    <td key={j}>{c.render(r)}</td>
                  ))}
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={columns.length}>
                  <div className="empty-state">
                    <Icon name="product" />
                    <strong>{tr(empty)}</strong>
                    <p>
                      {query || status !== "all"
                        ? tr("Try clearing your search or filters.")
                        : tr("Create your first record to get started.")}
                    </p>
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Pagination
        page={currentPage}
        totalPages={totalPages}
        onPrevious={() => setPage(currentPage - 1)}
        onNext={() => setPage(currentPage + 1)}
        context={tr("{count} records", { count: list.length })}
      />
    </>
  );
}
export function Transition({
  action,
  id,
  status,
  children,
  kind = "small primary",
}) {
  const { can, act, notify, setModal } = useWorkspace();
  if (!can(action)) return null;
  return (
    <Button
      kind={kind}
      onClick={() => {
        if (status === "cancelled") {
          setModal({
            type: "confirm",
            title: "Cancel this document?",
            description:
              "Reserved stock will be released where applicable. The record stays in the audit trail.",
            confirm: () =>
              act(action, { id, status }, "Document cancelled.").catch((e) =>
                notify(e.message, "error"),
              ),
          });
        } else
          act(action, { id, status }, "Status updated.").catch((e) =>
            notify(e.message, "error"),
          );
      }}
    >
      {children}
    </Button>
  );
}
export function FormButton({ type, id, permission, children, kind = "small" }) {
  const { can, setModal } = useWorkspace();
  return !permission || can(permission) ? (
    <Button kind={kind} data-form={type} onClick={() => setModal({ type, id })}>
      {children}
    </Button>
  ) : null;
}
