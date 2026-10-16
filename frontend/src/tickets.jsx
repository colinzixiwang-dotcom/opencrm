import React, { useCallback, useEffect, useRef, useState } from "react";
import { api, useWorkspace } from "./context";
import { tr } from "./i18n";
import {
  Heading,
  Panel,
  Button,
  PanelHeading,
  ListToolbar,
  SearchControl,
  FilterControl,
  SortControl,
  Icon,
} from "./components";
import { RMAForm } from "./support";

const text = (value) =>
  value == null
    ? "—"
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
const plain = (value) => {
  const doc = new window.DOMParser().parseFromString(
    String(value || ""),
    "text/html",
  );
  doc
    .querySelectorAll("script,style,noscript")
    .forEach((node) => node.remove());
  doc
    .querySelectorAll("br")
    .forEach((node) => node.replaceWith(doc.createTextNode("\n")));
  doc
    .querySelectorAll("p,div,li")
    .forEach((node) => node.append(doc.createTextNode("\n")));
  return (doc.body.textContent || "").trim();
};
const safeURL = (value) => {
  try {
    const u = new URL(value);
    return ["https:", "http:"].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
};
const displayDate = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
};
function Value({ value, field }) {
  if (typeof value === "boolean")
    return <span>{tr(value ? "Yes" : "No")}</span>;
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
  agent_emails_count: "Agent email count",
  agent_replied_at: "Agent last replied",
  agent_summary: "Agent summary",
  assignee_avatar: "Agent avatar",
  call_result: "Call result",
  call_type: "Call type",
  content_type: "Content format",
  conversation_id: "Conversation ID",
  creator_id: "Created by",
  customer_emails_count: "Customer email count",
  customer_owner_group_id: "Customer owner group ID",
  customer_owner_group_name: "Customer owner group",
  customer_owner_id: "Customer owner ID",
  customer_owner_name: "Customer owner",
  customer_replied_at: "Customer last replied",
  customer_telephone: "Customer telephone",
  email_reply_status: "Email reply status",
  emails_count: "Email count",
  first_replied_at: "First replied",
  followers: "Followers",
  im_sub_session_id: "Chat session ID",
  is_associated: "Associated ticket",
  knowledge_catalog: "Knowledge category",
  knowledge_question: "Knowledge question",
  last_closed_operator_name: "Last closed by",
  organization_id: "Organization ID",
  participate_handling_robots: "Participating bots",
  reminder_count: "Reminder count",
  replied_by: "Last replied by",
  resolved_at: "Resolved at",
  robot_summary: "Bot summary",
  satisfaction: "Satisfaction",
  solving_at: "Processing started",
  source: "Source",
  survey_vote_desc: "Survey feedback",
  survey_vote_tags: "Survey tags",
  ticket_category: "Ticket category",
  ticket_category_name: "Ticket category name",
  timers: "Timers",
  unexecuted_alarm_count: "Pending reminders",
  updator_id: "Updated by",
  has_reminder: "Has reminder",

  id: "Udesk ticket ID",
  assignee_id: "Agent ID",
  user_id: "Customer ID",
  user_group_id: "Agent group ID",
  url: "Ticket link",
  solved_at: "Solved at",
  closed_at: "Closed at",
  replied_at: "Last reply",
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
const hasValue = (value) =>
  value != null &&
  (typeof value === "string"
    ? value.trim() !== "" && !["—", "-"].includes(value.trim())
    : Array.isArray(value)
      ? value.some(hasValue)
      : typeof value === "object"
        ? Object.values(value).some(hasValue)
        : true);
const friendly = (key) =>
  key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
function Fields({ ticket, metadata }) {
  if (!metadata) return <p>{tr("Loading Udesk field definitions…")}</p>;
  const fields = metadata?.fields?.fields || [];
  const template = (metadata?.templates?.templates || []).find(
    (t) => String(t.id) === String(ticket.template_id),
  );
  const standard = Object.entries(ticket)
    .sort(([a], [b]) => {
      const order = [
        "user_name",
        "user_email",
        "user_cellphone",
        "assignee_name",
        "user_group_name",
        "status",
        "priority",
        "platform",
        "created_at",
        "updated_at",
      ];
      return (
        (order.includes(a) ? order.indexOf(a) : 99) -
        (order.includes(b) ? order.indexOf(b) : 99)
      );
    })
    .filter(
      ([key, value]) =>
        !["custom_fields", "content", "subject", "status_en"].includes(key) &&
        hasValue(value),
    );
  const technical = standard.filter(
    ([key]) =>
      key === "id" ||
      key.endsWith("_id") ||
      [
        "content_type",
        "has_reminder",
        "reminder_count",
        "creator_id",
        "updator_id",
      ].includes(key),
  );
  const business = standard.filter((entry) => !technical.includes(entry));
  const renderField = ([key, value]) => (
    <div key={key}>
      <dt>{tr(labels[key] || friendly(key))}</dt>
      <dd>
        <Value
          value={
            key === "template_id"
              ? template?.name || template?.title || value
              : /(_at|_deadline)$/.test(key)
                ? displayDate(value)
                : value
          }
        />
      </dd>
    </div>
  );
  const custom = Object.entries(ticket.custom_fields || {}).filter(
    ([, value]) => hasValue(value),
  );
  return (
    <>
      <section className="ticket-field-section">
        <PanelHeading title="Ticket fields" />
        <dl className="ticket-fields">{business.map(renderField)}</dl>
        {technical.length > 0 && (
          <details className="ticket-technical">
            <summary>{tr("More ticket information")}</summary>
            <dl className="ticket-fields">{technical.map(renderField)}</dl>
          </details>
        )}
      </section>
      {custom.length > 0 && (
        <section className="ticket-field-section">
          <PanelHeading title="Custom fields" />
          <dl className="ticket-fields">
            {custom.map(([name, value]) => {
              const field = fields.find((f) => f.field_name === name),
                definition = template?.custom_fields?.find(
                  (f) => f.field_name === name,
                );
              return (
                <div key={name}>
                  <dt>
                    {field?.field_label ||
                      definition?.field_title ||
                      friendly(name)}
                  </dt>
                  <dd>
                    <Value field={field} value={value} />
                  </dd>
                </div>
              );
            })}
          </dl>
        </section>
      )}
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
          <header className="ticket-detail-header">
            <div className="ticket-kicker">
              <span>
                {tr("Ticket")} {data.source.field_num}
              </span>
              <span className="ticket-status">{data.source.status}</span>
              <span>{data.source.platform}</span>
            </div>
            <h2>{data.source.subject}</h2>
            <div className="ticket-detail-meta">
              {[
                data.source.user_name,
                data.source.assignee_name,
                data.source.updated_at && displayDate(data.source.updated_at),
              ]
                .filter(hasValue)
                .map((v, i) => (
                  <span key={i}>{v}</span>
                ))}
            </div>
          </header>
          <div className="ticket-detail-layout">
            <div className="ticket-main-column">
              {hasValue(plain(data.source.content)) && (
                <section className="ticket-story">
                  <PanelHeading title="Content" />
                  <div className="ticket-content">
                    {plain(data.source.content)}
                  </div>
                </section>
              )}
              {data.rmaIds?.length > 0 && (
                <p className="ticket-rma-links">
                  {tr("Linked RMAs")}: {data.rmaIds.join(", ")}
                </p>
              )}
              <section className="ticket-thread">
                <PanelHeading
                  title="Conversation"
                  subtitle="Read only. Reply and edit in Udesk."
                />
                {replies ? (
                  <>
                    <div className="ticket-conversation">
                      {!replies.replies?.length && (
                        <p className="ticket-empty-conversation">
                          {tr("No conversation yet.")}
                        </p>
                      )}
                      {(replies.replies || []).map((r) => (
                        <article key={r.id}>
                          <div>
                            <strong>
                              {r.author?.nick_name || r.author?.user_type}
                            </strong>
                            <span>
                              {displayDate(r.created_at)} ·{" "}
                              {tr(
                                ["internat", "internal"].includes(
                                  r.function_type,
                                )
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
                          {hasValue(r.attachments) && (
                            <Value value={r.attachments} />
                          )}
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
              </section>
            </div>
            <aside className="ticket-sidebar">
              <Fields ticket={data.source} metadata={metadata} />
              <p className="ticket-sync-stamp">
                {tr("Fetched from Udesk")}
                <br />
                {new Date(data.fetchedAt).toLocaleString()}
              </p>
            </aside>
          </div>
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
    [selected, updateSelected] = useState(() =>
      new URLSearchParams(location.hash.split("?")[1]).get("ticket"),
    ),
    [query, setQuery] = useState(""),
    [sort, setSort] = useState("updated_at:desc"),
    [number, setNumber] = useState(""),
    [draft, setDraft] = useState(null),
    [drafts, setDrafts] = useState([]),
    [lastSync, setLastSync] = useState("");
  const setSelected = (id) => {
    location.hash = id ? "service?ticket=" + encodeURIComponent(id) : "service";
    updateSelected(id);
  };
  useEffect(() => {
    const change = () =>
      updateSelected(
        new URLSearchParams(location.hash.split("?")[1]).get("ticket"),
      );
    addEventListener("hashchange", change);
    return () => removeEventListener("hashchange", change);
  }, []);
  const items = [...(data?.items || [])]
    .filter(
      (item) =>
        !query ||
        JSON.stringify(item.source).toLowerCase().includes(query.toLowerCase()),
    )
    .sort((a, b) => {
      const [key, dir] = sort.split(":");
      return (
        String(a.source[key] ?? "").localeCompare(
          String(b.source[key] ?? ""),
          undefined,
          { numeric: true },
        ) * (dir === "desc" ? -1 : 1)
      );
    });
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
          <div className="ticket-queue-heading">
            <div>
              <span className="eyebrow">UDESK</span>
              <h2>{tr("Ticket queue")}</h2>
            </div>
            <span className="ticket-live-label">
              <span />
              {tr("Read only")}
            </span>
          </div>
          <ListToolbar
            actions={
              <a
                className="btn secondary"
                download
                href={
                  "/api/export/tickets?" +
                  new URLSearchParams({ filterId: filter, cursor })
                }
              >
                <Icon name="download" />
                {tr("Export authorized page")}
              </a>
            }
          >
            <SearchControl
              label="Search current page"
              placeholder="Search current page…"
              value={query}
              onChange={setQuery}
            />
            <FilterControl
              label="Udesk filter"
              value={filter}
              disabled={!metadata || busy}
              onChange={(v) => {
                setFilter(v);
                setCursor("");
                setHistory([]);
                setQuery("");
              }}
              options={[
                { value: "", label: "All authorized tickets" },
                ...(metadata?.filters || []).map((f) => ({
                  value: f.id,
                  label: f.name,
                })),
              ]}
            />
            <SortControl
              label="Sort current page"
              value={sort}
              onChange={setSort}
              options={[
                { value: "updated_at:desc", label: "Updated · newest first" },
                { value: "updated_at:asc", label: "Updated · oldest first" },
                { value: "created_at:desc", label: "Created · newest first" },
                { value: "created_at:asc", label: "Created · oldest first" },
                {
                  value: "field_num:desc",
                  label: "Ticket number · descending",
                },
                { value: "field_num:asc", label: "Ticket number · ascending" },
                { value: "subject:asc", label: "Subject · A–Z" },
                { value: "assignee_name:asc", label: "Assignee · A–Z" },
                { value: "status:asc", label: "Status · A–Z" },
              ]}
            />
          </ListToolbar>
          <div className="ticket-queue-subbar">
            <span>
              {tr("Search and sort apply to the current page.")}{" "}
              {data && (
                <strong>
                  {items.length} / {data.items.length}
                </strong>
              )}
            </span>
            <form onSubmit={lookup}>
              <SearchControl
                label="Find ticket by number"
                placeholder="Ticket number, e.g. #717"
                value={number}
                onChange={setNumber}
                required
              />
              <button className="btn secondary" disabled={busy}>
                {tr("Find")}
              </button>
            </form>
          </div>
          <details className="ticket-filter-note">
            <summary>{tr("About Udesk filters")}</summary>
            <p>
              {tr(
                "Filters are maintained in Udesk. Personal filters use the integration account; your CRM access scope is always applied.",
              )}
            </p>
          </details>
          {busy && <p role="status">{tr("Fetching tickets from Udesk…")}</p>}
          {!busy && data && (
            <>
              <div className="table-scroll ticket-table">
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
                    {items.map((item) => {
                      const t = item.source;
                      return (
                        <tr
                          key={t.id}
                          onClick={(e) => {
                            if (!e.target.closest("a,button"))
                              setSelected(String(t.id));
                          }}
                        >
                          <td>
                            <button
                              className="text-button"
                              onClick={() => setSelected(String(t.id))}
                            >
                              {t.field_num}
                            </button>
                          </td>
                          <td>
                            <a
                              className="ticket-subject"
                              href={
                                "#service?ticket=" + encodeURIComponent(t.id)
                              }
                            >
                              {t.subject}
                            </a>
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
                          <td>
                            <span className="ticket-status">{t.status}</span>
                          </td>
                          <td>{t.priority}</td>
                          <td>{t.platform}</td>
                          <td className="ticket-date">
                            {displayDate(t.updated_at)}
                          </td>
                          <td>{item.rmaIds.join(", ") || "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {!items.length && (
                <p>{tr("No authorized tickets on this source page.")}</p>
              )}
              {data.scanLimited && (
                <p className="muted">
                  {tr(
                    "More source pages remain. Continue to find additional authorized tickets.",
                  )}
                </p>
              )}
              <div className="ticket-toolbar ticket-pagination">
                <span className="ticket-page-sync">
                  {tr("Fetched from Udesk")}: {displayDate(data.fetchedAt)}
                </span>
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
                {tr("Ticket")} {d.ticketId} · {displayDate(d.updatedAt)}
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
