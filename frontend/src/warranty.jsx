import { tr } from "./i18n";
import { newId } from "./ids";
import React, { useState, useEffect } from "react";
import { api, useWorkspace, formatDate } from "./context";
import { Panel, Button, Note, Badge } from "./components";

export function warrantyRequired(solution) {
  if (typeof solution?.requiresWarranty === "boolean")
    return solution.requiresWarranty;
  const types = solution?.nodes?.map((n) => n.typeId) || [];
  return (
    types.some((t) => ["send_device", "send_parts"].includes(t)) ||
    (types.includes("refund") && types.includes("return_device"))
  );
}
export function AssessmentSummary({ assessment }) {
  if (!assessment) return null;
  return (
    <div className="warranty-assessment" role="status">
      <strong>{tr("Eligibility assessment")}</strong>{" "}
      <Badge value={assessment.status} />
      <p>{tr(assessment.reason)}</p>
      {assessment.startsAt && (
        <p>
          {tr("Coverage: ")}
          {formatDate(assessment.startsAt)} → {formatDate(assessment.endsAt)}
          {tr(" (end date excluded)")}
        </p>
      )}
      <small>
        {tr("Policy revision ")}
        {assessment.policyRevision} ·{" "}
        {tr(
          assessment.ruleSnapshot?.name ||
            (assessment.status === "not_required" &&
            assessment.requiresWarranty === false
              ? "No warranty required"
              : "Warranty rule not determined"),
        )}
      </small>
    </div>
  );
}
export function WarrantyEvidence({ value, onChange, payload, onAssessment }) {
  const [assessment, setAssessment] = useState(null),
    [error, setError] = useState(""),
    [checking, setChecking] = useState(false);
  const { state: s } = useWorkspace();
  const signature = JSON.stringify(payload);
  useEffect(() => {
    let active = true;
    setAssessment(null);
    onAssessment(null);
    setError("");
    if (!payload.productId || !payload.solutionId || !payload.platform) return;
    setChecking(true);
    const timer = setTimeout(() => {
      api("/api/rma-assessment", { method: "POST", body: signature })
        .then((r) => {
          if (active) {
            setAssessment(r);
            onAssessment(r);
          }
        })
        .catch((e) => {
          if (active) setError(e.message);
        })
        .finally(() => {
          if (active) setChecking(false);
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
    // The serialized assessment inputs are the request identity; callback identity is intentionally excluded.
  }, [signature]);
  const set = (k, v) => onChange({ ...value, [k]: v });
  const p = s.products.find((p) => p.id === payload.productId);
  const rule = assessment?.ruleSnapshot;
  const mode = rule?.startMode || "purchase_type";
  const exempt = rule?.eligibilityMode === "exempt";
  const legacyPrinthead = mode === "purchase_type" && ["printhead_1080", "printhead_3200"].includes(p?.warrantyClass);
  const needsDelivery = !exempt && !["payment", "activation"].includes(mode);
  const needsActivation = !exempt && ["activation", "activation_grace", "purchase_type"].includes(mode);
  const needsReference = rule?.requireEvidence ?? (!!payload.draftId || payload.solutionId === "reship_device");
  return (
    <section className="warranty-evidence">
      <h3>{tr("Warranty and solution eligibility")}</h3>
      {warrantyRequired(
        s.supportConfig.solutions.find((x) => x.id === payload.solutionId),
      ) && (
        <>
          <Note>
            {tr(
              "Delivery and activation facts are entered by the agent. For replacements, enter the original device dates and serial reference. MES and Shopify verification are not connected.",
            )}
          </Note>
          <div className="form-grid">
            {legacyPrinthead && (
              <label>
                {tr("Printhead purchase type")}
                <select
                  aria-label={tr("Printhead purchase type")}
                  value={value.purchaseType || ""}
                  onChange={(e) => set("purchaseType", e.target.value)}
                  required
                >
                  <option value="">{tr("Choose purchase type…")}</option>
                  <option value="bundled_printhead">
                    {tr("Bundled with device")}
                  </option>
                  <option value="standalone_printhead">
                    {tr("Purchased separately")}
                  </option>
                </select>
              </label>
            )}
            {needsReference && (
              <label>
                {tr("Delivery evidence reference")}
                <input
                  required
                  maxLength="1000"
                  value={value.evidenceReference || ""}
                  onChange={(e) => set("evidenceReference", e.target.value)}
                />
              </label>
            )}
            {needsDelivery && <label>
              {tr("Delivery date")}
              <input
                aria-label={tr("Delivery date")}
                type="date"
                required
                value={value.deliveredAt || ""}
                onChange={(e) => set("deliveredAt", e.target.value)}
              />
            </label>}
            {!exempt && mode === "payment" && <label>{tr("Payment date")}<input aria-label={tr("Payment date")} type="date" required value={value.paidAt || ""} onChange={e => set("paidAt",e.target.value)} /></label>}
            {needsActivation && <label>
              {tr("Activation date")}
              <input
                aria-label={tr("Activation date")}
                type="date"
                required={mode === "activation"}
                value={value.activatedAt || ""}
                onChange={(e) => set("activatedAt", e.target.value)}
              />
            </label>}
            <label>
              {tr("Market")}
              <input
                aria-label={tr("Market")}
                maxLength="64"
                value={value.market || ""}
                onChange={(e) => set("market", e.target.value)}
              />
            </label>
            <label>
              {tr("Original device SN (replacement lineage)")}
              <input
                aria-label={tr("Original device SN (replacement lineage)")}
                maxLength="120"
                value={value.inheritedFromSn || ""}
                onChange={(e) => set("inheritedFromSn", e.target.value)}
              />
            </label>
          </div>
        </>
      )}
      {checking && <p>{tr("Checking eligibility…")}</p>}
      {error && (
        <p className="form-error" role="alert">
          {tr(error)}
        </p>
      )}
      <AssessmentSummary assessment={assessment} />
    </section>
  );
}
function WarrantySkuScope({ products, value, onChange }) {
  const [query, setQuery] = useState("");
  const rows = products.filter(p => `${p.sku} ${p.name}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="warranty-sku-picker full-field">
    <div className="warranty-sku-heading"><strong>{tr("Applicable SKUs (empty = all)")}</strong><span>{value.length ? `${value.length} SKU` : tr("All SKUs in this type")}</span></div>
    <input aria-label={tr("Search applicable SKUs")} placeholder={tr("Search by SKU or product name")} value={query} onChange={e=>setQuery(e.target.value)} />
    <div className="warranty-sku-options">{rows.map(p=><label key={p.id}><input type="checkbox" checked={value.includes(p.id)} onChange={e=>onChange(e.target.checked ? [...value,p.id] : value.filter(id=>id!==p.id))} /><span><strong>{p.sku}</strong><small>{p.name}</small></span></label>)}{rows.length === 0 && <p>{tr("No matching SKUs")}</p>}</div>
  </div>;
}
export function WarrantySettings() {
  const { state: s, act, can, busy } = useWorkspace();
  const [policy, setPolicy] = useState(() =>
      JSON.parse(JSON.stringify(s.supportConfig.warrantyPolicy)),
    ),
    [revision] = useState(s.supportConfig.warrantyPolicy.revision),
    [error, setError] = useState(""),
    [editing, setEditing] = useState(null);
  const editable =
    can("warranty.save") && s.currentUser.roles.includes("admin");
  const update = (i, k, v) =>
    setPolicy({
      ...policy,
      rules: policy.rules.map((r, j) => (j === i ? { ...r, [k]: v } : r)),
    });
  const startLabels = {
    activation_grace: "Activation or delivery plus grace", delivery: "Delivery date",
    delivery_next_day: "Day after delivery", payment: "Payment date",
    activation: "Activation date", purchase_type: "Legacy purchase-type calculation",
  };
  const dirty = JSON.stringify(policy) !== JSON.stringify(s.supportConfig.warrantyPolicy);
  const blankRule = coverage => ({
    id: "rule_" + newId(), name: "New warranty rule", coverage,
    months: 0, durationUnit: "months", startMode: "delivery", eligibilityMode: "timed",
    requireEvidence: true, enabled: false, productIds: [], market: "", platform: "",
  });
  const addType = () => {
    const cls = {id: "type_" + newId(), name: "New warranty type"};
    setPolicy({...policy, classes: [...policy.classes, cls], rules: [...policy.rules, blankRule(cls.id)]});
    setEditing(cls.id);
  };
  const selectedType = policy.classes?.find(c=>c.id===editing);
  const typeRules = policy.rules.map((r,i)=>({...r,index:i})).filter(r=>r.coverage===editing);
  return (
    <Panel className="warranty-settings">
      <header className="warranty-heading">
        <div><h2>{tr("Warranty rules")}</h2><p>{tr("Manage coverage by product type. Open a rule to edit its terms.")}</p></div>
        <span className="warranty-revision">{tr("Policy revision ")}{revision}</span>
      </header>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          try {
            await act(
              "warranty.save",
              { policy, expectedRevision: revision },
              "Warranty rules saved.",
            );
          } catch (e) {
            setError(e.message);
          }
        }}
      >
        <fieldset disabled={!editable || busy}>
          <div className="warranty-list-toolbar">
            <span>{policy.rules.length} {tr("Warranty rules")} · {policy.classes?.length || 0} {tr("Warranty types")}</span>
            {editable && <Button onClick={addType}>{tr("Add warranty type")}</Button>}
          </div>
          <div className="warranty-overview" role="table" aria-label={tr("Warranty rules")}>
            <div className="warranty-overview-head" role="row">{["Warranty class", "Coverage term", "Warranty start basis", "Scope", "Status", "Edit"].map(label=><span role="columnheader" key={label}>{tr(label)}</span>)}</div>
            {policy.classes.map(cls => {
              const rules = policy.rules.filter(r=>r.coverage===cls.id);
              return <div className={`warranty-overview-row ${editing === cls.id ? "is-editing" : ""}`} role="row" key={cls.id}>
                <div role="cell"><strong>{tr(cls.name)}</strong>{rules.length > 1 && <small>{rules.length} {tr("Applicable rules")}</small>}</div>
                <div role="cell" data-label={tr("Coverage term")}>{rules.map(r=><div className="warranty-term-line" key={r.id}>{r.eligibilityMode === "exempt" ? tr("Exempt") : (r.durationUnit === "days" ? r.days : r.months) > 0 ? <><b>{r.durationUnit === "days" ? r.days : r.months}</b> {tr(r.durationUnit === "days" ? "Calendar days" : "Calendar months")}</> : tr("Pending confirmation")}</div>)}{!rules.length && tr("Pending confirmation")}</div>
                <div role="cell" data-label={tr("Warranty start basis")} className="warranty-start-summary">{rules.map(r=><div className="warranty-term-line" key={r.id}>{!r.enabled || r.eligibilityMode === "exempt" ? "—" : tr(startLabels[r.startMode || "purchase_type"])}{r.enabled && r.eligibilityMode !== "exempt" && ["activation_grace","purchase_type"].includes(r.startMode || "purchase_type") && <small>{tr("Activation grace days")}: {r.graceDays ?? policy.graceDays}</small>}</div>)}</div>
                <div role="cell" data-label={tr("Scope")}>{rules.map(r=><div className="warranty-term-line" key={r.id}>{r.productIds?.length ? `${r.productIds.length} SKU` : tr("All SKUs in this type")}<small>{[r.market,r.platform].filter(Boolean).join(" · ") || tr("All markets and platforms")}</small></div>)}</div>
                <div role="cell"><span className={`warranty-state ${rules.some(r=>r.enabled) ? "is-enabled" : "is-pending"}`}><i />{tr(rules.some(r=>r.enabled) ? "Enabled" : "Pending confirmation")}</span></div>
                <div role="cell"><Button onClick={()=>setEditing(editing===cls.id?null:cls.id)}>{tr(editing===cls.id ? "Close" : "Edit")}</Button></div>
              </div>;
            })}
          </div>
          {selectedType && <section className="warranty-type-detail">
            <header className="warranty-type-heading"><div><small>{tr("Edit warranty type")}</small><h3>{tr(selectedType.name)}</h3></div><Button onClick={()=>setEditing(null)}>{tr("Close")}</Button></header>
            <div className="warranty-type-identity">
              <label>{tr("Warranty type name")}<input aria-label={tr("Warranty type name")} required maxLength="120" value={selectedType.name} onChange={e=>setPolicy({...policy,classes:policy.classes.map(c=>c.id===editing?{...c,name:e.target.value}:c)})} /></label>
              <small>{tr("Warranty type key")}: <code>{selectedType.id}</code></small>
            </div>
          {typeRules.map(({index:i,...r}) => (
            <section className="warranty-rule-editor" key={i} aria-label={tr("Edit warranty rule")}>
              <header><h3>{tr("Applicable rule")} {typeRules.length > 1 ? typeRules.findIndex(rule=>rule.index===i)+1 : ""}</h3></header>
              <div className="form-grid">
                <label>{tr("Rule name")}<input aria-label={tr("Rule name")} required maxLength="120" value={r.name} onChange={e=>update(i,"name",e.target.value)} /></label>
                <label>{tr("Coverage requirement")}<select aria-label={tr("Coverage requirement")} value={r.eligibilityMode || "timed"} onChange={e=>update(i,"eligibilityMode",e.target.value)}>
                  <option value="timed">{tr("Time-limited warranty")}</option><option value="exempt">{tr("Explicitly no warranty requirement")}</option>
                </select></label>
                {r.eligibilityMode !== "exempt" && <>
                <label>{tr("Duration unit")}<select aria-label={tr("Duration unit")} value={r.durationUnit || "months"} onChange={e=>update(i,"durationUnit",e.target.value)}><option value="months">{tr("Calendar months")}</option><option value="days">{tr("Calendar days")}</option></select></label>
                <label>{tr(r.durationUnit === "days" ? "Warranty days" : "Warranty months")}<input aria-label={tr(r.durationUnit === "days" ? "Warranty days" : "Warranty months")} type="number" min="1" max={r.durationUnit === "days" ? 36500 : 120} required={r.enabled} value={(r.durationUnit === "days" ? r.days : r.months) || ""} onChange={e=>update(i,r.durationUnit === "days" ? "days" : "months",e.target.value === "" ? 0 : Number(e.target.value))} /></label>
                <label>{tr("Warranty start basis")}<select aria-label={tr("Warranty start basis")} value={r.startMode || "purchase_type"} onChange={e=>update(i,"startMode",e.target.value)}>
                  {[["activation_grace","Activation or delivery plus grace"],["delivery","Delivery date"],["delivery_next_day","Day after delivery"],["payment","Payment date"],["activation","Activation date"],["purchase_type","Legacy purchase-type calculation"]].filter(([v])=>v!=="purchase_type" || ["device","printhead_1080","printhead_3200"].includes(r.coverage)).map(([v,label])=><option value={v} key={v}>{tr(label)}</option>)}
                </select></label>
                {["activation_grace","purchase_type"].includes(r.startMode || "purchase_type") && <label>{tr("Rule activation grace days")}<input aria-label={tr("Rule activation grace days")} type="number" min="0" max="90" value={r.graceDays ?? policy.graceDays} onChange={e=>update(i,"graceDays",Number(e.target.value))} /></label>}
                <label>{tr("Start offset days")}<input aria-label={tr("Start offset days")} type="number" min="0" max="365" value={r.startOffsetDays || 0} onChange={e=>update(i,"startOffsetDays",Number(e.target.value))} /></label>
                </>}
                <label className="full-field">{tr("Policy source and notes")}<textarea aria-label={tr("Policy source and notes")} rows="2" maxLength="2000" value={r.sourceReference || ""} onChange={e=>update(i,"sourceReference",e.target.value)} /></label>
                <label className="warranty-check"><input type="checkbox" checked={r.requireEvidence ?? true} onChange={e=>update(i,"requireEvidence",e.target.checked)} />{tr("Require warranty evidence reference")}</label>
                <label>
                  {tr("Market (blank = all)")}
                  <input
                    aria-label={tr("Market (blank = all)")}
                    maxLength="64"
                    value={r.market}
                    onChange={(e) => update(i, "market", e.target.value)}
                  />
                </label>
                <label>
                  {tr("Platform")}
                  <select
                    aria-label={tr("Platform")}
                    value={r.platform}
                    onChange={(e) => update(i, "platform", e.target.value)}
                  >
                    <option value="">{tr("All platforms")}</option>
                    {s.supportConfig.platforms.map((p) => (
                      <option value={p.id} key={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <WarrantySkuScope products={s.products.filter(p=>p.warrantyClass===r.coverage || (r.coverage === "device" && p.source !== "mabang" && p.productType === "device" && (!p.warrantyClass || p.warrantyClass === "none")))} value={r.productIds || []} onChange={ids=>update(i,"productIds",ids)} />
                <label className="warranty-check">
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    onChange={(e) => update(i, "enabled", e.target.checked)}
                  />
                  {tr("Enabled")}
                </label>
              </div>
              <Button
                onClick={() => {
                  setPolicy({...policy, rules: policy.rules.filter((_, j) => j !== i)});
                }}
              >
                {tr("Remove rule")}
              </Button>
            </section>
          ))}
            <div className="warranty-type-actions"><Button onClick={()=>setPolicy({...policy,rules:[...policy.rules,blankRule(editing)]})}>{tr("Add applicable rule")}</Button>
            <Button disabled={s.products.some(p=>p.warrantyClass===editing)} onClick={()=>{setPolicy({...policy,classes:policy.classes.filter(c=>c.id!==editing),rules:policy.rules.filter(r=>r.coverage!==editing)});setEditing(null);}}>{tr("Remove warranty type")}</Button></div>
            {s.products.some(p=>p.warrantyClass===editing) && <p className="warranty-type-hint">{tr("This type is assigned to products and cannot be removed.")}</p>}
          </section>}
          <details className="warranty-advanced">
            <summary>{tr("Default settings")}</summary>
          <label>
            {tr("Activation grace days")}
            <input
              aria-label={tr("Activation grace days")}
              type="number"
              min="0"
              max="90"
              required
              value={policy.graceDays}
              onChange={(e) =>
                setPolicy({ ...policy, graceDays: Number(e.target.value) })
              }
            />
          </label>
          </details>
        </fieldset>
        {error && (
          <p className="form-error" role="alert">
            {tr(error)}
          </p>
        )}
        {editable && (
          <footer className="warranty-savebar"><span>{tr(dirty ? "Unsaved changes" : "All changes saved")}</span><button className="btn primary" type="submit" disabled={busy || !dirty}>
            {tr("Save warranty rules")}
          </button></footer>
        )}
      </form>
      <details className="warranty-help"><summary>{tr("Calculation and policy notes")}</summary><p>{tr("Coverage includes the start date and excludes the end date. Calendar-month ends are clamped. More specific SKU, market and platform rules take precedence; equal matches block creation.")}</p><p>{tr("Rules apply to new RMAs. Historical assessments retain their policy snapshot. Warranty corrections requiring approval and repair pause adjustments are not available here.")}</p></details>
    </Panel>
  );
}
