import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { Provider, useWorkspace, api, title } from "./context";
import { nav, Icon, Button } from "./components";
import {
  Overview,
  Products,
  Purchasing,
  Sales,
  Inventory,
  Logistics,
  FBA,
  Advertising,
  Service,
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
import { Settings } from "./settings";
import { ModalHost } from "./forms";
import "./style.css";
function Brand({ big = false }) {
  return (
    <div className={"brand " + (big ? "big" : "")}>
      <span className="brand-mark">H</span>harbor
      <span className="brand-caption">ERP</span>
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
      <section className="login-story">
        <Brand big />
        <div className="login-copy">
          <span className="eyebrow">EVERY DETAIL. ONE WORKSPACE.</span>
          <h1>
            A clear view.
            <br />A steady operation.
          </h1>
          <p>
            Products, purchases, inventory, and profit.
            <br />
            Connected from the first order to the last mile.
          </p>
          <div className="login-art">
            <div className="orbit a" />
            <div className="orbit b" />
            {["product", "warehouse", "statistics"].map((n, i) => (
              <div className={"art-box " + ["one", "two", "three"][i]} key={n}>
                <Icon name={n} />
              </div>
            ))}
            <span>Built around the way your business moves.</span>
          </div>
        </div>
        <div className="login-foot">
          LOCAL WORKSPACE <span>·</span> PERSISTENT SQLITE STORAGE
        </div>
      </section>
      <section className="login-panel">
        <div className="login-form-wrap">
          <div className="workspace-tag">
            <span className="online-dot" />
            Your operations workspace
          </div>
          <h2>Welcome aboard.</h2>
          <p className="muted">Sign in to your Harbor workspace.</p>
          <form
            id="login-form"
            onSubmit={(e) => {
              e.preventDefault();
              login(email, password);
            }}
          >
            <label>
              Email address
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
              Password
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {error && <p className="form-error">{error}</p>}
            <button className="btn primary wide" disabled={busy}>
              Open workspace <Icon name="arrow" />
            </button>
          </form>
          <div className="demo-login">
            <strong>Explore the working example</strong>
            <p>Example records are ready. Every change is saved locally.</p>
            <div className="demo-roles">
              {["admin", "operator", "analyst"].map((r) => (
                <button
                  key={r}
                  data-demo={r}
                  disabled={busy}
                  onClick={() => login(r + "@harbor.local", "HarborDemo!2026")}
                >
                  {r === "admin" ? "Administrator" : title(r)}
                </button>
              ))}
            </div>
            <small>
              Demo password: <code>HarborDemo!2026</code>
            </small>
          </div>
          <p className="login-note">
            An independent implementation inspired by Lingxing ERP research.
            <br />
            Marketplace connections are not configured.
          </p>
        </div>
      </section>
    </main>
  );
}
const views = {
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
  warehouse: Inventory,
  logistics: Logistics,
  fba: FBA,
  advertising: Advertising,
  service: Service,
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
    const key = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        document.querySelector("#global-search")?.focus();
      }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, []);
  if (loading) return <main className="login-panel">Opening workspace…</main>;
  if (!s)
    return (
      <>
        {error && <p className="form-error">{error}</p>}
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
      .map((m) => [m.url, m.menuName])
      .filter(([p]) => Object.hasOwn(views, p)),
    View = Object.hasOwn(views, page) ? views[page] : null,
    allowed = permitted(page);
  const navigate = (p) => {
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
            <small>Operations workspace</small>
          </div>
        </div>
        <span className="nav-caption">WORKSPACE</span>
        <nav aria-label="Main navigation">
          {navigation.map(([id, label]) => (
            <a
              key={id}
              href={"#" + id}
              className={"nav-item " + (page === id ? "active" : "")}
              aria-current={page === id ? "page" : undefined}
              onClick={() => navigate(id)}
            >
              <Icon name={id} />
              <span>{label}</span>
              {id === "purchase" &&
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
            Local workspace<small>Changes saved automatically</small>
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
              aria-label="Sign out"
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
            aria-label="Toggle navigation"
            onClick={() => setMobile(!mobile)}
          >
            <Icon name="filter" />
          </button>
          <div className="breadcrumb">
            Workspace <span>/</span>
            <strong>{nav.find((x) => x[0] === page)?.[1] || "Access"}</strong>
          </div>
          <div className="topbar-right">
            <label className="global-search">
              <Icon name="search" />
              <input
                id="global-search"
                aria-label="Search workspace"
                placeholder="Find a product or order…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={find}
              />
              <kbd>↵</kbd>
            </label>
            <span className="environment-badge">Example data</span>
            <button
              className="icon-button"
              aria-label="Refresh workspace"
              onClick={() =>
                reload()
                  .then(() => notify("Workspace refreshed."))
                  .catch((e) => notify(e.message, "error"))
              }
            >
              <Icon name="refresh" />
            </button>
          </div>
        </header>
        <main id="main-content" className="main-content">
          {View && allowed ? (
            <View
              key={page + "-" + routeSearch.key}
              query={routeSearch.page === page ? routeSearch.query : ""}
            />
          ) : (
            <section className="panel permission-empty">
              <h1>Access restricted</h1>
              <p>Your roles do not grant access to this page.</p>
              {navigation[0] && (
                <Button onClick={() => navigate(navigation[0][0])}>
                  Open {navigation[0][1]}
                </Button>
              )}
            </section>
          )}
          <footer className="main-footer">
            <span>
              Harbor ERP <span>·</span> Independent local implementation
            </span>
            <span>Saved in SQLite · {s.settings.timezone}</span>
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
            <h1>Workspace could not be displayed</h1>
            <p>
              Your saved records are intact. Reload the workspace to try again.
            </p>
            <button className="btn primary" onClick={() => location.reload()}>
              Reload workspace
            </button>
            <a
              className="btn secondary"
              href="#home"
              onClick={() => {
                location.hash = "home";
                location.reload();
              }}
            >
              Return to overview
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
