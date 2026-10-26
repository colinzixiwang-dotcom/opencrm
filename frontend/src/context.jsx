import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
} from "react";
import {
  tr,
  statusTitle,
  intlLocale,
  getLanguage,
  setLanguage,
  subscribeLanguage,
} from "./i18n";
import { normalizeWorkspace } from "./state";
import { newId } from "./ids";
export const Workspace = createContext(null);
export const useWorkspace = () => useContext(Workspace);
export const money = (c) =>
  new Intl.NumberFormat(intlLocale(), {
    style: "currency",
    currency: "USD",
  }).format((c || 0) / 100);
export const num = (n) => new Intl.NumberFormat(intlLocale()).format(n || 0);
export const title = statusTitle;
export const total = (o) =>
  (o.lines || []).reduce((n, l) => n + l.qty * l.unitCents, 0);
export const today = (zone = "Asia/Shanghai") =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
export const formatDate = (v, zone = "Asia/Shanghai") =>
  v
    ? new Intl.DateTimeFormat(intlLocale(), {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: zone,
      }).format(new Date(v.length === 10 ? v + "T12:00:00Z" : v))
    : "—";
export async function api(path, options = {}) {
  const r = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const data = await r.json();
  if (!r.ok) {
    const e = new Error(data.error || "Request failed.");
    e.status = r.status;
    e.code = data.code;
    e.lastSyncAt = data.lastSyncAt;
    throw e;
  }
  return data;
}
export function Provider({ children }) {
  const [language, updateLanguage] = useState(getLanguage);
  useEffect(() => {
    document.documentElement.lang = language;
    document.title =
      language === "zh-CN" ? "Harbor · 售后与运营" : "Harbor ERP";
  }, [language]);
  useEffect(() => subscribeLanguage(() => updateLanguage(getLanguage())), []);
  const [state, setState] = useState(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notifications, setNotifications] = useState([]),
    [modal, setModal] = useState(null),
    [busy, setBusy] = useState(false),
    [page, setPage] = useState(location.hash.slice(1).split("?")[0] || "home"),
    [period, setPeriod] = useState("30"),
    [filters, setFilters] = useState({ from: "", to: "", channel: "all" }),
    [report, setReport] = useState(null);
  const notify = useCallback((message, type = "success") => {
    const id = newId();
    setNotifications((n) => [...n, { id, message, type }]);
    setTimeout(
      () => setNotifications((n) => n.filter((x) => x.id !== id)),
      5000,
    );
  }, []);
  const reload = useCallback(async () => {
    try {
      const s = normalizeWorkspace(await api("/api/bootstrap"));
      setState(s);
      setReport(s.report);
      return s;
    } catch (e) {
      if (e.status === 401) setState(null);
      throw e;
    }
  }, []);
  useEffect(() => {
    reload()
      .catch((e) => {
        if (e.status !== 401) setError(e.message);
      })
      .finally(() => setLoading(false));
  }, [reload]);
  useEffect(() => {
    const change = () =>
      setPage(location.hash.slice(1).split("?")[0] || "home");
    addEventListener("hashchange", change);
    return () => removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    if (!state) return;
    const grants = state.permissionCodes || [];
    if (
      !grants.includes("*:*:*") &&
      !["home", "finance", "statistics"].some((x) =>
        grants.includes(`erp:${x}:view`),
      )
    ) {
      setReport(state.report);
      return;
    }
    let f = filters;
    if (period !== "custom") {
      const to = today(state.settings.timezone),
        d = new Date(to + "T12:00:00Z");
      d.setUTCDate(d.getUTCDate() - (period === "7" ? 6 : 29));
      f = {
        from: period === "all" ? "" : d.toISOString().slice(0, 10),
        to: period === "all" ? "" : to,
        channel: "all",
      };
    }
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) params.set(k, v);
    let cancelled = false;
    api("/api/report?" + params)
      .then((r) => {
        if (!cancelled) setReport(r);
      })
      .catch((e) => {
        if (!cancelled) notify(e.message, "error");
      });
    return () => {
      cancelled = true;
    };
  }, [state, period, filters, notify]);
  const acting = useRef(false),
    retry = useRef(null);
  const act = async (action, payload, message = "Record saved.") => {
    if (acting.current) return false;
    acting.current = true;
    setBusy(true);
    try {
      const signature = JSON.stringify({ action, payload });
      if (retry.current?.signature !== signature)
        retry.current = { signature, key: newId() };
      await api("/api/action", {
        method: "POST",
        headers: { "Idempotency-Key": retry.current.key },
        body: JSON.stringify({ action, payload }),
      });
      await reload();
      retry.current = null;
      setModal(null);
      notify(message);
      return true;
    } catch (e) {
      if (e.status === 401) setState(null);
      throw e;
    } finally {
      acting.current = false;
      setBusy(false);
    }
  };
  const go = (p) => {
    location.hash = p;
    setPage(p);
  };
  const can = (a) => state?.permissions?.includes(a) || false;
  const value = {
    language,
    setLanguage,
    state,
    setState,
    loading,
    error,
    reload,
    notify,
    modal,
    setModal,
    busy,
    act,
    page,
    go,
    can,
    period,
    setPeriod,
    filters,
    setFilters,
    report: report || state?.report,
  };
  return (
    <Workspace.Provider value={value}>
      {children}
      <div id="toasts" aria-live="polite">
        {notifications.map((n) => (
          <div key={n.id} className={"toast " + n.type}>
            {tr(n.message)}
          </div>
        ))}
      </div>
    </Workspace.Provider>
  );
}
