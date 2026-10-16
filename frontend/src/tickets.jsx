import React, { useCallback, useEffect, useRef, useState } from "react";
import { api, useWorkspace } from "./context";
import { tr } from "./i18n";
import { Heading, Panel, Button, PanelHeading } from "./components";
import { RMAForm } from "./support";

const text = (value) =>
  value == null
    ? "—"
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
const plain = (value) =>
  new window.DOMParser().parseFromString(String(value || ""), "text/html").body
    .textContent || "";
const safeURL = (value) => {
  try {
    const u = new URL(value);
    return ["https:", "http:"].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
};
function Value({ value, field }) {
  if (value == null || value === "") return <span className="muted">—</span>;
  const options = [];
  const visit = (list) =>
    (list || []).forEach((o) => {
      options.push(o);
      visit(o.subs);
    });
  visit(field?.options);
  if (options.length) {
    const values = Array.isArray(value) ? value : [value];
    return values
      .map(
        (v) =>
          options.find((o) => String(o.value) === String(v))?.title ?? text(v),
      )
      .join(" / ");
  }
  if (
    Array.isArray(value) &&
    value.some((v) => v && typeof v === "object" && v.url)
  ) {
    return (
      <div>
        {value.map((v, i) =>
          safeURL(v.url) ? (
            <a
              key={v.id || i}
              href={safeURL(v.url)}
              target="_blank"
              rel="noreferrer"
            >
              {v.name || v.file_name || tr("Attachment")}
            </a>
          ) : (
            <span key={i}>{text(v)}</span>
          ),
        )}
      </div>
    );
  }
  return <span>{text(value)}</span>;
}
const labels = {
  field_num: "Ticket number",
  subject: "Subject",
  content: "Content",
  user_name: "Customer",
  user_email: "Email address",
  user_cellphone: "Phone",
  assignee_name: "Assignee",
  user_group_name: "Agent group",
  template_id: "Template",
  status: "Status",
  status_en: "English status",
  priority: "Priority",
  platform: "Channel",
  tags: "Tags",
  created_at: "Created",
  updated_at: "Updated",
  solved_deadline: "Due date",
  attachments: "Attachments",
};
function Fields({ ticket, metadata }) {
  if (!metadata) return <p>{tr("Loading Udesk field definitions…")}</p>;
  const fields = metadata?.fields?.fields || [];
  const template = (metadata?.templates?.templates || []).find(
    (t) => String(t.id) === String(ticket.template_id),
  );
  const names = new Set([
    ...fields.map((f) => f.field_name),
    ...(template?.custom_fields || []).map((f) => f.field_name),
    ...Object.keys(ticket.custom_fields || {}),
  ]);
  return (
    <>
      <PanelHeading title="Ticket fields" />
      <dl className="ticket-fields">
        {Object.entries(ticket)
          .filter(([key]) => !["custom_fields", "content"].includes(key))
          .map(([key, value]) => (
            <div key={key}>
              <dt>
                {tr(labels[key] || key)}
                <small>{key}</small>
              </dt>
              <dd>
                <Value value={value} />
              </dd>
            </div>
          ))}
      </dl>
      <PanelHeading
        title="Custom fields"
        subtitle="Field names, types and values come from Udesk."
      />
      <dl className="ticket-fields">
        {[...names].map((name) => {
          const field = fields.find((f) => f.field_name === name);
          const definition = template?.custom_fields?.find(
            (f) => f.field_name === name,
          );
          return (
            <div key={name}>
              <dt>
                {field?.field_label || definition?.field_title || name}
                <small>
                  {name} · {field?.content_type || definition?.field_type || ""}
                </small>
              </dt>
              <dd>
                <Value field={field} value={ticket.custom_fields?.[name]} />
              </dd>
            </div>
          );
        })}
      </dl>
    </>
  );
}
function TicketDetail({ id, metadata, onClose, onDraft }) {
  const { can } = useWorkspace();
  const [data, setData] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [replies, setReplies] = useState(null),
    [replyPage, setReplyPage] = useState(1),
    [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new window.AbortController();
    setError("");
    setBusy(true);
    setData(null);
    api(`/api/tickets/${encodeURIComponent(id)}`, { signal: controller.signal })
      .then(setData)
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [id, refresh]);
  useEffect(() => {
    if (!data) return;
    const controller = new window.AbortController();
    setReplies(null);
    api(`/api/tickets/${encodeURIComponent(id)}/replies?page=${replyPage}`, {
      signal: controller.signal,
    })
      .then(setReplies)
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => controller.abort();
  }, [id, data, replyPage]);
  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const t = data.source,
        payload = {
          ticketNumber: t.field_num,
          description: plain(t.content).slice(0, 4000),
        };
      const fields = metadata?.fields?.fields || [];
      for (const [label, key] of [
        ["Order Number", "orderNumber"],
        ["Product Serial Number", "sn"],
      ]) {
        const field = fields.find((f) => f.field_label === label);
        const value = field && t.custom_fields?.[field.field_name];
        if (typeof value === "string") payload[key] = value;
      }
      const draft = await api(`/api/tickets/${encodeURIComponent(id)}/drafts`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      onDraft(draft);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="ticket-detail panel" aria-label={tr("Ticket details")}>
      <div className="ticket-toolbar">
        <Button onClick={onClose}>Back to tickets</Button>
        <Button disabled={busy} onClick={() => setRefresh((x) => x + 1)}>
          Refresh ticket
        </Button>
        {data && (
          <a
            className="btn secondary"
            target="_blank"
            rel="noreferrer"
            href={data.udeskUrl}
          >
            {tr("Open in Udesk")}
          </a>
        )}
        {data && can("rma.create") && (
          <Button kind="primary" disabled={busy || !metadata} onClick={create}>
            Create RMA draft
          </Button>
        )}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {tr(error)}
        </p>
      )}
      {!data ? (
        <p>
          {tr(busy ? "Loading Udesk ticket…" : "Ticket could not be loaded.")}
        </p>
      ) : (
        <>
          <p className="muted">
            {tr("Fetched from Udesk")}: {data.fetchedAt}
          </p>
          <h2>
            {data.source.field_num} · {data.source.subject}
          </h2>
          <div className="ticket-content">{plain(data.source.content)}</div>
          {data.rmaIds?.length > 0 && (
            <p>
              {tr("Linked RMAs")}: {data.rmaIds.join(", ")}
            </p>
          )}
          <Fields ticket={data.source} metadata={metadata} />
          <PanelHeading
            title="Conversation"
            subtitle="Read only. Reply and edit in Udesk."
          />
          {replies ? (
            <>
              <div className="ticket-conversation">
                {(replies.replies || []).map((r) => (
                  <article key={r.id}>
                    <div>
                      <strong>
                        {r.author?.nick_name || r.author?.user_type}
                      </strong>
                      <span>
                        {r.created_at} ·{" "}
                        {tr(
                          ["internat", "internal"].includes(r.function_type)
                            ? "Internal note"
                            : "External reply",
                        )}
                      </span>
                    </div>
                    <p>
                      {r.content_format === "html"
                        ? plain(r.content)
                        : r.content}
                    </p>
                    <Value value={r.attachments} />
                  </article>
                ))}
              </div>
              <div className="ticket-toolbar">
                <Button
                  disabled={replyPage === 1}
                  onClick={() => setReplyPage((n) => n - 1)}
                >
                  Previous
                </Button>
                <span>
                  {tr("Page")} {replyPage}
                </span>
                <Button
                  disabled={replyPage >= (replies.meta?.total_pages || 1)}
                  onClick={() => setReplyPage((n) => n + 1)}
                >
                  Next
                </Button>
              </div>
            </>
          ) : (
            <p>{tr("Loading conversation…")}</p>
          )}
        </>
      )}
    </section>
  );
}
export function TicketCenter() {
  const { can } = useWorkspace();
  const [metadata, setMetadata] = useState(null),
    [data, setData] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [filter, setFilter] = useState(""),
    [cursor, setCursor] = useState(""),
    [history, setHistory] = useState([]),
    [refresh, setRefresh] = useState(0),
    [selected, setSelected] = useState(null),
    [number, setNumber] = useState(""),
    [draft, setDraft] = useState(null),
    [drafts, setDrafts] = useState([]),
    [lastSync, setLastSync] = useState("");
  const latest = useRef(0);
  useEffect(() => {
    const controller = new window.AbortController();
    api("/api/tickets/metadata?refresh=true", { signal: controller.signal })
      .then(setMetadata)
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => controller.abort();
  }, [refresh]);
  const loadDrafts = useCallback(() => {
    if (can("rma.create"))
      api("/api/intake-drafts")
        .then((v) => setDrafts(v.items))
        .catch(() => {});
  }, [can]);
  useEffect(() => {
    loadDrafts();
  }, [refresh]); // Reload own drafts after saving or closing.
  useEffect(() => {
    const controller = new window.AbortController();
    const version = ++latest.current;
    setBusy(true);
    setError("");
    setData(null);
    const params = new URLSearchParams({ filterId: filter, cursor });
    api("/api/tickets?" + params, { signal: controller.signal })
      .then((v) => {
        if (version === latest.current) {
          setData(v);
          setLastSync(v.fetchedAt);
        }
      })
      .catch((e) => {
        if (e.name !== "AbortError" && version === latest.current) {
          setError(e.message);
          if (e.lastSyncAt) setLastSync(e.lastSyncAt);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && version === latest.current)
          setBusy(false);
      });
    return () => controller.abort();
  }, [filter, cursor, refresh]);
  useEffect(() => {
    const update = () => {
      setSelected(null);
      setRefresh((v) => v + 1);
    };
    addEventListener("udesk:refresh", update);
    return () => removeEventListener("udesk:refresh", update);
  }, []);
  const lookup = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const v = await api(
        "/api/tickets/lookup?" + new URLSearchParams({ number }),
      );
      setSelected(String(v.source.id));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const resume = async (id) => {
    setError("");
    try {
      setDraft(await api(`/api/intake-drafts/${encodeURIComponent(id)}`));
    } catch (e) {
      setError(e.message);
    }
  };
  return (
    <>
      <Heading>
        <Button
          disabled={busy}
          onClick={() => {
            setSelected(null);
            setRefresh((v) => v + 1);
          }}
        >
          Refresh
        </Button>
      </Heading>
      <p className="muted">
        {tr(
          "Udesk is the source of truth. Edit tickets in Udesk; create RMAs here.",
        )}
      </p>
      {error && (
        <div className="ticket-sync-error" role="alert">
          <strong>{tr("Udesk refresh failed")}</strong>
          <p>{tr(error)}</p>
          <p>
            {tr("Last successful sync")}:{" "}
            {lastSync || tr("Not yet synchronized")}
          </p>
        </div>
      )}
      {selected ? (
        <TicketDetail
          key={selected}
          id={selected}
          metadata={metadata}
          onClose={() => {
            setSelected(null);
            setRefresh((v) => v + 1);
          }}
          onDraft={setDraft}
        />
      ) : (
        <Panel>
          <div className="ticket-toolbar">
            <label>
              {tr("Udesk filter")}
              <select
                aria-label={tr("Udesk filter")}
                value={filter}
                disabled={!metadata || busy}
                onChange={(e) => {
                  setFilter(e.target.value);
                  setCursor("");
                  setHistory([]);
                }}
              >
                <option value="">{tr("All authorized tickets")}</option>
                {(metadata?.filters || []).map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </label>
            <form onSubmit={lookup}>
              <label>
                {tr("Find ticket by number")}
                <input
                  value={number}
                  onChange={(e) => setNumber(e.target.value)}
                  placeholder="#848"
                  required
                />
              </label>
              <button className="btn secondary" disabled={busy}>
                {tr("Find")}
              </button>
            </form>
            <a
              className="btn secondary"
              download
              href={
                "/api/export/tickets?" +
                new URLSearchParams({ filterId: filter, cursor })
              }
            >
              {tr("Export authorized page")}
            </a>
          </div>
          <p className="muted ticket-filter-note">
            {tr(
              "Filters are maintained in Udesk. Personal filters use the integration account; your CRM access scope is always applied.",
            )}
          </p>
          {busy && <p role="status">{tr("Fetching tickets from Udesk…")}</p>}
          {!busy && data && (
            <>
              <p className="muted">
                {tr("Fetched from Udesk")}: {data.fetchedAt}
              </p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      {[
                        "Ticket",
                        "Subject / customer",
                        "Assignee / group",
                        "Status",
                        "Priority",
                        "Channel",
                        "Updated",
                        "Linked RMAs",
                      ].map((label) => (
                        <th key={label}>{tr(label)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((item) => {
                      const t = item.source;
                      return (
                        <tr key={t.id}>
                          <td>
                            <button
                              className="text-button"
                              onClick={() => setSelected(String(t.id))}
                            >
                              {t.field_num}
                            </button>
                          </td>
                          <td>
                            <strong>{t.subject}</strong>
                            <small className="cell-sub">
                              {t.user_name || t.user_email}
                            </small>
                          </td>
                          <td>
                            {t.assignee_name || "—"}
                            <small className="cell-sub">
                              {t.user_group_name}
                            </small>
                          </td>
                          <td>{t.status}</td>
                          <td>{t.priority}</td>
                          <td>{t.platform}</td>
                          <td>{t.updated_at}</td>
                          <td>{item.rmaIds.join(", ") || "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {!data.items.length && (
                <p>{tr("No authorized tickets on this source page.")}</p>
              )}
              {data.scanLimited && (
                <p className="muted">
                  {tr(
                    "More source pages remain. Continue to find additional authorized tickets.",
                  )}
                </p>
              )}
              <div className="ticket-toolbar">
                <Button
                  disabled={!history.length}
                  onClick={() => {
                    setCursor(history.at(-1));
                    setHistory(history.slice(0, -1));
                  }}
                >
                  Previous
                </Button>
                <span>
                  {tr("Page")} {history.length + 1}
                </span>
                <Button
                  disabled={!data.nextCursor}
                  onClick={() => {
                    setHistory([...history, cursor]);
                    setCursor(data.nextCursor);
                  }}
                >
                  Next
                </Button>
              </div>
            </>
          )}
        </Panel>
      )}
      {can("rma.create") && drafts.length > 0 && (
        <Panel>
          <PanelHeading title="Your RMA drafts" />
          <div className="ticket-toolbar">
            {drafts.map(({ draft: d }) => (
              <Button key={d.id} onClick={() => resume(d.id)}>
                {d.id} · {d.updatedAt}
              </Button>
            ))}
          </div>
        </Panel>
      )}
      {draft && (
        <RMAForm
          initial={draft.payload}
          duplicateRmaIds={draft.duplicateRmaIds || []}
          onClose={() => {
            setDraft(null);
            setRefresh((v) => v + 1);
          }}
        />
      )}
    </>
  );
}
export function UdeskAccounts() {
  const { state, reload } = useWorkspace();
  const [data, setData] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const isAdmin = state.currentUser.roles.includes("admin");
  const load = () => api("/api/integrations/udesk/accounts").then(setData);
  useEffect(() => {
    if (isAdmin) load().catch((e) => setError(e.message));
  }, [isAdmin]);
  const sync = async () => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const v = await api("/api/integrations/udesk/accounts/sync", {
        method: "POST",
        body: JSON.stringify({ resetPasswords: false }),
      });
      setMessage(tr("Udesk accounts synchronized") + `: ${v.accounts}`);
      await load();
      await reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const save = async (mapping, scope, groups) => {
    setBusy(true);
    setError("");
    try {
      await api("/api/integrations/udesk/accounts/configure", {
        method: "POST",
        body: JSON.stringify({ agentId: mapping.agentId, scope, groups }),
      });
      await load();
      await reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  if (!isAdmin)
    return <p>{tr("Only administrators can manage Udesk mappings.")}</p>;
  return (
    <Panel>
      <PanelHeading title="Udesk accounts & access">
        <Button disabled={busy} onClick={sync}>
          Synchronize accounts
        </Button>
      </PanelHeading>
      <p className="muted">
        {tr(
          "Source account status is synchronized. Group access requires explicit authorization.",
        )}
      </p>
      {error && <p className="form-error">{tr(error)}</p>}
      {message && <p role="status">{message}</p>}
      {data && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {[
                  "User",
                  "Udesk agent ID",
                  "Source role",
                  "Status",
                  "Access scope",
                  "Authorized groups",
                ].map((label) => (
                  <th key={label}>{tr(label)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.mappings.map((m) => (
                <tr key={m.agentId}>
                  <td>
                    {m.name}
                    <small className="cell-sub">{m.email}</small>
                  </td>
                  <td>{m.agentId}</td>
                  <td>{m.sourceRole}</td>
                  <td>{tr(m.enabled ? "Active" : "Disabled")}</td>
                  <td>
                    <select
                      disabled={busy}
                      value={m.scope}
                      onChange={(e) =>
                        save(m, e.target.value, JSON.parse(m.groups || "[]"))
                      }
                    >
                      <option value="own">{tr("Own tickets")}</option>
                      <option value="group">{tr("Authorized groups")}</option>
                    </select>
                  </td>
                  <td>
                    <div className="ticket-group-options">
                      {(data.groups || []).map((g) => (
                        <label key={g.id}>
                          <input
                            type="checkbox"
                            disabled={busy || m.scope !== "group"}
                            checked={JSON.parse(m.groups || "[]").includes(
                              String(g.id),
                            )}
                            onChange={(e) => {
                              const current = JSON.parse(m.groups || "[]");
                              save(
                                m,
                                m.scope,
                                e.target.checked
                                  ? [...current, String(g.id)]
                                  : current.filter((id) => id !== String(g.id)),
                              );
                            }}
                          />
                          {g.name}
                        </label>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
