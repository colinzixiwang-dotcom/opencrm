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
import { ColumnFilter } from "./column-filter";
import { RMAForm } from "./support";

// The UI consumes the stable CRM contract. v1 remains only for older clients.
const crmApi = (path, options = {}) =>
  api(path, {
    ...options,
    headers: {
      ...options.headers,
      Accept: "application/vnd.morpho.support.v2+json",
    },
  });
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
  if (reply.kind === "internal") return "Internal note";
  if (reply.author?.kind === "customer") return "Customer";
  if (reply.author?.kind === "agent") return "Support agent";
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
      visit(o.children);
    });
  visit(field?.options);
  if (options.length) {
    const values = Array.isArray(value) ? value : [value];
    return values
      .map(
        (v) =>
          options.find((o) => String(o.value) === String(v))?.label ?? text(v),
      )
      .join(" / ");
  }
  if (
    Array.isArray(value) &&
    value.some((v) => v && typeof v === "object" && v.reference)
  )
    return <AttachmentList value={value} />;
  return <span>{text(value)}</span>;
}
const hasValue = (value) =>
  value != null &&
  (typeof value === "string"
    ? value.trim() !== "" && !/^[-—–－]+$/.test(value.trim())
    : Array.isArray(value)
      ? value.some(hasValue)
      : typeof value === "object"
        ? Object.values(value).some(hasValue)
        : true);
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
    { title: "Customer information" },
    { title: "Handling information", match: /^(受理客服|客服组|优先级)$/i },
    {
      title: "Order and product",
      match:
        /order|serial|product|purchase|country|region|订单|序列号|产品|购买|国家|地区|^sn$/i,
    },
    {
      title: "Issue classification",
      match:
        /category|secondary issue|tertiary|symptom|keyword|分类|次级|关键词|症状/i,
    },
    { title: "Other fields" },
    { title: "System information" },
  ];
  const entries = new Map(groups.map((g) => [g.title, []]));
  for (const field of ticket.fields || []) {
    if (hasValue(field.value))
      (entries.get(field.section) || entries.get("Other fields")).push(field);
  }
  for (const entry of custom) {
    const section = /submission id/i.test(entry.label)
      ? "System information"
      : groups.find((g) => g.match?.test(entry.label))?.title || "Other fields";
    entries.get(section).push({
      key: entry.name,
      label: entry.label,
      value: entry.value,
      options: entry.field?.options,
      kind: entry.field?.kind,
    });
  }
  const render = (field) => (
    <div
      key={field.key}
      className={
        typeof field.value === "object" || String(field.value).length > 100
          ? "ticket-field-wide"
          : undefined
      }
    >
      <dt>{tr(field.label)}</dt>
      <dd>
        <Value
          field={field}
          value={
            field.kind === "datetime" ? displayDate(field.value) : field.value
          }
        />
      </dd>
    </div>
  );
  const section = (group) => {
    const values = entries.get(group.title);
    if (!values.length && group.title !== "System information") return null;
    const content = <dl className="ticket-fields">{values.map(render)}</dl>;
    return group.title === "Other fields" ||
      group.title === "System information" ? (
      <details
        className="ticket-field-section ticket-field-disclosure"
        key={group.title}
      >
        <summary>{tr(group.title)}</summary>
        {content}
      </details>
    ) : (
      <section className="ticket-field-section" key={group.title}>
        <PanelHeading title={group.title} />
        {content}
      </section>
    );
  };
  return (
    <>
      {groups.slice(0, 4).map(section)}
      {hasValue(ticket.attachments) && (
        <section className="ticket-field-section ticket-files">
          <PanelHeading title="Ticket attachments" />
          <AttachmentList value={ticket.attachments} />
        </section>
      )}
      {groups.slice(4).map(section)}
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
          {String(ticket.channelCode || ticket.channel).toLowerCase() ===
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
  const html = reply.contentFormat === "html";
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
    crmApi(`/api/tickets/${encodeURIComponent(id)}`, {
      signal: controller.signal,
    })
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
    crmApi(`/api/tickets/${encodeURIComponent(id)}/replies?page=${replyPage}`, {
      signal: controller.signal,
    })
      .then(setReplies)
      .catch((e) => {
        if (e.name !== "AbortError") setReplyError(e.message);
      });
    return () => controller.abort();
  }, [id, data, replyPage]);
  const problem = data
    ? problemPresentation(data.ticket, metadata, plain(data.ticket.content))
    : null;
  const create = async () => {
    setBusy(true);
    setError("");
    try {
      const t = data.ticket,
        payload = {
          ticketNumber: t.number,
          description: plain(t.content).slice(0, 4000),
        };
      const fields = metadata?.fields || [];
      for (const [label, key] of [["Product Serial Number", "sn"]]) {
        const field = fields.find((f) => f.label === label);
        const value = field && t.customValues?.[field.key];
        if (typeof value === "string") payload[key] = value;
      }
      const draft = await crmApi(
        `/api/tickets/${encodeURIComponent(id)}/drafts`,
        {
          method: "POST",
          body: JSON.stringify(payload),
        },
      );
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
              href={data.sourceUrl}
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
                  {tr("Ticket")} {data.ticket.number}
                </span>
                <span className="ticket-status">{data.ticket.status}</span>
                <span>{data.ticket.channel}</span>
              </div>
              <h2>{data.ticket.subject}</h2>
              {data.rmaIds?.length > 0 && (
                <div className="ticket-rma-links" role="group" aria-label={tr("Linked RMAs")}>
                  <span className="ticket-rma-label">{tr("Linked RMAs")}</span>
                  <div className="ticket-rma-items">
                    {data.rmaIds.map(rmaId => <a className="ticket-rma-id" key={rmaId} href={`#rma?rma=${encodeURIComponent(rmaId)}`}>{rmaId}</a>)}
                  </div>
                </div>
              )}
            </header>
            <div className="ticket-detail-layout">
              <div className="ticket-main-column">
                {(hasValue(problem.text) || problem.fields.length > 0) && (
                  <ProblemDetails problem={problem} ticket={data.ticket} />
                )}
                <section className="ticket-thread">
                  <PanelHeading
                    title="Conversation"
                    subtitle="Times shown in Beijing (UTC+8)"
                  >
                    {replies && (
                      <span className="conversation-count">
                        {tr("{count} messages", {
                          count:
                            replies.totalCount ??
                            (replies.messages || []).length,
                        })}
                      </span>
                    )}
                  </PanelHeading>
                  {replies ? (
                    <>
                      <div className="ticket-conversation">
                        {!replies.messages?.length && (
                          <p className="ticket-empty-conversation">
                            {tr("No conversation yet.")}
                          </p>
                        )}
                        {(replies.messages || []).map((r) => (
                          <article
                            key={r.id}
                            className={
                              conversationRole(r) === "Customer"
                                ? "is-customer"
                                : conversationRole(r) === "Internal note"
                                  ? "is-internal"
                                  : ""
                            }
                          >
                            <header className="conversation-header">
                              <div className="conversation-author">
                                <span
                                  className="conversation-avatar"
                                  aria-hidden="true"
                                >
                                  {(r.author?.name || r.author?.kind || "U")
                                    .slice(0, 1)
                                    .toUpperCase()}
                                </span>
                                <strong>
                                  {r.author?.name ||
                                    tr(
                                      r.author?.kind === "agent"
                                        ? "Support agent"
                                        : r.author?.kind === "customer"
                                          ? "Customer"
                                          : "Unknown author",
                                    )}
                                </strong>
                                <span className="conversation-role">
                                  {tr(conversationRole(r))}
                                </span>
                              </div>
                              <time dateTime={r.createdAt}>
                                {displayDate(r.createdAt, "Asia/Shanghai")}
                              </time>
                            </header>
                            <ConversationContent
                              reply={r}
                              ticket={data.ticket}
                            />
                            {hasValue(r.attachments) && (
                              <Value value={r.attachments} />
                            )}
                          </article>
                        ))}
                      </div>
                      {(replies.totalPages || 1) > 1 && (
                        <Pagination
                          label="Conversation pagination"
                          page={replyPage}
                          totalPages={replies.totalPages || 1}
                          onPrevious={() => setReplyPage((n) => n - 1)}
                          onNext={() => setReplyPage((n) => n + 1)}
                        />
                      )}
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
                  ticket={data.ticket}
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
  return (
    <details className={"ticket-help " + className}>
      <summary aria-label={tr(label)} title={tr(label)}>
        <span aria-hidden="true">i</span>
      </summary>
      <div className="ticket-help-content">{children}</div>
    </details>
  );
}
function TicketSyncStatus({ data, lastSync, error, zone }) {
  const stamp = syncTimestamp(lastSync, intlLocale(), zone);
  const warning = !!(data?.stale || data?.syncError || error);
  const label = warning
    ? "Sync interrupted"
    : stamp
      ? "Synced"
      : "Initializing";
  return (
    <details
      className={
        "ticket-sync-status ticket-help" + (warning ? " is-warning" : "")
      }
    >
      <summary aria-label={tr("Synchronization details")}>
        <span className="ticket-sync-dot" aria-hidden="true" />
        <span>{tr(label)}</span>
        {stamp && (
          <>
            <span aria-hidden="true">·</span>
            <span>
              {tr("Updated")} {stamp.short}
            </span>
          </>
        )}
      </summary>
      <div className="ticket-help-content">
        <strong>{tr("Automatic sync every minute")}</strong>
        <span>
          {tr("Last successful sync")}:{" "}
          {stamp ? stamp.full : tr("Not yet synchronized")}
        </span>
        <span>
          {tr("Time zone")}: {zone}
        </span>
      </div>
    </details>
  );
}
function TicketQueueState({ title, description, children }) {
  return (
    <div className="ticket-queue-state" role="status">
      <span className="ticket-state-icon" aria-hidden="true">
        <Icon name="service" />
      </span>
      <h3>{tr(title)}</h3>
      <p>{tr(description)}</p>
      {children}
    </div>
  );
}
const queueIssues = {
  filter: [
    "This filter is unavailable",
    "Choose another filter or view all tickets.",
  ],
  mapping: [
    "Link your Udesk account",
    "Your Udesk account is not linked. Contact an administrator.",
  ],
  permission: [
    "Ticket access is unavailable",
    "Contact an administrator to check your access.",
  ],
  session: ["Your session has expired", "Sign in again to view tickets."],
  unavailable: [
    "Unable to load tickets",
    "Please try again later. The list will recover automatically.",
  ],
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
    [assignment, setAssignment] = useState("mine"),
    [status, setStatus] = useState(""),
    [cursor, setCursor] = useState(""),
    [history, setHistory] = useState([]),
    [refresh, setRefresh] = useState(0),
    [selected, updateSelected] = useState(() =>
      new URLSearchParams(location.hash.split("?")[1]).get("ticket"),
    ),
    [query, setQuery] = useState(""),
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
  const hasFilters = !!(query || status || assignment === "mine");
  const clearFilters = () => {
    setQuery("");
    setStatus("");
    setAssignment("all");
    setCursor("");
    setHistory([]);
    setLookupError(null);
    lookupRequest.current?.abort();
    setLookupBusy(false);
  };
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
    crmApi("/api/tickets/metadata", { signal: controller.signal })
      .then((value) => {
        // The first background cycle can expose a partial metadata snapshot.
        // Wait for definitions before presenting raw keys as field labels.
        setMetadata(Array.isArray(value.fields) ? value : null);
        setMetadataError(null);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setMetadataError(e);
      });
    return () => controller.abort();
  }, [refresh]);
  const loadDrafts = useCallback(() => {
    if (can("rma.create"))
      crmApi("/api/intake-drafts")
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
    const params = new URLSearchParams({
      contract: "2",
      assignment,
      status,
      cursor,
      sort: "repliedAt:desc",
      q: query,
    });
    const signature = params.toString();
    if (lastRequest.current !== signature) {
      setBusy(true);
      setData(null);
    }
    lastRequest.current = signature;
    const timer = setTimeout(
      () => {
        crmApi("/api/tickets?" + params, { signal: controller.signal })
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
      },
      query ? 300 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [assignment, status, cursor, query, refresh, selected]);
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
      const v = await crmApi(
        "/api/tickets/lookup?" + new URLSearchParams({ number: "#" + number }),
        { signal: controller.signal },
      );
      if (!controller.signal.aborted) setSelected(String(v.ticket.id));
    } catch (e) {
      if (e.name !== "AbortError") setLookupError(e);
    } finally {
      if (lookupRequest.current === controller) setLookupBusy(false);
    }
  };
  const resume = async (id) => {
    setDraftError(null);
    try {
      setDraft(await crmApi(`/api/intake-drafts/${encodeURIComponent(id)}`));
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
              {data && !data.initializing && !data.stale && (
                <span className="ticket-result-count">
                  {query ? tr("Found") + " " : ""}
                  {data.totalCount} {tr("tickets")}
                </span>
              )}
            </div>
            <TicketSyncStatus
              data={data}
              lastSync={lastSync}
              error={error || metadataError}
              zone={zone}
            />
          </div>
          <ListToolbar
            actions={
              data && items.length > 0 && !issue ? (
                <a
                  className="btn secondary"
                  download
                  href={
                    "/api/export/tickets?" +
                    new URLSearchParams({
                      contract: "2",
                      assignment,
                      status,
                      cursor,
                      sort: "repliedAt:desc",
                      q: query,
                    })
                  }
                >
                  <Icon name="download" />
                  {tr("Export page")}
                </a>
              ) : (
                <button className="btn secondary" disabled>
                  <Icon name="download" />
                  {tr("Export page")}
                </button>
              )
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
              {number && (
                <button
                  className="ticket-number-action"
                  type="submit"
                  disabled={lookupBusy}
                >
                  {tr(lookupBusy ? "Looking up…" : "Open ticket")}{" "}
                  {!lookupBusy && "#" + number}
                  {!lookupBusy && <Icon name="arrow" />}
                </button>
              )}
            </form>
            <TicketHelp label="Search help">
              <p>
                {tr(
                  "Search covers authorized ticket titles, descriptions and custom fields. Conversation history is not included.",
                )}
              </p>
            </TicketHelp>
          </ListToolbar>
          {lookupError && (
            <div className="ticket-inline-notice" role="alert">
              {tr(
                lookupError.status === 404
                  ? "Ticket not found or not available to your account."
                  : lookupError.status === 403
                    ? "Your Udesk account is not linked. Contact an administrator."
                    : "Unable to look up this ticket. Please try again later.",
              )}
            </div>
          )}
          {busy && <LoadingState label="Loading tickets…" rows={5} />}
          {!busy && issue && (
            <TicketQueueState
              title={queueIssues[issue][0]}
              description={queueIssues[issue][1]}
            >
              {issue === "filter" && (
                <button className="btn secondary" onClick={clearFilters}>
                  {tr("View all tickets")}
                </button>
              )}
            </TicketQueueState>
          )}
          {!busy && !issue && data?.initializing && !data.syncError && (
            <LoadingState label="Ticket data is initializing" rows={3} />
          )}
          {!busy && !issue && data?.initializing && data.syncError && (
            <TicketQueueState
              title="Ticket initialization is paused"
              description="Automatic synchronization will retry. No complete ticket list is available yet."
            />
          )}
          {!busy &&
            !issue &&
            data?.syncError &&
            !data.initializing &&
            !data.stale && (
              <div className="ticket-inline-notice" role="status">
                {tr(
                  "Synchronization is temporarily interrupted. Showing previously synced data; automatic retries will continue.",
                )}
              </div>
            )}
          {!busy && !issue && data?.stale && (
            <div className="ticket-inline-notice" role="status">
              {items.length > 0
                ? tr("Synchronization is delayed. You are viewing older data.")
                : tr(
                    "Ticket data is out of date. The list is paused to protect access permissions.",
                  )}
            </div>
          )}
          {!busy &&
            !issue &&
            data &&
            assignment === "mine" &&
            !data.initializing &&
            !data.stale &&
            data.myAccountLinked === false && (
              <div className="ticket-inline-notice" role="status">
                {tr(
                  "Your CRM account is not linked to a Udesk agent. Switch to all tickets to browse Morpho tickets.",
                )}
              </div>
            )}
          {!busy && !issue && data && !data.initializing && (
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
                        <th key={label}>
                          {label === "Assignee / group" ||
                          label === "Status" ? (
                            <ColumnFilter
                              label={label}
                              accessibleLabel={
                                label === "Status"
                                  ? "Filter by ticket status"
                                  : "Filter by ticket assignment"
                              }
                              value={label === "Status" ? status : assignment}
                              summary={
                                label === "Status"
                                  ? status
                                  : assignment === "mine"
                                    ? "Mine"
                                    : "All"
                              }
                              options={
                                label === "Status"
                                  ? [
                                      { value: "", label: "All statuses" },
                                      ...[
                                        ...new Set([
                                          ...(data.availableStatuses || []),
                                          ...(status ? [status] : []),
                                        ]),
                                      ].map((value) => ({
                                        value,
                                        label: value,
                                      })),
                                    ]
                                  : [
                                      { value: "mine", label: "My tickets" },
                                      { value: "all", label: "All tickets" },
                                    ]
                              }
                              onChange={(value) => {
                                if (label === "Status") setStatus(value);
                                else setAssignment(value);
                                setCursor("");
                                setHistory([]);
                              }}
                            />
                          ) : (
                            tr(label)
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {items.length === 0 && (
                      <tr>
                        <td colSpan="8" className="ticket-empty-cell">
                          <TicketQueueState
                            title={
                              data.stale
                                ? "Waiting for synchronization"
                                : hasFilters
                                  ? "No matching tickets"
                                  : "No tickets to show"
                            }
                            description={
                              data.stale
                                ? "The list will return automatically when synchronization recovers."
                                : hasFilters
                                  ? "Try another keyword or adjust your filters."
                                  : "New tickets will appear here after synchronization."
                            }
                          >
                            {!data.stale && hasFilters && (
                              <button
                                className="btn secondary"
                                onClick={clearFilters}
                              >
                                {tr("Clear filters")}
                              </button>
                            )}
                          </TicketQueueState>
                        </td>
                      </tr>
                    )}
                    {items.map((item) => {
                      const t = item.ticket;
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
                              {t.number}
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
                              {t.customerName || t.customerEmail}
                            </small>
                          </td>
                          <td data-label={tr("Assignee / group")}>
                            {t.assigneeName || "—"}
                            <small className="cell-sub">{t.groupName}</small>
                          </td>
                          <td data-label={tr("Status")}>
                            <span className="ticket-status">{t.status}</span>
                          </td>
                          <td data-label={tr("Priority")}>{t.priority}</td>
                          <td data-label={tr("Channel")}>{t.channel}</td>
                          <td
                            className="ticket-date"
                            data-label={tr("Last reply")}
                          >
                            {displayDate(t.repliedAt)}
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
              {items.length > 0 && (
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
              )}
            </>
          )}
        </Panel>
      )}
      {can("rma.create") && drafts.length > 0 && (
        <Panel>
          <PanelHeading title="Your RMA drafts" />
          {draftError && (
            <div className="ticket-inline-notice" role="alert">
              {tr(
                "Unable to open this draft. It may no longer be available to your account.",
              )}
            </div>
          )}
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
  const load = () => crmApi("/api/integrations/udesk/accounts").then(setData);
  useEffect(() => {
    if (isAdmin) load().catch((e) => setError(e.message));
  }, [isAdmin]);
  const sync = async () => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const v = await crmApi("/api/integrations/udesk/accounts/sync", {
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
                  <td>
                    {JSON.parse(m.sourceGroups || "[]")
                      .map(
                        (id) =>
                          (data.groups || []).find(
                            (g) => String(g.id) === String(id),
                          )?.name || id,
                      )
                      .join(" / ") || "—"}
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
