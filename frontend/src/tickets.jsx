import React, { useCallback, useEffect, useRef, useState } from "react";
import { api, useWorkspace } from "./context";
import { tr, intlLocale } from "./i18n";
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
  Pagination,
  LoadingState,
} from "./components";
import { AttachmentList, AttachmentContext } from "./attachments";
import { messageText, messageParts } from "./ticket-content";
import {
  customValues,
  customDefinition,
  problemPresentation,
  isInitialSubmission,
} from "./ticket-presentation";
import { syncTimestamp, ticketNumberQuery, ticketListIssue } from "./ticket-ui";
import { MailContent } from "./mail-content";
import { RMAForm } from "./support";

const text = (value) =>
  value == null
    ? "—"
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
const plain = (value) => messageText(value, true);
const displayDate = (value, timeZone) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(intlLocale(), {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone,
      });
};
function conversationRole(reply) {
  if (["internat", "internal"].includes(reply.function_type)) return "Internal note";
  if (reply.author?.user_type === "customer") return "Customer";
  if (reply.author?.user_type === "agent") return "Support agent";
  return "External reply";
}
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
    value.some(
      (v) =>
        v && typeof v === "object" && (v.url || v.file_url || v.download_url),
    )
  )
    return <AttachmentList value={value} />;
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
    ? value.trim() !== "" && !/^[-—–－]+$/.test(value.trim())
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
function Fields({ ticket, metadata, omitted = [] }) {
  if (!metadata)
    return (
      <LoadingState
        label="Loading Udesk field definitions…"
        variant="compact"
        rows={3}
      />
    );
  const custom = Object.entries(customValues(ticket))
    .filter(([name, value]) => !omitted.includes(name) && hasValue(value))
    .map(([name, value]) => ({
      name,
      value,
      ...customDefinition(name, ticket, metadata),
    }));
  const groups = [
    {
      title: "Customer information",
      keys: ["user_name", "user_email", "user_cellphone", "customer_telephone"],
    },
    {
      title: "Handling information",
      keys: [
        "assignee_name",
        "user_group_name",
        "priority",
        "created_at",
        "updated_at",
        "tags",
      ],
      match: /^(受理客服|客服组|优先级)$/i,
    },
    {
      title: "Order and product",
      keys: [],
      match:
        /order|serial|product|purchase|country|region|订单|序列号|产品|购买|国家|地区|^sn$/i,
    },
    {
      title: "Issue classification",
      keys: ["ticket_category_name"],
      match:
        /category|secondary issue|tertiary|symptom|keyword|分类|次级|关键词|症状/i,
    },
  ];
  const used = new Set([
    "id",
    "subject",
    "content",
    "status",
    "status_en",
    "platform",
    "field_num",
    "custom_fields",
    "custom_fields_v2",
    "attachments",
  ]);
  const usedCustom = new Set();
  const render = (key, value, label, field) => (
    <div
      key={key}
      className={
        typeof value === "object" || String(value).length > 100
          ? "ticket-field-wide"
          : undefined
      }
    >
      <dt>{tr(label)}</dt>
      <dd>
        <Value
          field={field}
          value={/(_at|_deadline)$/.test(key) ? displayDate(value) : value}
        />
      </dd>
    </div>
  );
  const sections = groups.map((group) => {
    group.keys.forEach((key) => used.add(key));
    const entries = group.keys
      .filter((key) => hasValue(ticket[key]))
      .map((key) => render(key, ticket[key], labels[key] || friendly(key)));
    for (const entry of custom)
      if (
        !usedCustom.has(entry.name) &&
        group.match?.test(entry.label) &&
        !/submission id/i.test(entry.label)
      ) {
        usedCustom.add(entry.name);
        entries.push(render(entry.name, entry.value, entry.label, entry.field));
      }
    return entries.length ? (
      <section className="ticket-field-section" key={group.title}>
        <PanelHeading title={group.title} />
        <dl className="ticket-fields">{entries}</dl>
      </section>
    ) : null;
  });
  const otherCustom = custom.filter(
    (e) => !usedCustom.has(e.name) && !/submission id/i.test(e.label),
  );
  const remaining = Object.entries(ticket).filter(
    ([key, value]) => !used.has(key) && hasValue(value),
  );
  const technical = remaining.filter(
    ([key]) =>
      key.endsWith("_id") ||
      [
        "content_type",
        "has_reminder",
        "reminder_count",
        "updator_id",
        "assignee_avatar",
        "url",
      ].includes(key) ||
      /count$/.test(key),
  );
  const other = remaining.filter((entry) => !technical.includes(entry));
  const extras = [
    ...other.map(([key, value]) =>
      render(key, value, labels[key] || friendly(key)),
    ),
    ...otherCustom.map((e) => render(e.name, e.value, e.label, e.field)),
  ];
  const system = [
    ...technical.map(([key, value]) =>
      render(key, value, labels[key] || friendly(key)),
    ),
    render("id", ticket.id, labels.id),
    ...custom
      .filter((e) => /submission id/i.test(e.label))
      .map((e) => render(e.name, e.value, e.label, e.field)),
  ];
  return (
    <>
      {sections}
      {hasValue(ticket.attachments) && (
        <section className="ticket-field-section ticket-files">
          <PanelHeading title="Ticket attachments" />
          <AttachmentList value={ticket.attachments} />
        </section>
      )}
      {extras.length > 0 && (
        <details className="ticket-field-section ticket-field-disclosure">
          <summary>{tr("Other fields")}</summary>
          <dl className="ticket-fields">{extras}</dl>
        </details>
      )}
      <details className="ticket-field-section ticket-field-disclosure">
        <summary>{tr("System information")}</summary>
        <dl className="ticket-fields">{system}</dl>
      </details>
    </>
  );
}
function ProblemDetails({ problem, ticket }) {
  return (
    <section className="ticket-story">
      <PanelHeading title="Problem details" />
      {problem.fields.length > 0 && (
        <div className="ticket-submission">
          <h3>{tr("Submission fields")}</h3>
          <dl className="ticket-submission-fields">
            {problem.fields.map((entry) => (
              <div
                key={entry.name}
                className={
                  typeof entry.value === "object" ||
                  String(entry.value).length > 100
                    ? "ticket-field-wide"
                    : undefined
                }
              >
                <dt>{tr(entry.label)}</dt>
                <dd>
                  <Value field={entry.field} value={entry.value} />
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {hasValue(problem.text) && (
        <div className="ticket-problem-body">
          {problem.fields.length > 0 && <h3>{tr("Problem description")}</h3>}
          {String(ticket.platform_name || ticket.platform).toLowerCase() ===
          "api" ? (
            <div className="ticket-content">{problem.text}</div>
          ) : /<\/?[a-z][^>]*>/i.test(String(ticket.content || "")) ? (
            <MailContent html={ticket.content} />
          ) : (
            <MessageBody text={problem.text} />
          )}
        </div>
      )}
      {problem.original && (
        <details className="ticket-original">
          <summary>{tr("View original submission")}</summary>
          <div className="ticket-content">{problem.original}</div>
        </details>
      )}
    </section>
  );
}
function MessageBody({ text }) {
  return (
    <div className="conversation-body">
      {text
        .split(/\n\n+/)
        .filter(Boolean)
        .map((paragraph, index) => (
          <p key={index}>{paragraph}</p>
        ))}
    </div>
  );
}
function ConversationContent({ reply, ticket }) {
  const html = reply.content_format === "html";
  const full = messageText(reply.content, html);
  const parts = messageParts(reply.content, html);
  const initial = isInitialSubmission(
    reply,
    ticket,
    full,
    plain(ticket.content),
  );
  if (initial)
    return (
      <>
        <p className="ticket-initial-reference">
          {tr("Initial submission shown above")}
        </p>
        <details className="conversation-quote">
          <summary>{tr("View original message")}</summary>
          {html ? (
            <MailContent html={reply.content} />
          ) : (
            <MessageBody text={full} />
          )}
        </details>
      </>
    );
  if (html) return <MailContent html={reply.content} />;
  return (
    <>
      <MessageBody text={parts.main} />
      {parts.quote && (
        <details className="conversation-quote">
          <summary>{tr("Expand quoted history")}</summary>
          <MessageBody text={parts.quote} />
        </details>
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
    [replyError, setReplyError] = useState(""),
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
    setReplyError("");
    api(`/api/tickets/${encodeURIComponent(id)}/replies?page=${replyPage}`, {
      signal: controller.signal,
    })
      .then(setReplies)
      .catch((e) => {
        if (e.name !== "AbortError") setReplyError(e.message);
      });
    return () => controller.abort();
  }, [id, data, replyPage]);
  const problem = data
    ? problemPresentation(data.source, metadata, plain(data.source.content))
    : null;
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
    <AttachmentContext.Provider value={{ ticketId: id, replyPage }}>
      <section
        className="ticket-detail panel"
        aria-label={tr("Ticket details")}
      >
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
            <Button
              kind="primary"
              disabled={busy || !metadata}
              onClick={create}
            >
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
          busy ? (
            <LoadingState
              label="Loading Udesk ticket…"
              variant="detail"
              rows={4}
            />
          ) : (
            <p className="muted">{tr("Ticket could not be loaded.")}</p>
          )
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
            </header>
            <div className="ticket-detail-layout">
              <div className="ticket-main-column">
                {(hasValue(problem.text) || problem.fields.length > 0) && (
                  <ProblemDetails problem={problem} ticket={data.source} />
                )}
                {data.rmaIds?.length > 0 && (
                  <p className="ticket-rma-links">
                    {tr("Linked RMAs")}: {data.rmaIds.join(", ")}
                  </p>
                )}
                <section className="ticket-thread">
                  <PanelHeading
                    title="Conversation"
                    subtitle="Times shown in Beijing (UTC+8)"
                  >
                    {replies && <span className="conversation-count">{tr("{count} messages", {count: replies.meta?.total_count ?? (replies.replies || []).length})}</span>}
                  </PanelHeading>
                  {replies ? (
                    <>
                      <div className="ticket-conversation">
                        {!replies.replies?.length && (
                          <p className="ticket-empty-conversation">
                            {tr("No conversation yet.")}
                          </p>
                        )}
                        {(replies.replies || []).map((r) => (
                          <article key={r.id} className={conversationRole(r) === "Customer" ? "is-customer" : conversationRole(r) === "Internal note" ? "is-internal" : ""}>
                            <header className="conversation-header">
                              <div className="conversation-author">
                                <span
                                  className="conversation-avatar"
                                  aria-hidden="true"
                                >
                                  {(
                                    r.author?.nick_name ||
                                    r.author?.user_type ||
                                    "U"
                                  )
                                    .slice(0, 1)
                                    .toUpperCase()}
                                </span>
                                <strong>
                                  {r.author?.nick_name || tr(r.author?.user_type === "agent" ? "Support agent" : r.author?.user_type === "customer" ? "Customer" : "Unknown author")}
                                </strong>
                                <span className="conversation-role">{tr(conversationRole(r))}</span>
                              </div>
                              <time dateTime={r.created_at}>{displayDate(r.created_at, "Asia/Shanghai")}</time>
                            </header>
                            <ConversationContent
                              reply={r}
                              ticket={data.source}
                            />
                            {hasValue(r.attachments) && (
                              <Value value={r.attachments} />
                            )}
                          </article>
                        ))}
                      </div>
                      {(replies.meta?.total_pages || 1) > 1 && <Pagination
                        label="Conversation pagination"
                        page={replyPage}
                        totalPages={replies.meta?.total_pages || 1}
                        onPrevious={() => setReplyPage((n) => n - 1)}
                        onNext={() => setReplyPage((n) => n + 1)}
                      />}
                    </>
                  ) : replyError ? (
                    <div className="conversation-error" role="alert">
                      <p>{tr(replyError)}</p>
                      <Button onClick={() => setRefresh((v) => v + 1)}>
                        Refresh ticket
                      </Button>
                    </div>
                  ) : (
                    <LoadingState
                      label="Loading conversation…"
                      variant="conversation"
                      rows={2}
                    />
                  )}
                </section>
              </div>
              <aside className="ticket-sidebar">
                <Fields
                  ticket={data.source}
                  metadata={metadata}
                  omitted={problem.omitted}
                />
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
    </AttachmentContext.Provider>
  );
}
function TicketHelp({ label, children, className = "" }) {
  return <details className={"ticket-help " + className}>
    <summary aria-label={tr(label)} title={tr(label)}><span aria-hidden="true">i</span></summary>
    <div className="ticket-help-content">{children}</div>
  </details>;
}
function TicketSyncStatus({ data, lastSync, error, zone }) {
  const stamp = syncTimestamp(lastSync, intlLocale(), zone);
  const warning = !!(data?.stale || data?.syncError || error);
  const label = warning ? "Sync interrupted" : stamp ? "Synced" : "Initializing";
  return <details className={"ticket-sync-status ticket-help" + (warning ? " is-warning" : "")}>
    <summary aria-label={tr("Synchronization details")}>
      <span className="ticket-sync-dot" aria-hidden="true" />
      <span>{tr(label)}</span>
      {stamp && <><span aria-hidden="true">·</span><span>{tr("Updated")} {stamp.short}</span></>}
    </summary>
    <div className="ticket-help-content">
      <strong>{tr("Automatic sync every minute")}</strong>
      <span>{tr("Last successful sync")}: {stamp ? stamp.full : tr("Not yet synchronized")}</span>
      <span>{tr("Time zone")}: {zone}</span>
    </div>
  </details>;
}
function TicketQueueState({ title, description, children }) {
  return <div className="ticket-queue-state" role="status">
    <span className="ticket-state-icon" aria-hidden="true"><Icon name="service" /></span>
    <h3>{tr(title)}</h3>
    <p>{tr(description)}</p>
    {children}
  </div>;
}
const queueIssues = {
  filter: ["This filter is unavailable", "Choose another filter or view all tickets."],
  mapping: ["Link your Udesk account", "Your Udesk account is not linked. Contact an administrator."],
  permission: ["Ticket access is unavailable", "Contact an administrator to check your access."],
  session: ["Your session has expired", "Sign in again to view tickets."],
  unavailable: ["Unable to load tickets", "Please try again later. The list will recover automatically."],
};
export function TicketCenter() {
  const { can, state } = useWorkspace();
  const zone = state.settings.timezone || "Asia/Shanghai";
  const [metadata, setMetadata] = useState(null),
    [data, setData] = useState(null),
    [error, setError] = useState(null),
    [metadataError, setMetadataError] = useState(null),
    [draftError, setDraftError] = useState(null),
    [busy, setBusy] = useState(false),
    [filter, setFilter] = useState(""),
    [cursor, setCursor] = useState(""),
    [history, setHistory] = useState([]),
    [refresh, setRefresh] = useState(0),
    [selected, updateSelected] = useState(() =>
      new URLSearchParams(location.hash.split("?")[1]).get("ticket"),
    ),
    [query, setQuery] = useState(""),
    [sort, setSort] = useState("replied_at:desc"),
    [lookupBusy, setLookupBusy] = useState(false),
    [lookupError, setLookupError] = useState(null),
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
  const items = data?.items || [];
  const number = ticketNumberQuery(query);
  const issue = ticketListIssue(error || (!data && metadataError));
  const hasFilters = !!(query || filter);
  const clearFilters = () => { setQuery(""); setFilter(""); setCursor(""); setHistory([]); setLookupError(null); lookupRequest.current?.abort(); setLookupBusy(false); };
  const lookupRequest = useRef(null);
  useEffect(() => () => lookupRequest.current?.abort(), []);
  const lastRequest = useRef("");
  useEffect(() => {
    const timer = window.setInterval(() => setRefresh((v) => v + 1), 15000);
    return () => window.clearInterval(timer);
  }, []);
  const latest = useRef(0);
  useEffect(() => {
    const controller = new window.AbortController();
    api("/api/tickets/metadata", { signal: controller.signal })
      .then((value) => {
        // The first background cycle can expose a partial metadata snapshot.
        // Wait for definitions before presenting raw keys as field labels.
        setMetadata(Array.isArray(value.fields?.fields) ? value : null);
        setMetadataError(null);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setMetadataError(e);
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
    if (selected) return;
    const controller = new window.AbortController();
    const version = ++latest.current;
    const params = new URLSearchParams({ filterId: filter, cursor, sort, q: query });
    const signature = params.toString();
    if (lastRequest.current !== signature) {
      setBusy(true);
      setData(null);
    }
    lastRequest.current = signature;
    const timer = setTimeout(() => {
      api("/api/tickets?" + params, { signal: controller.signal })
        .then((v) => {
          if (version === latest.current) {
            setData(v);
            setError(null);
            setLastSync(v.fetchedAt);
          }
        })
        .catch((e) => {
          if (e.name !== "AbortError" && version === latest.current) {
            setError(e);
            setData(null);
            if (e.lastSyncAt) setLastSync(e.lastSyncAt);
          }
        })
        .finally(() => {
          if (!controller.signal.aborted && version === latest.current)
            setBusy(false);
        });
    }, query ? 300 : 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [filter, cursor, sort, query, refresh, selected]);
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
    if (!number || lookupBusy) return;
    lookupRequest.current?.abort();
    const controller = new window.AbortController();
    lookupRequest.current = controller;
    setLookupBusy(true);
    setLookupError(null);
    try {
      const v = await api(
        "/api/tickets/lookup?" + new URLSearchParams({ number: "#" + number }),
        { signal: controller.signal },
      );
      if (!controller.signal.aborted) setSelected(String(v.source.id));
    } catch (e) {
      if (e.name !== "AbortError") setLookupError(e);
    } finally {
      if (lookupRequest.current === controller) setLookupBusy(false);
    }
  };
  const resume = async (id) => {
    setDraftError(null);
    try {
      setDraft(await api(`/api/intake-drafts/${encodeURIComponent(id)}`));
    } catch (e) {
      setDraftError(e);
    }
  };
  return (
    <>
      <Heading subtitle="View Morpho tickets and create linked RMAs." />
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
        <Panel className="ticket-queue">
          <div className="ticket-queue-heading">
            <div className="ticket-queue-title">
              <h2>{tr("Ticket queue")}</h2>
              {data && !data.initializing && !data.stale && <span className="ticket-result-count">
                {query ? tr("Found") + " " : ""}{data.totalCount} {tr("tickets")}
              </span>}
            </div>
            <TicketSyncStatus data={data} lastSync={lastSync} error={error || metadataError} zone={zone} />
          </div>
          <ListToolbar
            actions={
              data && items.length > 0 && !issue ? <a
                className="btn secondary"
                download
                href={
                  "/api/export/tickets?" +
                  new URLSearchParams({ filterId: filter, cursor, sort, q: query })
                }
              >
                <Icon name="download" />
                {tr("Export page")}
              </a> : <button className="btn secondary" disabled><Icon name="download" />{tr("Export page")}</button>
            }
          >
            <form className="ticket-search" onSubmit={lookup}>
              <SearchControl
                label="Search ticket content"
                placeholder="Search tickets…"
                value={query}
                onChange={(value) => {
                  lookupRequest.current?.abort();
                  setLookupBusy(false);
                  setLookupError(null);
                  setQuery(value);
                  setCursor("");
                  setHistory([]);
                }}
              />
              {number && <button className="ticket-number-action" type="submit" disabled={lookupBusy}>
                {tr(lookupBusy ? "Looking up…" : "Open ticket")} {!lookupBusy && "#" + number}
                {!lookupBusy && <Icon name="arrow" />}
              </button>}
            </form>
            <TicketHelp label="Search help"><p>{tr("Search covers authorized ticket titles, descriptions and custom fields. Conversation history is not included.")}</p></TicketHelp>
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
                { value: "", label: "All Morpho tickets" },
                ...(metadata?.filters || []).map((f) => ({
                  value: f.id,
                  label: f.name,
                })),
              ]}
            />
            <TicketHelp label="About Udesk filters"><p>{tr("Filters use the Udesk integration account. Results always stay within the configured Morpho groups.")}</p></TicketHelp>
            <SortControl
              label="Sort all authorized tickets"
              value={sort}
              onChange={(value) => {
                setSort(value);
                setCursor("");
                setHistory([]);
              }}
              options={[
                {
                  value: "replied_at:desc",
                  label: "Last reply: newest first",
                },
                { value: "replied_at:asc", label: "Last reply: oldest first" },
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
          {lookupError && <div className="ticket-inline-notice" role="alert">
            {tr(lookupError.status === 404 ? "Ticket not found or not available to your account." : lookupError.status === 403 ? "Your Udesk account is not linked. Contact an administrator." : "Unable to look up this ticket. Please try again later.")}
          </div>}
          {busy && <LoadingState label="Loading tickets…" rows={5} />}
          {!busy && issue && <TicketQueueState title={queueIssues[issue][0]} description={queueIssues[issue][1]}>
            {issue === "filter" && <button className="btn secondary" onClick={clearFilters}>{tr("View all tickets")}</button>}
          </TicketQueueState>}
          {!busy && !issue && data?.initializing && !data.syncError && <LoadingState label="Ticket data is initializing" rows={3} />}
          {!busy && !issue && data?.initializing && data.syncError && <TicketQueueState title="Ticket initialization is paused" description="Automatic synchronization will retry. No complete ticket list is available yet." />}
          {!busy && !issue && data?.syncError && !data.initializing && !data.stale && <div className="ticket-inline-notice" role="status">
            {tr("Synchronization is temporarily interrupted. Showing previously synced data; automatic retries will continue.")}
          </div>}
          {!busy && !issue && data?.stale && <div className="ticket-inline-notice" role="status">
            {items.length > 0 ? tr("Synchronization is delayed. You are viewing older data.") : tr("Ticket data is out of date. The list is paused to protect access permissions.")}
          </div>}
          {!busy && !issue && data && !data.initializing && items.length === 0 && <TicketQueueState
            title={data.stale ? "Waiting for synchronization" : hasFilters ? "No matching tickets" : "No tickets to show"}
            description={data.stale ? "The list will return automatically when synchronization recovers." : hasFilters ? "Try another keyword or adjust your filters." : "New tickets will appear here after synchronization."}
          >
            {!data.stale && hasFilters && <button className="btn secondary" onClick={clearFilters}>{tr("Clear filters")}</button>}
          </TicketQueueState>}
          {!busy && !issue && data && !data.initializing && items.length > 0 && (
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
                        "Last reply",
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
                          <td data-label={tr("Ticket")}>
                            <button
                              className="text-button"
                              onClick={() => setSelected(String(t.id))}
                            >
                              {t.field_num}
                            </button>
                          </td>
                          <td data-label={tr("Subject / customer")}>
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
                          <td data-label={tr("Assignee / group")}>
                            {t.assignee_name || "—"}
                            <small className="cell-sub">
                              {t.user_group_name}
                            </small>
                          </td>
                          <td data-label={tr("Status")}>
                            <span className="ticket-status">{t.status}</span>
                          </td>
                          <td data-label={tr("Priority")}>{t.priority}</td>
                          <td data-label={tr("Channel")}>{t.platform}</td>
                          <td
                            className="ticket-date"
                            data-label={tr("Last reply")}
                          >
                            {displayDate(t.replied_at)}
                          </td>
                          <td data-label={tr("Linked RMAs")}>
                            {item.rmaIds.join(", ") || "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <Pagination
                label="Ticket pagination"
                page={data.currentPage || history.length + 1}
                totalPages={
                  data.totalPages ??
                  (!data.nextCursor ? history.length + 1 : null)
                }
                hasNext={!!data.nextCursor}
                disabled={busy}
                onPrevious={() => {
                  setCursor(history.at(-1));
                  setHistory(history.slice(0, -1));
                }}
                onNext={() => {
                  setHistory([...history, cursor]);
                  setCursor(data.nextCursor);
                }}
              />
            </>
          )}
        </Panel>
      )}
      {can("rma.create") && drafts.length > 0 && (
        <Panel>
          <PanelHeading title="Your RMA drafts" />
          {draftError && <div className="ticket-inline-notice" role="alert">{tr("Unable to open this draft. It may no longer be available to your account.")}</div>}
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
  if (!isAdmin)
    return <p>{tr("Only administrators can manage Udesk mappings.")}</p>;
  return (
    <Panel>
      <PanelHeading title="Udesk accounts & mapping">
        <Button disabled={busy} onClick={sync}>
          Synchronize accounts
        </Button>
      </PanelHeading>
      <p className="muted">
        {tr(
          "Source accounts provide identity mapping. All active CRM users share the configured Morpho ticket scope.",
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
                  "Agent groups",
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
                  <td>{JSON.parse(m.sourceGroups || "[]").map((id) => (data.groups || []).find((g) => String(g.id) === String(id))?.name || id).join(" / ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
