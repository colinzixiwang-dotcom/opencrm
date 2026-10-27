import { OrderCenter } from "./order-center";
import { LanguageSwitcher } from "./language";
import { tr } from "./i18n";
import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { Provider, useWorkspace, api, title } from "./context";
import { nav, disabledModules, Icon, Button, LoadingState } from "./components";
import { TicketCenter } from "./tickets";
import {
  Overview,
  Purchasing,
  Sales,
  Logistics,
  FBA,
  Advertising,
  Finance,
  Statistics,
  Tools,
} from "./pages";
import {
  RMAs,
  TaskCenter,
  AwaitingDispatch,
  SupportOrders,
  Serials,
  Benefits,
  SupportConfig,
} from "./support";
import { CatalogProducts as Products } from "./catalog";
import { Settings } from "./settings";
import { ModalHost } from "./forms";
import "./style.css";
function Brand({ big = false }) {
  return (
    <div className={"brand " + (big ? "big" : "")}>
      <span className="brand-mark">{tr("H")}</span>
      {tr("harbor")}
      <span className="brand-caption">{tr("ERP")}</span>
    </div>
  );
}
function Login() {
  const { reload, go } = useWorkspace(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [email, setEmail] = useState("admin@harbor.local"),
    [password, setPassword] = useState("");
  const login = async (e, p) => {
    setBusy(true);
    setError("");
    try {
      await api("/api/login", {
        method: "POST",
        body: JSON.stringify({ email: e, password: p }),
      });
      await reload();
      go("home");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="login-page">
      <div className="login-language">
        <LanguageSwitcher />
      </div>
      <section className="login-story">
        <Brand big />
        <div className="login-copy">
          <span className="eyebrow">{tr("EVERY DETAIL. ONE WORKSPACE.")}</span>
          <h1>
            {tr("A clear view.")}
            <br />
            {tr("A steady operation.")}
          </h1>
          <p>
            {tr("Products, purchases, inventory, and profit.")}
            <br />
            {tr("Connected from the first order to the last mile.")}
          </p>
          <div className="login-art">
            <div className="orbit a" />
            <div className="orbit b" />
            {["product", "warehouse", "statistics"].map((n, i) => (
              <div className={"art-box " + ["one", "two", "three"][i]} key={n}>
                <Icon name={n} />
              </div>
            ))}
            <span>{tr("Built around the way your business moves.")}</span>
          </div>
        </div>
        <div className="login-foot">
          {tr("LOCAL WORKSPACE ")}
          <span>·</span>
          {tr(" PERSISTENT SQLITE STORAGE")}
        </div>
      </section>
      <section className="login-panel">
        <div className="login-form-wrap">
          <div className="workspace-tag">
            <span className="online-dot" />
            {tr("Your operations workspace")}
          </div>
          <h2>{tr("Welcome aboard.")}</h2>
          <p className="muted">{tr("Sign in to your Harbor workspace.")}</p>
          <form
            id="login-form"
            onSubmit={(e) => {
              e.preventDefault();
              login(email, password);
            }}
          >
            <label>
              {tr("Email address")}
              <input
                name="email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label>
              {tr("Password")}
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {error && <p className="form-error">{tr(error)}</p>}
            <button className="btn primary wide" disabled={busy}>
              {tr("Open workspace ")}
              <Icon name="arrow" />
            </button>
          </form>
          <div className="demo-login">
            <strong>{tr("Explore the working example")}</strong>
            <p>
              {tr("Example records are ready. Every change is saved locally.")}
            </p>
            <div className="demo-roles">
              {["admin", "operator", "analyst"].map((r) => (
                <button
                  key={r}
                  data-demo={r}
                  disabled={busy}
                  onClick={() => login(r + "@harbor.local", "HarborDemo!2026")}
                >
                  {r === "admin" ? tr("Administrator") : title(r)}
                </button>
              ))}
            </div>
            <small>
              {tr("Demo password: ")}
              <code>{tr("HarborDemo!2026")}</code>
            </small>
          </div>
          <p className="login-note">
            {tr(
              "An independent implementation inspired by Lingxing ERP research.",
            )}
            <br />
            {tr("Marketplace connections are not configured.")}
          </p>
        </div>
      </section>
    </main>
  );
}
const views = {
  orders: OrderCenter,
  rma: RMAs,
  rmatasks: TaskCenter,
  rmalogistics: AwaitingDispatch,
  supportorders: SupportOrders,
  serials: Serials,
  benefits: Benefits,
  rmaconfig: SupportConfig,
  home: Overview,
  product: Products,
  sales: Sales,
  purchase: Purchasing,
  logistics: Logistics,
  fba: FBA,
  advertising: Advertising,
  service: TicketCenter,
  finance: Finance,
  statistics: Statistics,
  tools: Tools,
  settings: Settings,
};
function App() {
  const {
      state: s,
      loading,
      error,
      page,
      go,
      reload,
      notify,
      setState,
    } = useWorkspace(),
    [mobile, setMobile] = useState(false),
    [search, setSearch] = useState(""),
    [routeSearch, setRouteSearch] = useState({ page: "", query: "", key: 0 });
  useEffect(() => {
    if (page === "warehouse") go("product");
  }, [page, go]);
  useEffect(() => {
    const key = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        document.querySelector("#global-search")?.focus();
      }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);
  if (loading)
    return (
      <main className="workspace-loading">
        <LoadingState label="Opening workspace…" variant="detail" rows={4} />
      </main>
    );
  if (!s)
    return (
      <>
        {error && <p className="form-error">{tr(error)}</p>}
        <Login />
      </>
    );
  const codes = s.permissionCodes || [],
    permitted = (p) =>
      codes.includes("*:*:*") || codes.includes("erp:" + p + ":view"),
    menus = (s.menus || [])
      .filter((m) => m.menuType === "C" && m.visible === "0")
      .sort((a, b) => a.orderNum - b.orderNum),
    navigation = menus
      .map((m) => [m.url, m.url === "service" ? "Ticket center" : m.menuName])
      .filter(([p]) => !disabledModules.has(p))
      .filter(([p]) => Object.hasOwn(views, p)),
    View = Object.hasOwn(views, page) ? views[page] : null,
    allowed =
      permitted(page) &&
      (page !== "orders" ||
        codes.includes("*:*:*") ||
        codes.includes("erp:orders:list") ||
        codes.includes("erp:orders:search"));
  const navigate = (p) => {
    if (disabledModules.has(p)) return;
    setMobile(false);
    setRouteSearch({ page: "", query: "", key: routeSearch.key + 1 });
    go(p);
  };
  const find = (e) => {
    if (e.key !== "Enter" || !search.trim()) return;
    const q = search.trim(),
      t = q.toLowerCase();
    let p = "product";
    if (
      (s.rmas || []).some((x) =>
        [x.id, x.ticketNumber, x.orderNumber].some((v) =>
          v.toLowerCase().includes(t),
        ),
      )
    )
      p = "rma";
    else if ((s.serials || []).some((x) => x.sn.toLowerCase().includes(t)))
      p = "serials";
    else if (
      (s.benefitHistory || []).some((x) => x.code.toLowerCase().includes(t))
    )
      p = "benefits";
    else if (
      (s.supportOrders || []).some((x) =>
        x.orderNumber.toLowerCase().includes(t),
      )
    )
      p = "supportorders";
    else if (s.purchases.some((x) => x.id.toLowerCase().includes(t)))
      p = "purchase";
    else if (
      s.sales.some(
        (x) =>
          x.id.toLowerCase().includes(t) ||
          x.customer.toLowerCase().includes(t),
      )
    )
      p = "sales";
    else if (s.shipments.some((x) => x.id.toLowerCase().includes(t)))
      p = "logistics";
    setRouteSearch({ page: p, query: q, key: routeSearch.key + 1 });
    go(p);
  };
  return (
    <div className="app-shell">
      <aside className={"sidebar " + (mobile ? "mobile-open" : "")}>
        <a
          href={"#" + (navigation[0]?.[0] || "home")}
          onClick={() => navigate(navigation[0]?.[0] || "home")}
        >
          <Brand />
        </a>
        <div className="workspace-switch">
          <span className="workspace-avatar">
            {s.settings.company.slice(0, 1)}
          </span>
          <div>
            <strong>{s.settings.company}</strong>
            <small>{tr("Operations workspace")}</small>
          </div>
        </div>
        <span className="nav-caption">{tr("WORKSPACE")}</span>
        <nav aria-label={tr("Main navigation")}>
          {navigation.map(([id, label]) => (
            <a
              key={id}
              href={disabledModules.has(id) ? undefined : "#" + id}
              role={disabledModules.has(id) ? "link" : undefined}
              aria-disabled={disabledModules.has(id) || undefined}
              title={
                disabledModules.has(id) ? tr("Temporarily disabled") : undefined
              }
              className={
                "nav-item " +
                (disabledModules.has(id)
                  ? "disabled"
                  : page === id
                    ? "active"
                    : "")
              }
              aria-current={page === id ? "page" : undefined}
              onClick={() => navigate(id)}
            >
              <Icon name={id} />
              <span>{tr(label)}</span>
              {!disabledModules.has(id) &&
                id === "purchase" &&
                s.purchases.some((x) => x.status === "pending") && (
                  <span className="nav-count">
                    {s.purchases.filter((x) => x.status === "pending").length}
                  </span>
                )}
            </a>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-status">
            <span className="online-dot" />
            {tr("Local workspace")}
            <small>{tr("Changes saved automatically")}</small>
          </div>
          <div className="sidebar-profile">
            <span className="user-avatar">
              {s.currentUser.name
                .split(" ")
                .map((x) => x[0])
                .join("")}
            </span>
            <div>
              <strong>{s.currentUser.name}</strong>
              <small>{s.currentUser.roles.map(title).join(", ")}</small>
            </div>
            <button
              className="icon-button"
              aria-label={tr("Sign out")}
              onClick={async () => {
                try {
                  await api("/api/logout", { method: "POST", body: "{}" });
                  setState(null);
                } catch (e) {
                  notify(e.message, "error");
                }
              }}
            >
              <Icon name="logout" />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <button
            className="mobile-nav icon-button"
            aria-label={tr("Toggle navigation")}
            onClick={() => setMobile(!mobile)}
          >
            <Icon name="filter" />
          </button>
          <div className="breadcrumb">
            {tr("Workspace ")}
            <span>/</span>
            <strong>
              {tr(nav.find((x) => x[0] === page)?.[1] || tr("Access"))}
            </strong>
          </div>
          <div className="topbar-right">
            <LanguageSwitcher />
            <label className="global-search">
              <Icon name="search" />
              <input
                id="global-search"
                aria-label={tr("Search workspace")}
                placeholder={tr("Find a product or order…")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={find}
              />
              <kbd>↵</kbd>
            </label>
            <span className="environment-badge">{tr("Example data")}</span>
            <button
              className="icon-button"
              aria-label={tr("Refresh workspace")}
              onClick={() => {
                if (page === "service")
                  window.dispatchEvent(new window.Event("udesk:refresh"));
                reload()
                  .then(() => notify("Workspace refreshed."))
                  .catch((e) => notify(e.message, "error"));
              }}
            >
              <Icon name="refresh" />
            </button>
          </div>
        </header>
        <main id="main-content" className="main-content">
          {disabledModules.has(page) ? (
            <section className="panel permission-empty">
              <h1>{tr("Temporarily disabled")}</h1>
              <p>{tr("This module is temporarily unavailable.")}</p>
              <Button onClick={() => navigate("service")}>
                {tr("Ticket center")}
              </Button>
            </section>
          ) : View && allowed ? (
            <View
              key={page + "-" + routeSearch.key}
              query={routeSearch.page === page ? routeSearch.query : ""}
            />
          ) : (
            <section className="panel permission-empty">
              <h1>{tr("Access restricted")}</h1>
              <p>{tr("Your roles do not grant access to this page.")}</p>
              {navigation[0] && (
                <Button onClick={() => navigate(navigation[0][0])}>
                  {tr("Open ")}
                  {tr(navigation[0][1])}
                </Button>
              )}
            </section>
          )}
          <footer className="main-footer">
            <span>
              {tr("Harbor ERP ")}
              <span>·</span>
              {tr(" Independent local implementation")}
            </span>
            <span>
              {tr("Saved in PostgreSQL · ")}
              {s.settings.timezone}
            </span>
          </footer>
        </main>
      </div>
      <ModalHost />
    </div>
  );
}
class WorkspaceBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <main className="main-content">
          <section className="panel permission-empty" role="alert">
            <h1>{tr("Workspace could not be displayed")}</h1>
            <p>
              {tr(
                "Your saved records are intact. Reload the workspace to try again.",
              )}
            </p>
            <button className="btn primary" onClick={() => location.reload()}>
              {tr("Reload workspace")}
            </button>
            <a
              className="btn secondary"
              href="#home"
              onClick={() => {
                location.hash = "home";
                location.reload();
              }}
            >
              {tr("Return to overview")}
            </a>
          </section>
        </main>
      );
    return this.props.children;
  }
}
createRoot(document.getElementById("root")).render(
  <WorkspaceBoundary>
    <Provider>
      <App />
    </Provider>
  </WorkspaceBoundary>,
);
