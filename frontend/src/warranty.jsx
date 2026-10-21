import { tr } from "./i18n";
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
        {tr(assessment.ruleSnapshot?.name || tr("No warranty required"))}
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
            {p?.productType !== "device" && (
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
            {payload.draftId && (
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
            <label>
              {tr("Delivery date")}
              <input
                aria-label={tr("Delivery date")}
                type="date"
                required
                value={value.deliveredAt || ""}
                onChange={(e) => set("deliveredAt", e.target.value)}
              />
            </label>
            <label>
              {tr("Activation date")}
              <input
                aria-label={tr("Activation date")}
                type="date"
                value={value.activatedAt || ""}
                onChange={(e) => set("activatedAt", e.target.value)}
              />
            </label>
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
export function WarrantySettings() {
  const { state: s, act, can, busy } = useWorkspace();
  const [policy, setPolicy] = useState(() =>
      JSON.parse(JSON.stringify(s.supportConfig.warrantyPolicy)),
    ),
    [revision] = useState(s.supportConfig.warrantyPolicy.revision),
    [error, setError] = useState("");
  const editable =
    can("warranty.save") && s.currentUser.roles.includes("admin");
  const update = (i, k, v) =>
    setPolicy({
      ...policy,
      rules: policy.rules.map((r, j) => (j === i ? { ...r, [k]: v } : r)),
    });
  return (
    <Panel className="warranty-settings">
      <h2>{tr("Warranty rules")}</h2>
      <p>
        {tr(
          "New devices start at activation or delivery + grace days, whichever is earlier. Bundled printheads use the device start; separately purchased printheads start the day after delivery. Replacement devices retain the original dates.",
        )}
      </p>
      <p>
        {tr(
          "Coverage includes the start date and excludes the end date. Calendar-month ends are clamped. More specific SKU, market and platform rules take precedence; equal matches block creation.",
        )}
      </p>
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
          {policy.rules.map((r, i) => (
            <section className="workflow-node" key={i}>
              <div className="form-grid">
                <label>
                  {tr("Rule key")}
                  <input
                    aria-label={tr("Rule key")}
                    required
                    pattern="[a-zA-Z0-9_-]+"
                    value={r.id}
                    onChange={(e) => update(i, "id", e.target.value)}
                  />
                </label>
                <label>
                  {tr("Rule name")}
                  <input
                    aria-label={tr("Rule name")}
                    required
                    maxLength="120"
                    value={r.name}
                    onChange={(e) => update(i, "name", e.target.value)}
                  />
                </label>
                <label>
                  {tr("Coverage class")}
                  <select
                    aria-label={tr("Coverage class")}
                    value={r.coverage}
                    onChange={(e) => update(i, "coverage", e.target.value)}
                  >
                    <option value="device">{tr("New device")}</option>
                    <option value="printhead_1080">
                      {tr("Printhead 1080")}
                    </option>
                    <option value="printhead_3200">
                      {tr("Printhead 3200")}
                    </option>
                  </select>
                </label>
                <label>
                  {tr("Warranty months")}
                  <input
                    aria-label={tr("Warranty months")}
                    type="number"
                    min="1"
                    max="120"
                    required
                    value={r.months}
                    onChange={(e) =>
                      update(i, "months", Number(e.target.value))
                    }
                  />
                </label>
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
                <label className="full-field">
                  {tr("Applicable SKUs (empty = all)")}
                  <select
                    aria-label={tr("Applicable SKUs (empty = all)")}
                    multiple
                    size="4"
                    value={r.productIds}
                    onChange={(e) =>
                      update(
                        i,
                        "productIds",
                        Array.from(e.target.selectedOptions, (x) => x.value),
                      )
                    }
                  >
                    {s.products.map((p) => (
                      <option value={p.id} key={p.id}>
                        {p.sku} · {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={r.enabled}
                    onChange={(e) => update(i, "enabled", e.target.checked)}
                  />
                  {tr("Enabled")}
                </label>
              </div>
              <Button
                onClick={() =>
                  setPolicy({
                    ...policy,
                    rules: policy.rules.filter((_, j) => j !== i),
                  })
                }
              >
                {tr("Remove rule")}
              </Button>
            </section>
          ))}
          <Button
            onClick={() =>
              setPolicy({
                ...policy,
                rules: [
                  ...policy.rules,
                  {
                    id: "rule_" + crypto.randomUUID(),
                    name: "",
                    coverage: "device",
                    months: 12,
                    enabled: true,
                    productIds: [],
                    market: "",
                    platform: "",
                  },
                ],
              })
            }
          >
            {tr("Add warranty rule")}
          </Button>
        </fieldset>
        {error && (
          <p className="form-error" role="alert">
            {tr(error)}
          </p>
        )}
        {editable && (
          <button className="btn primary" type="submit" disabled={busy}>
            {tr("Save warranty rules")}
          </button>
        )}
      </form>
      <Note>
        {tr(
          "Rules apply to new RMAs. Historical assessments retain their policy snapshot. Warranty corrections requiring approval and repair pause adjustments are not available here.",
        )}
      </Note>
    </Panel>
  );
}
