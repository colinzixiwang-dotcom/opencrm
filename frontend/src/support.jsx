import { LanguageSwitcher } from "./language";
import { tr } from "./i18n";
import React, { useState, useEffect, useRef, useMemo } from "react";
import { useWorkspace, api, money, title, formatDate, today } from "./context";
import {
  FilterControl,
  Heading,
  Panel,
  PanelHeading,
  Button,
  Badge,
  Icon,
  Table,
  Note,
  Stat,
  Export,
  Tabs,
} from "./components";
import {
  WarrantyEvidence,
  AssessmentSummary,
  warrantyRequired,
} from "./warranty";
const labels = {
  device_issue: "Device issue",
  user_issue: "User issue",
  logistics_issue: "Logistics issue",
};
const admin = (s) => s.currentUser.roles.includes("admin");
const sku = (s, id) => {
  const p = s.products.find((x) => x.id === id);
  return p ? p.sku + " · " + p.name : "—";
};
const cents = (v) => {
  const n = Number(v);
  if (
    !Number.isFinite(n) ||
    n < 0 ||
    n > 5000000 ||
    Math.abs(n * 100 - Math.round(n * 100)) > 0.000001
  )
    throw Error("Enter a nonnegative amount with at most two decimal places.");
  return Math.round(n * 100);
};
const options = (rows, label = "name") =>
  rows.map((x) => ({ value: x.id, label: x[label] }));
function Select({
  label,
  value,
  onChange,
  items,
  empty,
  required = false,
  name,
}) {
  return (
    <label>
      {tr(label)}
      <select
        aria-label={tr(label)}
        name={name}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        required={required}
      >
        {empty != null && <option value="">{tr(empty)}</option>}
        {items.map((x) =>
          typeof x === "string" ? (
            <option key={x} value={x}>
              {title(x)}
            </option>
          ) : (
            <option key={x.value} value={x.value}>
              {tr(x.label)}
            </option>
          ),
        )}
      </select>
    </label>
  );
}
function Input({
  label,
  value,
  onChange,
  type = "text",
  required = false,
  ...rest
}) {
  return (
    <label>
      {tr(label)}
      <input
        value={value ?? ""}
        type={type}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        {...rest}
      />
    </label>
  );
}
function TextArea({ label, value, onChange, required = false, ...rest }) {
  return (
    <label className="full-field">
      {tr(label)}
      <textarea
        aria-label={tr(label)}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        rows="3"
        required={required}
        {...rest}
      />
    </label>
  );
}
function Toggle({ label, checked, onChange }) {
  return (
    <label className="support-check">
      <input
        type="checkbox"
        checked={!!checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {tr(label)}
    </label>
  );
}
function Dialog({ title: heading, subtitle, children, onClose, wide = false }) {
  const ref = useRef();
  useEffect(() => {
    ref.current.showModal();
  }, []);
  return (
    <dialog
      className={"modal support-dialog " + (wide ? "wide" : "")}
      ref={ref}
      aria-label={tr(heading)}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="modal-header">
        <LanguageSwitcher />
        <div>
          <span className="eyebrow">{tr("CUSTOMER OPERATIONS")}</span>
          <h2>{tr(heading)}</h2>
          <p>{tr(subtitle)}</p>
        </div>
        <button
          className="icon-button"
          aria-label={tr("Close dialog")}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function CustomFields({ scope, typeId = "", value = {}, onChange }) {
  const { state: s } = useWorkspace();
  return (s.supportConfig?.fields || [])
    .filter(
      (f) =>
        f.enabled && f.scope === scope && (!f.typeId || f.typeId === typeId),
    )
    .map((f) => {
      const set = (v) =>
        onChange({
          ...value,
          [f.id]: f.fieldType === "number" && v !== "" ? Number(v) : v,
        });
      return f.fieldType === "select" ? (
        <Select
          key={f.id}
          label={tr(f.name)}
          value={value[f.id] || ""}
          onChange={set}
          items={f.options.map((v) => ({ value: v, label: v }))}
          empty={tr("Choose…")}
          required={f.required}
        />
      ) : f.fieldType === "textarea" ? (
        <TextArea
          key={f.id}
          label={tr(f.name)}
          value={value[f.id]}
          onChange={set}
          required={f.required}
        />
      ) : (
        <Input
          key={f.id}
          label={tr(f.name)}
          value={value[f.id]}
          onChange={set}
          type={
            f.fieldType === "number"
              ? "number"
              : f.fieldType === "date"
                ? "date"
                : "text"
          }
          min={f.fieldType === "number" ? 0 : undefined}
          step={f.fieldType === "number" ? 1 : undefined}
          required={f.required}
          maxLength={2000}
        />
      );
    });
}
function FieldValues({ value = {} }) {
  const { state: s } = useWorkspace();
  return Object.entries(value).map(([key, v]) => (
    <div className="detail-field" key={key}>
      <small>
        {s.supportConfig.fields.find((f) => f.id === key)?.name || key}
      </small>
      <strong>{String(v)}</strong>
    </div>
  ));
}
function FilteredTable({
  rows,
  columns,
  filters = [],
  dateKey,
  initialQuery = "",
  statuses = [],
  empty = "No records yet.",
  scope = "",
}) {
  const { state } = useWorkspace();
  const custom = (state.supportConfig?.fields || []).filter(
    (f) =>
      f.enabled &&
      scope &&
      (f.scope === scope || (scope === "task" && f.scope === "execution")),
  );
  filters = [
    ...filters,
    ...custom.map((f) => ({ key: "custom_" + f.id, label: f.name })),
  ];
  rows = rows.map((r) => ({
    ...r,
    ...Object.fromEntries(
      custom.map((f) => [
        "custom_" + f.id,
        (f.scope === "execution" ? r.executionFields : r.customFields)?.[
          f.id
        ] ?? "",
      ]),
    ),
  }));
  const [v, setV] = useState({}),
    [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  const calendar = (value) => {
    const v = String(value || "");
    return v.length === 10
      ? v
      : v
        ? new Intl.DateTimeFormat("en-CA", {
            timeZone: state.settings.timezone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(new Date(v))
        : "";
  };
  const list = rows.filter(
    (r) =>
      filters.every((f) => !v[f.key] || String(r[f.key]) === v[f.key]) &&
      (!dateKey ||
        ((!from || calendar(r[dateKey]) >= from) &&
          (!to || calendar(r[dateKey]) <= to))),
  );
  return (
    <Panel>
      <div className="support-filters">
        {filters.map((f) => (
          <FilterControl key={f.key} label={f.label} value={v[f.key] || ""} onChange={x=>setV({...v,[f.key]:x})}
            options={[{value:"",label:tr("All")+" "+tr(f.label)}, ...(f.items || [...new Set(rows.map(r=>String(r[f.key]??"")))].filter(Boolean).sort().map(x=>({value:x,label:title(x)})))]} />
        ))}
        {dateKey && (
          <>
            <Input
              label={tr("From")}
              type="date"
              value={from}
              onChange={setFrom}
            />
            <Input label={tr("To")} type="date" value={to} onChange={setTo} />
          </>
        )}
        <Button
          kind="small"
          onClick={() => {
            setV({});
            setFrom("");
            setTo("");
          }}
        >
          {tr("Clear filters")}
        </Button>
      </div>
      <Table
        key={initialQuery}
        initialQuery={initialQuery}
        rows={list}
        columns={columns}
        statuses={statuses}
        empty={tr(empty)}
      />
    </Panel>
  );
}
const col = (label, render, key) => ({ label, render, key });
function useSupportAction(onClose) {
  const { act, busy } = useWorkspace();
  const [error, setError] = useState("");
  const submit = async (action, payload, message) => {
    try {
      setError("");
      const saved = await act(action, payload, message);
      if (saved) onClose?.();
      return saved;
    } catch (e) {
      setError(e.message);
      return false;
    }
  };
  return { submit, busy, error, setError };
}
function Footer({
  busy,
  error,
  onClose,
  disabled = false,
  label = "Save record",
}) {
  return (
    <>
      {error && (
        <p className="form-error support-error" role="alert">
          {tr(error)}
        </p>
      )}
      <div className="modal-footer">
        <span>
          <Icon name="check" />
          {tr("Saved in your workspace")}
        </span>
        <Button kind="secondary" onClick={onClose} disabled={busy}>
          {tr("Cancel")}
        </Button>
        <button
          className="btn primary"
          type="submit"
          disabled={busy || disabled}
        >
          {busy ? tr("Saving…") : tr(label)}
        </button>
      </div>
    </>
  );
}
function TaskParameters({
  type,
  node,
  value,
  onChange,
  rmaProductId,
  scopeFields = true,
}) {
  const { state: s } = useWorkspace();
  const set = (k, v) => onChange({ ...value, [k]: v });
  let products = s.products;
  if (type.id === "send_parts")
    products = products.filter(
      (p) =>
        p.productType === "part" &&
        (p.id === rmaProductId ||
          !p.deviceIds?.length ||
          p.deviceIds.includes(rmaProductId)),
    );
  if (["send_device", "return_device"].includes(type.id))
    products = products.filter((p) => p.productType === "device");
  return (
    <div className="form-grid">
      {type.hasAmount && (
        <Input
          label={tr("Value ($)")}
          type="number"
          min="0.01"
          max="5000000"
          step="0.01"
          value={value.amount ?? ((node.amountCents || 0) / 100).toFixed(2)}
          onChange={(v) => set("amount", v)}
          required
        />
      )}
      {type.requiresProduct && (
        <Select
          label={tr("Task SKU")}
          value={value.productId ?? node.productId ?? ""}
          onChange={(v) => set("productId", v)}
          items={s.products
            .filter((p) => products.includes(p))
            .map((p) => ({ value: p.id, label: sku(s, p.id) }))}
          empty={tr("Choose SKU…")}
          required
        />
      )}
      {type.requiresProduct && (
        <Input
          label={tr("Quantity")}
          value={value.qty ?? node.qty ?? 1}
          type="number"
          min="1"
          max="1000000"
          step="1"
          onChange={(v) => set("qty", v)}
          required
        />
      )}
      {scopeFields && (
        <CustomFields
          scope="task"
          typeId={type.id}
          value={value.customFields || {}}
          onChange={(v) => set("customFields", v)}
        />
      )}
    </div>
  );
}
export function RMAForm({ onClose, initial = {}, duplicateRmaIds = [] }) {
  const { state: s } = useWorkspace(),
    cfg = s.supportConfig;
  const [v, setV] = useState({
      ticketNumber: initial.ticketNumber || "",
      draftId: initial.draftId || "",
      ticketSnapshotId: initial.ticketSnapshotId || "",
      orderNumber: initial.orderNumber || "",
      platform: initial.platform || "",
      productId: initial.productId || "",
      rootCauseId: initial.rootCauseId || "",
      description: initial.description || "",
      solutionId: initial.solutionId || "",
      sn: initial.sn || "",
      warrantyEvidence: initial.warrantyEvidence || {},
      customFields: initial.customFields || {},
    }),
    [inputs, setInputs] = useState(initial.taskInputs || {});
  const [draftMessage, setDraftMessage] = useState("");
  const [configRevision] = useState(cfg.revision);
  const [warrantyRevision] = useState(cfg.warrantyPolicy.revision);
  const [assessment, setAssessment] = useState(null);
  const { submit, busy, error, setError } = useSupportAction(onClose),
    set = (k, x) => setV({ ...v, [k]: x }),
    solution = cfg.solutions.find((x) => x.id === v.solutionId),
    causes = cfg.rootCauses.filter(
      (x) =>
        x.enabled &&
        (!x.productIds.length || x.productIds.includes(v.productId)),
    ),
    orders = orderRows(s);
  const selectSolution = (id) => {
    setV({ ...v, solutionId: id });
    const sol = cfg.solutions.find((x) => x.id === id),
      values = {};
    sol?.nodes.forEach((n) => {
      const type = cfg.taskTypes.find((t) => t.id === n.typeId);
      values[n.key] = {
        amount: ((n.amountCents || 0) / 100).toFixed(2),
        qty: n.qty || 1,
        productId:
          n.productId ||
          (type?.requiresProduct && type.id !== "send_parts"
            ? v.productId
            : ""),
        customFields: {},
      };
    });
    setInputs(values);
  };
  return (
    <Dialog
      title={tr("Create RMA")}
      subtitle={tr(
        "Choose one solution. Its configured tasks and dependencies are generated automatically.",
      )}
      onClose={onClose}
      wide
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!assessment?.eligible) return;
          const taskInputs = {};
          for (const [k, x] of Object.entries(inputs)) {
            taskInputs[k] = {
              ...x,
              amountCents: cents(x.amount || "0"),
              qty: Number(x.qty || 1),
            };
          }
          submit(
            "rma.create",
            {
              ...v,
              taskInputs,
              expectedConfigRevision: configRevision,
              expectedWarrantyRevision: warrantyRevision,
            },
            "RMA created. Solution tasks generated.",
          );
        }}
      >
        <div className="modal-body">
          <div className="form-grid">
            <Input
              label={tr("Support ticket number")}
              name="ticketNumber"
              value={v.ticketNumber}
              readOnly={!!v.draftId}
              onChange={(x) => set("ticketNumber", x)}
              required
              maxLength="160"
            />
            <Input
              label={tr("Order number")}
              name="orderNumber"
              list="support-order-options"
              value={v.orderNumber}
              onChange={(x) => {
                const o = orders.find((o) => o.orderNumber === x);
                const changedProduct =
                  o?.productId && o.productId !== v.productId;
                setV({
                  ...v,
                  orderNumber: x,
                  ...(o
                    ? {
                        platform: o.platform,
                        productId: o.productId || v.productId,
                      }
                    : {}),
                  ...(changedProduct
                    ? { rootCauseId: "", sn: "", solutionId: "" }
                    : {}),
                });
                if (changedProduct) setInputs({});
              }}
              required
              maxLength="160"
            />
            <datalist id="support-order-options">
              {orders.map((o) => (
                <option key={o.id} value={o.orderNumber}>
                  {o.platform} · {o.customer}
                </option>
              ))}
            </datalist>
            <Select
              label={tr("Purchased platform")}
              value={v.platform}
              onChange={(x) => set("platform", x)}
              items={options(cfg.platforms.filter((x) => x.enabled))}
              empty={tr("Choose platform…")}
              required
            />
            <Select
              label={tr("Affected device / part SKU")}
              value={v.productId}
              onChange={(x) => {
                setV({
                  ...v,
                  productId: x,
                  rootCauseId: "",
                  sn: "",
                  solutionId: "",
                });
                setInputs({});
              }}
              items={s.products.map((p) => ({
                value: p.id,
                label: sku(s, p.id),
              }))}
              empty={tr("Choose SKU…")}
              required
            />
            <Input
              label={tr("Serial number (optional)")}
              value={v.sn}
              onChange={(x) => set("sn", x)}
              maxLength="120"
            />
            <Select
              label={tr("Root cause")}
              value={v.rootCauseId}
              onChange={(x) => set("rootCauseId", x)}
              items={causes.map((x) => ({
                value: x.id,
                label: tr(labels[x.primary]) + " / " + tr(x.name),
              }))}
              empty={tr("Choose root cause…")}
              required
            />
            <TextArea
              label={tr("Description")}
              value={v.description}
              onChange={(x) => set("description", x)}
              required
              maxLength="4000"
            />
            <Select
              label={tr("Proposed solution")}
              value={v.solutionId}
              onChange={selectSolution}
              items={options(
                cfg.solutions.filter(
                  (x) =>
                    x.enabled &&
                    x.nodes.every((n) =>
                      cfg.taskTypes.some((t) => t.id === n.typeId && t.enabled),
                    ),
                ),
              )}
              empty={tr("Choose solution…")}
              required
            />
            <CustomFields
              scope="rma"
              value={v.customFields}
              onChange={(x) => set("customFields", x)}
            />
          </div>
          {solution && (
            <WarrantyEvidence
              value={v.warrantyEvidence}
              onChange={(x) => set("warrantyEvidence", x)}
              payload={{
                productId: v.productId,
                solutionId: v.solutionId,
                platform: v.platform,
                warrantyEvidence: v.warrantyEvidence,
              }}
              onAssessment={setAssessment}
            />
          )}
          {solution && (
            <>
              <div className="support-section-title">
                <h3>{tr("Solution tasks")}</h3>
                <small>
                  {tr(
                    "Task types are fixed by this solution. Each approval is reviewed separately.",
                  )}
                </small>
              </div>
              <div className="workflow-preview">
                {solution.nodes.map((n) => {
                  const type = cfg.taskTypes.find((t) => t.id === n.typeId);
                  return (
                    <section className="workflow-node" key={n.key}>
                      <div className="workflow-node-heading">
                        <span className="count-circle">
                          {solution.nodes.indexOf(n) + 1}
                        </span>
                        <div>
                          <strong>{tr(type?.name || n.typeId)}</strong>
                          <small>
                            {(n.dependsOn || []).length
                              ? tr("After ") + (n.dependsOn || []).join(", ")
                              : tr("Independent task")}{" "}
                            ·{" "}
                            {["refund", "return_device"].includes(n.typeId)
                              ? tr("Approval always required")
                              : tr("Approval rules evaluated on submission")}
                          </small>
                        </div>
                      </div>
                      {type && (
                        <TaskParameters
                          type={type}
                          node={n}
                          value={inputs[n.key] || {}}
                          onChange={(x) => setInputs({ ...inputs, [n.key]: x })}
                          rmaProductId={v.productId}
                        />
                      )}
                    </section>
                  );
                })}
              </div>
            </>
          )}
        </div>
        {v.draftId && (
          <div className="ticket-draft-actions">
            <p className="muted">
              {tr("Udesk source snapshot")}: {v.ticketSnapshotId}
            </p>
            {duplicateRmaIds.length > 0 && (
              <p role="status">
                {tr("Existing RMAs for this ticket")}:{" "}
                {duplicateRmaIds.join(", ")}
              </p>
            )}
            <Button
              disabled={busy}
              onClick={async () => {
                try {
                  setError("");
                  const saved = await api(
                    `/api/tickets/${encodeURIComponent(initial.ticketId || initial.sourceTicketId || "")}/drafts`,
                    {
                      method: "POST",
                      body: JSON.stringify({ ...v, taskInputs: inputs }),
                    },
                  );
                  setV({ ...v, ...saved.payload });
                  setDraftMessage(tr("Draft saved"));
                } catch (e) {
                  setError(e.message);
                }
              }}
            >
              Save draft
            </Button>
            {draftMessage && <span role="status">{draftMessage}</span>}
          </div>
        )}
        <Footer
          busy={busy}
          error={tr(error)}
          onClose={onClose}
          label={tr("Create RMA")}
          disabled={!assessment?.eligible}
        />
      </form>
    </Dialog>
  );
}
export function RMAs({ query = "" }) {
  const { state: s, can } = useWorkspace(),
    [editor, setEditor] = useState(null),
    rows = s.rmas.map((r) => ({ ...r, product: sku(s, r.productId) }));
  return (
    <>
      <Heading>
        <Export collection="rmas" />
        {can("rma.create") && (
          <Button kind="primary" onClick={() => setEditor({ create: true })}>
            <Icon name="plus" />
            {tr("Create RMA")}
          </Button>
        )}
      </Heading>
      <section className="stat-grid compact">
        <Stat
          label={tr(admin(s) ? "All RMAs" : "My RMAs")}
          value={rows.length}
          caption={tr(
            admin(s)
              ? "Every creator · full visibility"
              : "Only records you created",
          )}
        />
        <Stat
          label={tr("Awaiting approval")}
          value={rows.filter((r) => r.status === "pending_approval").length}
          caption={tr("Independent task reviews")}
        />
        <Stat
          label={tr("Completed")}
          value={rows.filter((r) => r.status === "completed").length}
          caption={tr("All solution tasks complete")}
        />
      </section>
      <FilteredTable
        scope="rma"
        initialQuery={query}
        rows={rows}
        dateKey="createdAt"
        filters={[
          { key: "platform", label: "Platform" },
          { key: "solutionName", label: "Solution" },
          {
            key: "primaryCause",
            label: "Primary cause",
            items: Object.entries(labels).map(([value, label]) => ({
              value,
              label,
            })),
          },
          { key: "rootCauseName", label: "Root cause" },
          ...(admin(s) ? [{ key: "ownerName", label: "Creator" }] : []),
        ]}
        statuses={[
          "pending_approval",
          "in_progress",
          "needs_attention",
          "completed",
        ]}
        columns={[
          col("RMA / ticket", (r) => (
            <>
              <button
                className="text-button mono"
                onClick={() => setEditor({ id: r.id })}
              >
                {r.id}
              </button>
              <small className="cell-sub">
                {tr("Ticket ")}
                {r.ticketNumber}
              </small>
            </>
          )),
          col("Order / platform", (r) => (
            <>
              <strong>{r.orderNumber}</strong>
              <small className="cell-sub">{r.platformName}</small>
            </>
          )),
          col("Device / part", (r) => (
            <>
              <strong>{r.product}</strong>
              <small className="cell-sub">
                {r.sn || tr("No serial recorded")}
              </small>
            </>
          )),
          col("Root cause", (r) => (
            <>
              {r.rootCauseName}
              <small className="cell-sub">{labels[r.primaryCause]}</small>
            </>
          )),
          col("Solution / progress", (r) => (
            <>
              {tr(r.solutionName)}
              <small className="cell-sub">
                {r.completedTasks} / {r.taskCount}
                {tr(" tasks")}
              </small>
            </>
          )),
          ...(admin(s) ? [col("Creator", (r) => r.ownerName)] : []),
          col("Status", (r) => <Badge value={r.status} />),
          col(
            "Created",
            (r) => formatDate(r.createdAt, s.settings.timezone),
            "createdAt",
          ),
        ]}
      />
      <Note>
        {tr(
          "RMA history keeps the solution and task behavior used at creation. Configuration changes apply to new RMAs; editing an unstarted task re-evaluates its approval rules.",
        )}
      </Note>
      {editor?.create && <RMAForm onClose={() => setEditor(null)} />}
      {editor?.id && (
        <RMADetail id={editor.id} onClose={() => setEditor(null)} />
      )}
    </>
  );
}
function RMADetail({ id, onClose }) {
  const { state: s, can } = useWorkspace(),
    r = s.rmas.find((r) => r.id === id),
    tasks = s.rmaTasks
      .filter((t) => t.rmaId === id)
      .sort(
        (a, b) =>
          (r?.solutionSnapshot.nodes.findIndex((n) => n.key === a.key) ?? 0) -
          (r?.solutionSnapshot.nodes.findIndex((n) => n.key === b.key) ?? 0),
      ),
    [task, setTask] = useState(null),
    [note, setNote] = useState(""),
    { submit, busy, error } = useSupportAction();
  if (!r) return null;
  return (
    <>
      <Dialog
        title={tr(r.id)}
        subtitle={tr(
          `${tr(r.solutionName)} · Created by ${r.ownerName} · ${formatDate(r.createdAt, s.settings.timezone)}`,
        )}
        onClose={onClose}
        wide
      >
        <div className="modal-body">
          <div className="detail-grid">
            {[
              [tr("Support ticket"), r.ticketNumber],
              [tr("Order / platform"), r.orderNumber + " · " + r.platformName],
              [tr("Affected SKU"), sku(s, r.productId)],
              [tr("Serial number"), r.sn || "—"],
              [
                tr("Root cause"),
                tr(labels[r.primaryCause]) + " / " + tr(r.rootCauseName),
              ],
              [tr("Status"), title(r.status)],
            ].map(([k, v]) => (
              <div className="detail-field" key={k}>
                <small>{k}</small>
                <strong>{v}</strong>
              </div>
            ))}
            <FieldValues value={r.customFields} />
          </div>
          <AssessmentSummary assessment={r.eligibilityAssessment} />
          <div className="support-description">
            <small>{tr("Description")}</small>
            <p>{r.description}</p>
          </div>
          <div className="support-section-title">
            <h3>{tr("Task workflow")}</h3>
            <small>
              {tr("Configuration revision ")}
              {r.configRevision} · {r.completedTasks}/{r.taskCount}
              {tr(" completed")}
            </small>
          </div>
          <div className="workflow-preview">
            {tasks.map((t) => (
              <section className="workflow-node" key={t.id}>
                <div className="workflow-node-heading">
                  <Icon name={t.direction === "none" ? "check" : "logistics"} />
                  <div>
                    <strong>{tr(t.typeName)}</strong>
                    <small>
                      {t.key} · {money(t.amountCents)}
                      {t.productId
                        ? " · " + sku(s, t.productId) + " × " + t.qty
                        : ""}
                    </small>
                  </div>
                  <Badge value={t.status} />
                </div>
                <p className="help-text">
                  {(t.dependsOn || []).length
                    ? tr("Requires ") +
                      t.dependsOn
                        .map(
                          (id) =>
                            tasks.find((x) => x.id === id)?.typeName || id,
                        )
                        .join(" + ")
                    : tr("No prerequisites")}{" "}
                  {tr("· Approval: ")}
                  {title(t.approval)}
                </p>
                {t.approvalReasons?.length > 0 && (
                  <p className="help-text">{t.approvalReasons.join(" · ")}</p>
                )}
                {t.tracking && (
                  <p>
                    {t.carrier} · {t.tracking}
                  </p>
                )}
                <FieldValues value={t.customFields} />
                <FieldValues value={t.executionFields || {}} />
                <div className="row-actions">
                  <Button kind="small" onClick={() => setTask(t.id)}>
                    {tr("View task")}
                  </Button>
                  {can("rmatask.update") &&
                    !["completed", "in_progress"].includes(t.status) && (
                      <Button kind="small" onClick={() => setTask(t.id)}>
                        {tr("Edit task details")}
                      </Button>
                    )}
                </div>
              </section>
            ))}
          </div>
          <div className="support-section-title">
            <h3>{tr("Case notes")}</h3>
          </div>
          {r.notes?.map((n) => (
            <article className="case-note" key={n.id}>
              <strong>{n.actor}</strong>
              <small>{formatDate(n.at, s.settings.timezone)}</small>
              <p>{n.text}</p>
            </article>
          ))}
          {can("rma.note") && (
            <form
              className="support-note-form"
              onSubmit={async (e) => {
                e.preventDefault();
                if (
                  await submit(
                    "rma.note",
                    { id, text: note },
                    "Case note added.",
                  )
                )
                  setNote("");
              }}
            >
              <TextArea
                label={tr("Add case note")}
                value={note}
                onChange={setNote}
                required
                maxLength="2000"
              />
              <button className="btn primary" disabled={busy}>
                {tr("Add note")}
              </button>
              {error && <p className="form-error">{tr(error)}</p>}
            </form>
          )}
        </div>
        <div className="modal-footer">
          <span>{tr("Owner-scoped record · no external messages sent")}</span>
          <Button kind="secondary" onClick={onClose}>
            {tr("Close")}
          </Button>
        </div>
      </Dialog>
      {task && <TaskDialog id={task} onClose={() => setTask(null)} />}
    </>
  );
}
function TaskDialog({ id, onClose }) {
  const { state: s, can } = useWorkspace(),
    t = s.rmaTasks.find((x) => x.id === id),
    r = s.rmas.find((x) => x.id === t?.rmaId),
    [mode, setMode] = useState("history"),
    [openedRevision] = useState(t?.revision),
    [v, setV] = useState({
      amount: ((t?.amountCents || 0) / 100).toFixed(2),
      qty: t?.qty || 1,
      productId: t?.productId || "",
      customFields: t?.customFields || {},
      note: "",
      decision: "approved",
      operation: "complete",
      carrier: t?.carrier || "",
      tracking: t?.tracking || "",
      code: "",
      reference: "",
    }),
    { submit, busy, error } = useSupportAction(onClose);
  if (!t || !r) return null;
  const set = (k, x) => setV({ ...v, [k]: x }),
    editable =
      can("rmatask.update") && !["completed", "in_progress"].includes(t.status),
    review = admin(s) && can("rmatask.review") && t.approval === "pending",
    execute =
      admin(s) &&
      can("rmatask.execute") &&
      ["ready", "in_progress"].includes(t.status);
  return (
    <Dialog
      title={tr(t.typeName)}
      subtitle={tr("{task} · {rma} · Order {order}", {
        task: t.id,
        rma: r.id,
        order: r.orderNumber,
      })}
      onClose={onClose}
    >
      <div className="support-task-summary">
        <Badge value={t.status} />
        <Badge value={t.approval} />
        <strong>{money(t.amountCents)}</strong>
        {t.productId && (
          <small>
            {sku(s, t.productId)} × {t.qty}
          </small>
        )}
      </div>
      <div className="support-case-context">
        <strong>
          {r.ticketNumber} · {r.platformName} · {r.ownerName}
        </strong>
        <p>{r.description}</p>
        <small>
          {labels[r.primaryCause]} / {r.rootCauseName} · {tr(r.solutionName)}
        </small>
      </div>
      <Tabs
        value={mode}
        onChange={setMode}
        items={[
          ["history", "Details & history"],
          ...(editable ? [["edit", "Task details"]] : []),
          ...(review ? [["review", "Review approval"]] : []),
          ...(execute ? [["execute", "Record execution"]] : []),
        ]}
      />
      {mode === "history" ? (
        <>
          <div className="modal-body">
            <div className="detail-grid">
              <div className="detail-field">
                <small>{tr("Dependencies")}</small>
                <strong>
                  {t.dependsOn
                    .map(
                      (id) =>
                        s.rmaTasks.find((x) => x.id === id)?.typeName || id,
                    )
                    .join(", ") || tr("None")}
                </strong>
              </div>
              <div className="detail-field">
                <small>{tr("Approval reasons")}</small>
                <strong>
                  {t.approvalReasons?.join(" · ") || tr("No approval required")}
                </strong>
              </div>
              {t.tracking && (
                <div className="detail-field">
                  <small>{tr("Carrier / tracking")}</small>
                  <strong>
                    {t.carrier} · {t.tracking}
                  </strong>
                </div>
              )}
              {t.code && (
                <div className="detail-field">
                  <small>{tr("Sent code")}</small>
                  <strong>{t.code}</strong>
                </div>
              )}
              {t.reference && (
                <div className="detail-field">
                  <small>{tr("Transaction reference")}</small>
                  <strong>{t.reference}</strong>
                </div>
              )}
              <FieldValues value={t.customFields} />
              <FieldValues value={t.executionFields || {}} />
            </div>
            {t.events.map((e, i) => (
              <article className="case-note" key={i}>
                <strong>
                  {e.actor} · {title(e.decision || e.operation || e.action)}
                </strong>
                <small>{formatDate(e.at, s.settings.timezone)}</small>
                <p>{e.note || tr("Recorded in the audit trail.")}</p>
              </article>
            ))}
          </div>
          <div className="modal-footer">
            <span>
              {tr("Each task has its own approval and execution history.")}
            </span>
            <Button onClick={onClose}>{tr("Close")}</Button>
          </div>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (mode === "edit")
              submit(
                "rmatask.update",
                {
                  id,
                  expectedRevision: openedRevision,
                  amountCents: cents(v.amount),
                  qty: Number(v.qty),
                  productId: v.productId,
                  customFields: v.customFields,
                  note: v.note,
                },
                "Task details saved. Approval re-evaluated.",
              );
            else if (mode === "review")
              submit(
                "rmatask.review",
                {
                  id,
                  expectedRevision: openedRevision,
                  decision: v.decision,
                  note: v.note,
                },
                "Task review recorded.",
              );
            else
              submit(
                "rmatask.execute",
                { id, ...v, expectedRevision: openedRevision },
                "Task execution recorded locally.",
              );
          }}
        >
          <div className="modal-body">
            {mode === "edit" ? (
              <>
                <TaskParameters
                  type={t.typeSnapshot}
                  node={t}
                  value={v}
                  onChange={setV}
                  rmaProductId={r.productId}
                />
                <Note>
                  {tr(
                    "Changing task details invalidates the previous approval and checks current rules again.",
                  )}
                </Note>
              </>
            ) : mode === "review" ? (
              <>
                <div className="detail-grid">
                  <div className="detail-field">
                    <small>{tr("Value / quantity")}</small>
                    <strong>
                      {money(t.amountCents)} · {t.qty}
                      {tr(" unit(s)")}
                    </strong>
                  </div>
                  <div className="detail-field">
                    <small>{tr("SKU")}</small>
                    <strong>{sku(s, t.productId)}</strong>
                  </div>
                </div>
                <Select
                  label={tr("Decision")}
                  value={v.decision}
                  onChange={(x) => set("decision", x)}
                  items={["approved", "rejected"]}
                />
              </>
            ) : (
              <>
                <Note>
                  {tr(
                    "Record work performed outside Harbor. This action does not send money, codes, or shipments through an external service.",
                  )}
                </Note>
                <div className="form-grid">
                  <Select
                    label={tr("Execution action")}
                    value={v.operation}
                    onChange={(x) => set("operation", x)}
                    items={[
                      { value: "start", label: "Start work" },
                      ...(t.direction !== "none"
                        ? [
                            {
                              value: "dispatch",
                              label:
                                t.direction === "inbound"
                                  ? tr("Record return dispatched")
                                  : tr("Record dispatched"),
                            },
                          ]
                        : []),
                      {
                        value: "complete",
                        label:
                          t.direction === "inbound"
                            ? tr("Record returned device received")
                            : tr("Mark completed"),
                      },
                    ]}
                  />
                  {t.direction !== "none" && (
                    <>
                      <Input
                        label={tr("Carrier")}
                        value={v.carrier}
                        onChange={(x) => set("carrier", x)}
                        required={
                          v.operation === "dispatch" ||
                          (v.operation === "complete" && !t.dispatchedAt)
                        }
                      />
                      <Input
                        label={tr("Tracking number")}
                        value={v.tracking}
                        onChange={(x) => set("tracking", x)}
                        required={
                          v.operation === "dispatch" ||
                          (v.operation === "complete" && !t.dispatchedAt)
                        }
                      />
                    </>
                  )}
                  {t.typeSnapshot.requiresCode &&
                    v.operation === "complete" && (
                      <Input
                        label={tr(
                          t.typeId === "gift_card"
                            ? "Gift card code / delivery reference"
                            : "Promo code sent",
                        )}
                        value={v.code}
                        onChange={(x) => set("code", x)}
                        required
                      />
                    )}
                  <Input
                    label={tr("Transaction / fulfillment reference")}
                    value={v.reference}
                    onChange={(x) => set("reference", x)}
                    required={
                      t.typeId === "refund" && v.operation === "complete"
                    }
                  />
                </div>
              </>
            )}
            {mode === "execute" && v.operation === "complete" && (
              <div className="form-grid">
                <CustomFields
                  scope="execution"
                  typeId={t.typeId}
                  value={v.executionFields || {}}
                  onChange={(x) => set("executionFields", x)}
                />
              </div>
            )}
            <TextArea
              label={tr(mode === "review" ? "Review reason" : "Internal note")}
              value={v.note}
              onChange={(x) => set("note", x)}
              required={mode === "review"}
              maxLength="2000"
            />
          </div>
          <Footer
            busy={busy}
            error={tr(error)}
            onClose={onClose}
            label={tr(
              mode === "review"
                ? "Save review"
                : mode === "execute"
                  ? "Record execution"
                  : "Save task details",
            )}
          />
        </form>
      )}
    </Dialog>
  );
}
export function TaskCenter({
  query = "",
  logistics = false,
  embedded = false,
}) {
  const { state: s } = useWorkspace(),
    [task, setTask] = useState(null),
    rows = s.rmaTasks
      .filter(
        (t) =>
          !logistics ||
          (t.direction !== "none" &&
            !t.dispatchedAt &&
            t.status !== "completed"),
      )
      .map((t) => {
        const r = s.rmas.find((r) => r.id === t.rmaId);
        return {
          ...t,
          orderNumber: r?.orderNumber,
          platform: r?.platform,
          ownerName: r?.ownerName,
          ticketNumber: r?.ticketNumber,
          product: sku(s, t.productId),
        };
      });
  return (
    <>
      {!embedded && (
        <Heading>
          {!logistics && admin(s) && <Export collection="rmaTasks" />}
        </Heading>
      )}
      <section className="stat-grid compact">
        <Stat
          label={tr(logistics ? "Awaiting dispatch" : "Support tasks")}
          value={rows.length}
          caption={tr(
            logistics
              ? "Not dispatched · includes blocked and approval-pending tasks"
              : "Each task is tracked independently",
          )}
        />
        <Stat
          label={tr("Pending approval")}
          value={rows.filter((t) => t.approval === "pending").length}
          caption={tr("Returns, refunds, and matching rules")}
        />
        <Stat
          label={tr("Ready to work")}
          value={rows.filter((t) => t.status === "ready").length}
          caption={tr("Approved · prerequisites satisfied")}
        />
      </section>
      <FilteredTable
        scope="task"
        rows={rows}
        initialQuery={query}
        dateKey="createdAt"
        filters={[
          { key: "typeName", label: "Task type" },
          { key: "approval", label: "Approval" },
          { key: "direction", label: "Direction" },
          { key: "platform", label: "Platform" },
          ...(admin(s) ? [{ key: "ownerName", label: "Creator" }] : []),
        ]}
        statuses={[
          "pending_approval",
          "blocked",
          "ready",
          "in_progress",
          "completed",
          "rejected",
        ]}
        columns={[
          col("Task", (t) => (
            <>
              <button className="text-button" onClick={() => setTask(t.id)}>
                {tr(t.typeName)}
              </button>
              <small className="cell-sub mono">{t.id}</small>
            </>
          )),
          col("RMA / order", (t) => (
            <>
              <strong>{t.rmaId}</strong>
              <small className="cell-sub">
                {t.orderNumber} · {t.platform}
              </small>
            </>
          )),
          col("SKU / value", (t) => (
            <>
              {t.product}
              <small className="cell-sub">
                {t.qty}
                {tr(" unit(s) · ")}
                {money(t.amountCents)}
              </small>
            </>
          )),
          col("Approval", (t) => <Badge value={t.approval} />),
          col("Status", (t) => <Badge value={t.status} />),
          col("Creator", (t) => t.ownerName),
          col("Logistics", (t) =>
            t.tracking ? (
              <>
                {t.carrier}
                <small className="cell-sub">{t.tracking}</small>
              </>
            ) : t.direction === "none" ? (
              "—"
            ) : (
              title(t.direction) + " · Not dispatched"
            ),
          ),
          col("", (t) => (
            <Button kind="small" onClick={() => setTask(t.id)}>
              {tr("Open task")}
            </Button>
          )),
        ]}
      />
      {logistics && (
        <Note>
          {tr(
            "Grouped by task so partially fulfilled RMAs remain visible. Outbound replacements/parts and inbound returns can be filtered separately. A recorded dispatch removes that task from this queue.",
          )}
        </Note>
      )}
      {task && <TaskDialog id={task} onClose={() => setTask(null)} />}
    </>
  );
}
export function AwaitingDispatch({ query = "" }) {
  const { state: s } = useWorkspace(),
    [view, setView] = useState("rmas"),
    [id, setId] = useState(null);
  const waiting = s.rmaTasks.filter(
      (t) =>
        t.direction !== "none" && !t.dispatchedAt && t.status !== "completed",
    ),
    rows = s.rmas
      .filter((r) => waiting.some((t) => t.rmaId === r.id))
      .map((r) => {
        const tasks = waiting.filter((t) => t.rmaId === r.id);
        return {
          ...r,
          unsent: tasks.length,
          taskNames: tasks.map((t) => t.typeName).join(", "),
          direction: [...new Set(tasks.map((t) => t.direction))]
            .sort()
            .join(" + "),
          pending: tasks.filter((t) => t.approval === "pending").length,
        };
      });
  return (
    <>
      <Heading />
      <Tabs
        value={view}
        onChange={setView}
        items={[
          ["rmas", "By RMA", rows.length],
          ["tasks", "By task", waiting.length],
        ]}
      />
      {view === "tasks" ? (
        <TaskCenter query={query} logistics embedded />
      ) : (
        <>
          <section className="stat-grid compact">
            <Stat
              label={tr("RMAs awaiting dispatch")}
              value={rows.length}
              caption={tr("At least one logistics task has not shipped")}
            />
            <Stat
              label={tr("Unsent logistics tasks")}
              value={waiting.length}
              caption={tr("Returns, replacements, and support parts")}
            />
            <Stat
              label={tr("Awaiting approval")}
              value={waiting.filter((t) => t.approval === "pending").length}
              caption={tr("These tasks remain in the queue")}
            />
          </section>
          <FilteredTable
            rows={rows}
            initialQuery={query}
            scope="rma"
            dateKey="createdAt"
            filters={[
              { key: "platform", label: "Platform" },
              { key: "direction", label: "Direction" },
              ...(admin(s) ? [{ key: "ownerName", label: "Creator" }] : []),
            ]}
            statuses={["pending_approval", "in_progress", "needs_attention"]}
            columns={[
              col("RMA / ticket", (r) => (
                <>
                  <button
                    className="text-button mono"
                    onClick={() => setId(r.id)}
                  >
                    {r.id}
                  </button>
                  <small className="cell-sub">{r.ticketNumber}</small>
                </>
              )),
              col("Order / platform", (r) => (
                <>
                  {r.orderNumber}
                  <small className="cell-sub">{r.platformName}</small>
                </>
              )),
              col("Unsent tasks", (r) => (
                <>
                  <strong>
                    {r.unsent}
                    {tr(" task(s)")}
                  </strong>
                  <small className="cell-sub">{r.taskNames}</small>
                </>
              )),
              col("Pending approvals", (r) => r.pending),
              col("Creator", (r) => r.ownerName),
              col("Status", (r) => <Badge value={r.status} />),
            ]}
          />
          <Note>
            {tr(
              "An RMA remains here until all its logistics tasks have a recorded dispatch. Switch to By task to review each shipment or return separately.",
            )}
          </Note>
        </>
      )}
      {id && <RMADetail id={id} onClose={() => setId(null)} />}
    </>
  );
}
function orderRows(s) {
  return [
    ...s.supportOrders.map((x) => ({ ...x, source: "Support order" })),
    ...s.sales.map((x) => ({
      ...x,
      orderNumber: x.id,
      platform: x.channel,
      purchasedAt: x.createdAt.slice(0, 10),
      productId: x.lines[0]?.productId,
      source: "ERP sale",
    })),
  ];
}
export function SupportOrders({ query = "" }) {
  const { state: s, can } = useWorkspace(),
    [editor, setEditor] = useState(null),
    [create, setCreate] = useState(null);
  const rows = orderRows(s).map((r) => ({
    ...r,
    product: sku(s, r.productId),
  }));
  return (
    <>
      <Heading>
        <Export collection="supportOrders" />
        {admin(s) && can("supportorder.save") && (
          <Button kind="primary" onClick={() => setEditor({})}>
            <Icon name="plus" />
            {tr("Add support order")}
          </Button>
        )}
      </Heading>
      <FilteredTable
        scope="order"
        rows={rows}
        initialQuery={query}
        dateKey="purchasedAt"
        filters={[
          { key: "platform", label: "Platform" },
          { key: "source", label: "Source" },
          { key: "product", label: "Product" },
        ]}
        statuses={[
          "placed",
          "paid",
          "draft",
          "confirmed",
          "shipped",
          "delivered",
          "completed",
          "cancelled",
        ]}
        columns={[
          col(
            "Order number",
            (r) => <strong className="mono">{r.orderNumber}</strong>,
            "orderNumber",
          ),
          col("Customer", (r) => r.customer, "customer"),
          col("Platform", (r) => r.platform),
          col("SKU", (r) => r.product),
          col(
            "Purchased",
            (r) => formatDate(r.purchasedAt, s.settings.timezone),
            "purchasedAt",
          ),
          col("Status", (r) => <Badge value={r.status} />),
          col("Source", (r) => r.source),
          col(
            "RMAs",
            (r) =>
              s.rmas.filter(
                (x) =>
                  x.orderNumber === r.orderNumber && x.platform === r.platform,
              ).length,
          ),
          col("", (r) => (
            <div className="row-actions">
              {r.source === "Support order" &&
                admin(s) &&
                can("supportorder.save") && (
                  <Button kind="small" onClick={() => setEditor(r)}>
                    {tr("Edit order")}
                  </Button>
                )}
              {can("rma.create") && (
                <Button kind="small" onClick={() => setCreate(r)}>
                  {tr("Create RMA")}
                </Button>
              )}
            </div>
          )),
        ]}
      />
      <Note>
        {tr(
          "Support orders are local records. Existing ERP sales are also searchable when your sales permission allows them. No marketplace synchronization is configured.",
        )}
      </Note>
      {editor && (
        <RecordForm
          kind="order"
          record={editor}
          onClose={() => setEditor(null)}
        />
      )}
      {create && <RMAForm initial={create} onClose={() => setCreate(null)} />}
    </>
  );
}
export function Serials({ query = "" }) {
  const { state: s, can } = useWorkspace(),
    [editor, setEditor] = useState(null),
    [detail, setDetail] = useState(null),
    rows = s.serials.map((r) => ({ ...r, product: sku(s, r.productId) }));
  return (
    <>
      <Heading>
        <Export collection="serials" />
        {admin(s) && can("serial.save") && (
          <Button kind="primary" onClick={() => setEditor({})}>
            <Icon name="plus" />
            {tr("Register serial")}
          </Button>
        )}
      </Heading>
      <FilteredTable
        scope="serial"
        rows={rows}
        initialQuery={query}
        filters={[
          { key: "kind", label: "Serial type" },
          { key: "product", label: "Product" },
          { key: "parentSn", label: "Parent device" },
        ]}
        statuses={["in_stock", "sold", "returned", "replaced", "retired"]}
        columns={[
          col(
            "Serial number",
            (r) => <strong className="mono">{r.sn}</strong>,
            "sn",
          ),
          col("Type", (r) => <Badge value={r.kind} />),
          col("SKU", (r) => r.product),
          col("Parent device SN", (r) => r.parentSn || "—"),
          col("Order number", (r) => r.orderNumber || "—"),
          col("Status", (r) => <Badge value={r.status} />),
          col("RMA history", (r) => (
            <div className="row-actions">
              {s.rmas
                .filter((x) => x.sn.toLowerCase() === r.sn.toLowerCase())
                .map((x) => (
                  <Button
                    key={x.id}
                    kind="small"
                    onClick={() => setDetail(x.id)}
                  >
                    {x.id}
                  </Button>
                ))}
            </div>
          )),
          col(
            "",
            (r) =>
              admin(s) &&
              can("serial.save") && (
                <Button kind="small" onClick={() => setEditor(r)}>
                  {tr("Edit serial")}
                </Button>
              ),
          ),
        ]}
      />
      <Note>
        {tr(
          "Device and printhead serials use a case-insensitive unique registry. Printheads can be linked to their parent device serial and original order.",
        )}
      </Note>
      {editor && (
        <RecordForm
          kind="serial"
          record={editor}
          onClose={() => setEditor(null)}
        />
      )}
      {detail && <RMADetail id={detail} onClose={() => setDetail(null)} />}
    </>
  );
}
function RecordForm({ kind, record, onClose }) {
  const { state: s } = useWorkspace(),
    [v, setV] = useState({
      orderNumber: "",
      customer: "",
      platform: "",
      productId: "",
      purchasedAt: today(),
      status: kind === "order" ? "delivered" : "in_stock",
      sn: "",
      kind: "device",
      parentSn: "",
      customFields: {},
      ...record,
    }),
    { submit, busy, error } = useSupportAction(onClose),
    set = (k, x) => setV({ ...v, [k]: x });
  const products =
    kind === "order"
      ? s.products
      : s.products.filter((p) =>
          v.kind === "device"
            ? p.productType === "device"
            : p.productType === "part" && p.partKind === "printhead",
        );
  return (
    <Dialog
      title={tr(
        kind === "order"
          ? record.id
            ? "Edit support order"
            : "Add support order"
          : record.id
            ? "Edit serial"
            : "Register serial",
      )}
      subtitle={tr("Maintain a local record and its configured custom fields.")}
      onClose={onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(
            kind === "order" ? "supportorder.save" : "serial.save",
            v,
            "Record saved.",
          );
        }}
      >
        <div className="modal-body">
          <div className="form-grid">
            {kind === "order" ? (
              <>
                <Input
                  label={tr("Order number")}
                  value={v.orderNumber}
                  onChange={(x) => set("orderNumber", x)}
                  required
                />
                <Input
                  label={tr("Customer")}
                  value={v.customer}
                  onChange={(x) => set("customer", x)}
                  required
                />
                <Select
                  label={tr("Platform")}
                  value={v.platform}
                  onChange={(x) => set("platform", x)}
                  items={options(
                    s.supportConfig.platforms.filter((p) => p.enabled),
                  )}
                  empty={tr("Choose platform…")}
                  required
                />
                <Input
                  label={tr("Purchase date")}
                  type="date"
                  value={v.purchasedAt}
                  onChange={(x) => set("purchasedAt", x)}
                  required
                />
              </>
            ) : (
              <>
                <Input
                  label={tr("Serial number")}
                  value={v.sn}
                  onChange={(x) => set("sn", x)}
                  required
                />
                <Select
                  label={tr("Serial type")}
                  value={v.kind}
                  onChange={(x) =>
                    setV({ ...v, kind: x, productId: "", parentSn: "" })
                  }
                  items={["device", "printhead"]}
                />
                {v.kind === "printhead" && (
                  <Select
                    label={tr("Parent device SN")}
                    value={v.parentSn}
                    onChange={(x) => set("parentSn", x)}
                    items={s.serials
                      .filter((x) => x.kind === "device")
                      .map((x) => ({ value: x.sn, label: x.sn }))}
                    empty={tr("No parent device")}
                  />
                )}
                <Input
                  label={tr("Order number (optional)")}
                  value={v.orderNumber}
                  onChange={(x) => set("orderNumber", x)}
                />
              </>
            )}
            <Select
              label={tr("SKU")}
              value={v.productId}
              onChange={(x) => set("productId", x)}
              items={products.map((p) => ({
                value: p.id,
                label: sku(s, p.id),
              }))}
              empty={tr("Choose SKU…")}
              required
            />
            <Select
              label={tr("Status")}
              value={v.status}
              onChange={(x) => set("status", x)}
              items={
                kind === "order"
                  ? ["placed", "paid", "shipped", "delivered", "cancelled"]
                  : ["in_stock", "sold", "returned", "replaced", "retired"]
              }
            />
            <CustomFields
              scope={kind}
              value={v.customFields}
              onChange={(x) => set("customFields", x)}
            />
          </div>
        </div>
        <Footer busy={busy} error={tr(error)} onClose={onClose} />
      </form>
    </Dialog>
  );
}
export function Benefits({ query = "" }) {
  const { state: s } = useWorkspace(),
    rows = s.benefitHistory.map((x) => ({
      ...x,
      typeName:
        s.rmaTasks.find((t) => t.id === x.taskId)?.typeName || title(x.typeId),
    }));
  return (
    <>
      <Heading>
        <Export collection="benefitHistory" />
      </Heading>
      <section className="stat-grid compact">
        <Stat
          label={tr("Gift cards recorded sent")}
          value={rows.filter((x) => x.typeId === "gift_card").length}
          caption={tr("Completed gift card tasks")}
        />
        <Stat
          label={tr("Total gift card value")}
          value={money(
            rows
              .filter((x) => x.typeId === "gift_card")
              .reduce((a, x) => a + x.amountCents, 0),
          )}
          caption={tr("Recorded value · USD")}
        />
        <Stat
          label={tr("Promo codes recorded sent")}
          value={rows.filter((x) => x.typeId === "promo_code").length}
          caption={tr("Completed promo code tasks")}
        />
      </section>
      <FilteredTable
        rows={rows}
        initialQuery={query}
        dateKey="sentAt"
        filters={[
          { key: "typeName", label: "Benefit type" },
          { key: "platform", label: "Platform" },
          { key: "sentBy", label: "Recorded by" },
        ]}
        columns={[
          col("Benefit", (x) => <Badge value={x.typeId} />),
          col("Code / reference", (x) => (
            <strong className="mono">{x.code}</strong>
          )),
          col(
            "Value",
            (x) => (x.typeId === "gift_card" ? money(x.amountCents) : "—"),
            "amountCents",
          ),
          col("RMA", (x) => x.rmaId),
          col("Order / platform", (x) => (
            <>
              {x.orderNumber}
              <small className="cell-sub">{x.platform}</small>
            </>
          )),
          col("Recorded by", (x) => x.sentBy),
          col(
            "Sent date",
            (x) => formatDate(x.sentAt, s.settings.timezone),
            "sentAt",
          ),
        ]}
      />
      <Note>
        {tr(
          "History is created once when a gift card or promo code task completes. These are recorded external fulfillments; Harbor does not issue or transmit codes.",
        )}
      </Note>
    </>
  );
}
const configTabs = [
  ["solutions", "Solutions & DAG"],
  ["rules", "Approval rules"],
  ["rootCauses", "Root causes"],
  ["platforms", "Platforms"],
  ["fields", "Custom fields"],
  ["taskTypes", "Task types"],
];
export function SupportConfig() {
  const { state: s } = useWorkspace(),
    [tab, setTab] = useState("solutions"),
    [editor, setEditor] = useState(null);
  if (!admin(s))
    return (
      <Panel>
        <h2>{tr("Administrator access required")}</h2>
      </Panel>
    );
  const rows = s.supportConfig[tab].map((r) => ({
    ...r,
    status: r.enabled ? "active" : "inactive",
    summary:
      tab === "solutions"
        ? r.nodes
            .map(
              (n) =>
                s.supportConfig.taskTypes.find((t) => t.id === n.typeId)
                  ?.name || n.typeId,
            )
            .join(" → ")
        : tab === "rootCauses"
          ? labels[r.primary]
          : tab === "rules"
            ? `${r.typeId} · ${r.field} ${r.operator} ${r.field === "amountCents" ? money(r.value) : r.value}`
            : tab === "fields"
              ? `${title(r.scope)} · ${r.fieldType} · ${r.required ? tr("Required") : tr("Optional")}`
              : tab === "taskTypes"
                ? `${title(r.direction)} · ${r.hasAmount ? tr("Value required") : tr("No value")}`
                : r.id,
  }));
  return (
    <>
      <Heading>
        <Button kind="primary" onClick={() => setEditor({})}>
          <Icon name="plus" />
          {tr("Add")}{" "}
          {
            {
              solutions: "solution",
              rules: "rule",
              rootCauses: "root cause",
              platforms: "platform",
              fields: "field",
              taskTypes: "task type",
            }[tab]
          }
        </Button>
      </Heading>
      <Tabs
        items={configTabs}
        value={tab}
        onChange={(x) => {
          setTab(x);
          setEditor(null);
        }}
      />
      <div className="support-config-callout">
        <Icon name="settings" />
        <div>
          <strong>{tr("Configure the workflow, keep the history.")}</strong>
          <p>
            {tr("Revision ")}
            {s.supportConfig.revision}
            {tr(
              ". Changes affect new RMAs. Existing tasks retain their solution and task-type snapshots. Returns and refunds always require approval.",
            )}
          </p>
        </div>
      </div>
      <FilteredTable
        key={tab}
        rows={rows}
        filters={[
          ...(tab === "rootCauses"
            ? [{ key: "primary", label: "Primary cause" }]
            : []),
          ...(tab === "fields" ? [{ key: "scope", label: "Scope" }] : []),
        ]}
        statuses={["active", "inactive"]}
        columns={[
          col(
            "Name",
            (r) => (
              <>
                <strong>{tr(r.name)}</strong>
                <small className="cell-sub mono">{r.id}</small>
              </>
            ),
            "name",
          ),
          col("Configuration", (r) => (
            <span className="config-summary">{tr(r.summary)}</span>
          )),
          ...(tab === "rootCauses"
            ? [
                col("Applies to", (r) =>
                  r.productIds.length
                    ? r.productIds.map((id) => sku(s, id)).join(", ")
                    : tr("All device / part SKUs"),
                ),
              ]
            : []),
          col("Status", (r) => <Badge value={r.status} />),
          col("", (r) => (
            <Button kind="small" onClick={() => setEditor(r)}>
              {tr("Edit configuration")}
            </Button>
          )),
        ]}
      />
      {tab === "rules" && (
        <Note>
          {tr(
            "Rules add approval requirements when they match; multiple matching rules are combined. Amount thresholds use USD. Mandatory return/refund approvals cannot be switched off.",
          )}
        </Note>
      )}
      {tab === "solutions" && (
        <Note>
          {tr(
            "Tasks may run in parallel or depend on multiple earlier tasks. The server rejects cycles and missing dependency keys. Users choose a solution, never individual task types.",
          )}
        </Note>
      )}
      {tab === "fields" && (
        <Note>
          {tr(
            "Add text, long text, select, number, and date fields to RMA, task, execution, product, support-order and serial forms. Mark fields required or disable them without changing code.",
          )}
        </Note>
      )}
      {editor && (
        <ConfigEditor
          key={tab + "-" + (editor.id || "new")}
          entity={tab}
          record={editor}
          onClose={() => setEditor(null)}
        />
      )}
    </>
  );
}
function ConfigEditor({ entity, record, onClose }) {
  const { state: s } = useWorkspace(),
    cfg = s.supportConfig;
  const defaults = {
    id: "",
    name: "",
    enabled: true,
    primary: "device_issue",
    productIds: [],
    typeId: entity === "rules" ? "*" : "",
    field: "amountCents",
    operator: "gt",
    value: 0,
    scope: "rma",
    fieldType: "text",
    required: false,
    options: [],
    direction: "none",
    hasAmount: false,
    requiresCode: false,
    requiresProduct: false,
    alwaysApprove: false,
    nodes: [],
    platforms: [],
    requiresWarranty: warrantyRequired(record),
  };
  const [v, setV] = useState({ ...defaults, ...record }),
    [amount, setAmount] = useState(((record.value || 0) / 100).toFixed(2)),
    [configRevision] = useState(cfg.revision),
    { submit, busy, error, setError } = useSupportAction(onClose),
    set = (k, x) => setV({ ...v, [k]: x });
  const nodeSet = (i, key, value) =>
    setV({
      ...v,
      nodes: v.nodes.map((n, j) => ({
        ...n,
        ...(j === i ? { [key]: value } : {}),
        ...(key === "key"
          ? {
              dependsOn: (n.dependsOn || []).map((k) =>
                k === v.nodes[i].key ? value : k,
              ),
            }
          : {}),
      })),
    });
  return (
    <Dialog
      title={tr(
        (record.id ? "Edit " : "Add ") +
          {
            solutions: "solution",
            rules: "approval rule",
            rootCauses: "root cause",
            platforms: "platform",
            fields: "custom field",
            taskTypes: "task type",
          }[entity],
      )}
      subtitle={tr(
        "Changes are validated and saved to the support configuration.",
      )}
      onClose={onClose}
      wide={entity === "solutions"}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          try {
            const r = { ...v };
            if (entity === "rules" && v.field === "amountCents")
              r.value = cents(amount);
            if (entity === "solutions")
              r.nodes = v.nodes.map((n) => ({
                ...n,
                amountCents: cents(
                  n.amount ?? ((n.amountCents || 0) / 100).toFixed(2),
                ),
                qty: Number(n.qty || 1),
              }));
            submit(
              "rmaconfig.save",
              { entity, record: r, expectedConfigRevision: configRevision },
              "Support configuration saved.",
            );
          } catch (e) {
            setError(e.message);
          }
        }}
      >
        <div className="modal-body">
          <div className="form-grid">
            <Input
              label={tr("Name")}
              value={v.name}
              onChange={(x) => set("name", x)}
              required
              maxLength="120"
            />
            <Input
              label={tr("Stable key (optional for new records)")}
              value={v.id}
              onChange={(x) => set("id", x)}
              disabled={!!record.id}
              pattern="[a-zA-Z0-9_-]+"
            />
            <Toggle
              label={tr("Enabled")}
              checked={v.enabled}
              onChange={(x) => set("enabled", x)}
            />
            {entity === "solutions" && (
              <>
                <Toggle
                  label={tr("Requires active warranty")}
                  checked={v.requiresWarranty}
                  onChange={(x) => set("requiresWarranty", x)}
                />
                <label className="full-field">
                  {tr("Eligible SKUs (empty = all)")}
                  <select
                    aria-label={tr("Eligible SKUs (empty = all)")}
                    multiple
                    size="4"
                    value={v.productIds}
                    onChange={(e) =>
                      set(
                        "productIds",
                        Array.from(e.target.selectedOptions, (x) => x.value),
                      )
                    }
                  >
                    {s.products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {sku(s, p.id)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {tr("Eligible platforms (empty = all)")}
                  <select
                    aria-label={tr("Eligible platforms (empty = all)")}
                    multiple
                    value={v.platforms}
                    onChange={(e) =>
                      set(
                        "platforms",
                        Array.from(e.target.selectedOptions, (x) => x.value),
                      )
                    }
                  >
                    {cfg.platforms.map((p) => (
                      <option key={p.id} value={p.id}>
                        {tr(p.name)}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
            {entity === "rootCauses" && (
              <>
                <Select
                  label={tr("Primary label")}
                  value={v.primary}
                  onChange={(x) => set("primary", x)}
                  items={Object.entries(labels).map(([value, label]) => ({
                    value,
                    label,
                  }))}
                />
                <label className="full-field">
                  {tr("Applies to device / part SKUs")}
                  <select
                    multiple
                    size="6"
                    value={v.productIds}
                    onChange={(e) =>
                      set(
                        "productIds",
                        Array.from(e.target.selectedOptions, (x) => x.value),
                      )
                    }
                  >
                    {s.products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {sku(s, p.id)}
                      </option>
                    ))}
                  </select>
                  <small>
                    {tr(
                      "Leave empty for all SKUs. Use Command/Ctrl to select multiple.",
                    )}
                  </small>
                  <Button kind="small" onClick={() => set("productIds", [])}>
                    {tr("Apply to all SKUs")}
                  </Button>
                </label>
              </>
            )}
            {entity === "rules" && (
              <>
                <Select
                  label={tr("Task type")}
                  value={v.typeId}
                  onChange={(x) => set("typeId", x)}
                  items={[
                    { value: "*", label: "Any task type" },
                    ...options(cfg.taskTypes),
                  ]}
                />
                <Select
                  label={tr("Condition field")}
                  value={v.field}
                  onChange={(x) => setV({ ...v, field: x, value: 0 })}
                  items={[
                    { value: "amountCents", label: "Task value ($)" },
                    { value: "qty", label: "Task quantity" },
                    { value: "platform", label: "Purchased platform key" },
                    { value: "rootCauseId", label: "Root cause key" },
                    { value: "primaryCause", label: "Primary cause key" },
                    { value: "productId", label: "Affected SKU ID" },
                  ]}
                />
                <Select
                  label={tr("Condition")}
                  value={v.operator}
                  onChange={(x) => set("operator", x)}
                  items={[
                    { value: "always", label: "Always require approval" },
                    { value: "gt", label: "Greater than" },
                    { value: "gte", label: "Greater than or equal to" },
                    { value: "eq", label: "Equals" },
                  ]}
                />
                {v.operator !== "always" &&
                  (v.field === "amountCents" ? (
                    <Input
                      label={tr("Threshold ($)")}
                      type="number"
                      min="0"
                      max="5000000"
                      step="0.01"
                      value={amount}
                      onChange={setAmount}
                      required
                    />
                  ) : (
                    <Input
                      label={tr("Condition value")}
                      type={v.field === "qty" ? "number" : "text"}
                      min={v.field === "qty" ? 0 : undefined}
                      value={v.value}
                      onChange={(x) =>
                        set("value", v.field === "qty" ? Number(x) : x)
                      }
                      required
                    />
                  ))}
              </>
            )}
            {entity === "fields" && (
              <>
                <Select
                  label={tr("Form scope")}
                  value={v.scope}
                  onChange={(x) => setV({ ...v, scope: x, typeId: "" })}
                  items={[
                    "rma",
                    "task",
                    "execution",
                    "order",
                    "serial",
                    "product",
                  ]}
                />
                <Select
                  label={tr("Field type")}
                  value={v.fieldType}
                  onChange={(x) => set("fieldType", x)}
                  items={["text", "textarea", "select", "number", "date"]}
                />
                <Toggle
                  label={tr("Required")}
                  checked={v.required}
                  onChange={(x) => set("required", x)}
                />
                {["task", "execution"].includes(v.scope) && (
                  <Select
                    label={tr("Applies to task type")}
                    value={v.typeId}
                    onChange={(x) => set("typeId", x)}
                    items={options(cfg.taskTypes)}
                    empty={tr("All task types")}
                  />
                )}
                {v.fieldType === "select" && (
                  <TextArea
                    label={tr("Options (one per line)")}
                    value={v.options.join("\n")}
                    onChange={(x) => set("options", x.split("\n"))}
                    required
                  />
                )}
              </>
            )}
            {entity === "taskTypes" && (
              <>
                <Select
                  label={tr("Logistics direction")}
                  value={v.direction}
                  onChange={(x) => set("direction", x)}
                  items={["none", "outbound", "inbound"]}
                />
                <Toggle
                  label={tr("Always require approval")}
                  checked={v.alwaysApprove}
                  onChange={(x) => set("alwaysApprove", x)}
                />
                <Toggle
                  label={tr("Requires positive monetary value")}
                  checked={v.hasAmount}
                  onChange={(x) => set("hasAmount", x)}
                />
                <Toggle
                  label={tr("Requires sent code / reference on completion")}
                  checked={v.requiresCode}
                  onChange={(x) => set("requiresCode", x)}
                />
                <Toggle
                  label={tr("Requires SKU and quantity")}
                  checked={v.requiresProduct}
                  onChange={(x) => set("requiresProduct", x)}
                />
                {record.builtIn && (
                  <p className="help-text full-field">
                    {tr(
                      "Built-in execution behavior is protected. Name and enabled status are editable; add a custom type for other behavior.",
                    )}
                  </p>
                )}
              </>
            )}
          </div>
          {entity === "solutions" && (
            <>
              <div className="support-section-title">
                <h3>{tr("Task DAG")}</h3>
                <small>
                  {tr(
                    "Add nodes, set their defaults, and select dependencies. Unconnected nodes run independently.",
                  )}
                </small>
              </div>
              <div className="workflow-preview">
                {v.nodes.map((n, i) => (
                  <section className="workflow-node" key={i}>
                    <div className="workflow-node-heading">
                      <span className="count-circle">{i + 1}</span>
                      <strong>{n.key || tr("New task")}</strong>
                      <Button
                        kind="small danger-quiet"
                        onClick={() =>
                          set(
                            "nodes",
                            v.nodes
                              .filter((_, j) => i !== j)
                              .map((x) => ({
                                ...x,
                                dependsOn: (x.dependsOn || []).filter(
                                  (key) => key !== n.key,
                                ),
                              })),
                          )
                        }
                      >
                        {tr("Remove node")}
                      </Button>
                    </div>
                    <div className="form-grid">
                      <Input
                        label={tr("Node key")}
                        value={n.key}
                        onChange={(x) => nodeSet(i, "key", x)}
                        pattern="[a-zA-Z0-9_-]+"
                        required
                      />
                      <Select
                        label={tr("Task type")}
                        value={n.typeId}
                        onChange={(x) => nodeSet(i, "typeId", x)}
                        items={options(cfg.taskTypes.filter((t) => t.enabled))}
                        empty={tr("Choose task type…")}
                        required
                      />
                      <Input
                        label={tr("Default value ($)")}
                        type="number"
                        min="0"
                        max="5000000"
                        step="0.01"
                        value={
                          n.amount ?? ((n.amountCents || 0) / 100).toFixed(2)
                        }
                        onChange={(x) => nodeSet(i, "amount", x)}
                      />
                      <Input
                        label={tr("Default quantity")}
                        type="number"
                        min="1"
                        max="1000000"
                        step="1"
                        value={n.qty || 1}
                        onChange={(x) => nodeSet(i, "qty", x)}
                      />
                      <Select
                        label={tr("Default SKU")}
                        value={n.productId || ""}
                        onChange={(x) => nodeSet(i, "productId", x)}
                        items={s.products.map((p) => ({
                          value: p.id,
                          label: sku(s, p.id),
                        }))}
                        empty={tr("Selected RMA device / user input")}
                      />
                    </div>
                    <div className="node-dependencies">
                      <strong>{tr("Wait for these nodes")}</strong>
                      {v.nodes
                        .filter((_, j) => i !== j)
                        .map((x, j) => (
                          <Toggle
                            key={j}
                            label={tr(x.key || "Unnamed node")}
                            checked={(n.dependsOn || []).includes(x.key)}
                            onChange={(checked) =>
                              nodeSet(
                                i,
                                "dependsOn",
                                checked
                                  ? [
                                      ...new Set([
                                        ...(n.dependsOn || []),
                                        x.key,
                                      ]),
                                    ]
                                  : (n.dependsOn || []).filter(
                                      (k) => k !== x.key,
                                    ),
                              )
                            }
                          />
                        ))}
                      {v.nodes.length === 1 && (
                        <small>
                          {tr("No other nodes; this task runs independently.")}
                        </small>
                      )}
                    </div>
                  </section>
                ))}
              </div>
              <Button
                kind="secondary"
                onClick={() =>
                  set("nodes", [
                    ...v.nodes,
                    {
                      key: "task_" + (v.nodes.length + 1),
                      typeId: "",
                      dependsOn: [],
                      amountCents: 0,
                      qty: 1,
                      productId: "",
                    },
                  ])
                }
              >
                <Icon name="plus" />
                {tr("Add task node")}
              </Button>
            </>
          )}
        </div>
        <Footer
          busy={busy}
          error={tr(error)}
          onClose={onClose}
          label={tr("Save configuration")}
        />
      </form>
    </Dialog>
  );
}
