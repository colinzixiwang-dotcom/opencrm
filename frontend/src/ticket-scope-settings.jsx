import React, { useEffect, useState } from "react";
import { api, useWorkspace } from "./context";
import { tr, intlLocale } from "./i18n";
import { Panel, PanelHeading, Button, Icon, LoadingState } from "./components";

const endpoint = "/api/integrations/udesk/ticket-scope";
const defaults = {
  "4918": "morpho--Email组", "4974": "运营组", "5041": "Email-售前组-Morpho",
  "5042": "Email-售后组-Morpho", "5043": "技术组", "5044": "客诉升级组",
};
const timestamp = (value) => value ? new Intl.DateTimeFormat(intlLocale(), {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
}).format(new Date(value)) : "—";
function changes(entry, groupName) {
  if (!entry.after) return [tr("Change details unavailable")];
  const after = entry.after, before = entry.before;
  if (!before && entry.revision !== 1) return [tr("Previous configuration unavailable")];
  const result = [];
  const added = after.groupIds.filter((id) => !before?.groupIds.includes(id));
  const removed = (before?.groupIds || []).filter((id) => !after.groupIds.includes(id));
  if (!before) result.push(tr("Initial configuration"));
  if (added.length) result.push(tr("Groups included") + ": " + added.map(groupName).join("、"));
  if (removed.length) result.push(tr("Groups excluded") + ": " + removed.map(groupName).join("、"));
  if (!before || before.includeUnassigned !== after.includeUnassigned)
    result.push(tr("Tickets without a group") + ": " + tr(after.includeUnassigned ? "Included" : "Excluded"));
  return result.length ? result : [tr("Saved without membership changes")];
}
export function TicketScopeSettings() {
  const { state } = useWorkspace();
  const [data, setData] = useState(null), [draft, setDraft] = useState(null);
  const [preview, setPreview] = useState(null), [previewError, setPreviewError] = useState("");
  const [error, setError] = useState(""), [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false), [reload, setReload] = useState(0);
  const isAdmin = state.currentUser.roles.includes("admin");
  const accept = (value) => { setData(value); setDraft(value.policy); };
  useEffect(() => {
    if (!isAdmin) return;
    const controller = new window.AbortController();
    api(endpoint, { signal: controller.signal }).then(accept).catch((e) => {
      if (e.name !== "AbortError") setError(e.message);
    });
    return () => controller.abort();
  }, [isAdmin, reload]);
  const signature = draft ? JSON.stringify({ groupIds: draft.groupIds, includeUnassigned: draft.includeUnassigned }) : "";
  useEffect(() => {
    if (!signature) return;
    const controller = new window.AbortController();
    setPreview(null); setPreviewError("");
    api(endpoint + "/preview", { method: "POST", body: signature, signal: controller.signal })
      .then(setPreview).catch((e) => { if (e.name !== "AbortError") setPreviewError(e.message); });
    return () => controller.abort();
  }, [signature, reload]);
  if (!isAdmin) return <p>{tr("Only administrators can configure ticket group membership.")}</p>;
  const dirty = draft && data && JSON.stringify([draft.groupIds, draft.includeUnassigned]) !== JSON.stringify([data.policy.groupIds, data.policy.includeUnassigned]);
  const syncGroups = async () => {
    setBusy(true); setError(""); setMessage("");
    try {
      const value = await api(endpoint + "/groups/sync", { method: "POST", body: "{}" });
      // Refreshing the directory must not overwrite unsaved membership changes.
      setData(value); setMessage(tr("Udesk group directory updated. Membership selections have not changed."));
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const save = async (e) => {
    e.preventDefault(); setBusy(true); setError(""); setMessage("");
    try {
      const value = await api(endpoint, { method: "POST", body: JSON.stringify(draft) });
      accept(value); setMessage(tr("Ticket group membership saved. The new scope is now active."));
      window.dispatchEvent(new window.Event("udesk:refresh"));
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };
  const groups = [...(data?.groups || [])];
  for (const id of draft?.groupIds || []) if (!groups.some((g) => String(g.id) === id)) groups.push({ id, name: defaults[id] || tr("Unavailable group"), missing: true });
  for (const item of preview?.groupCounts || []) {
    if (item.groupId && !groups.some((g) => String(g.id) === item.groupId)) groups.push({ id: item.groupId, name: tr("Unavailable group"), missing: true });
  }
  groups.sort((a, b) => Number(!!a.missing) - Number(!!b.missing) || String(a.id).localeCompare(String(b.id)));
  const count = (id) => preview?.groupCounts.find((g) => g.groupId === id)?.count || 0;
  return <Panel className="ticket-scope-settings">
    <PanelHeading title="Ticket after-sales group membership">
      <Button disabled={busy || !data} onClick={syncGroups}><Icon name="refresh" />{tr("Update group directory")}</Button>
    </PanelHeading>
    <p className="scope-intro">{tr("Tickets in the selected groups appear in Morpho for all CRM users and can be used to create RMAs.")}</p>
    {error && <div className="scope-error" role="alert">{tr(error)} <button className="text-button" disabled={busy} onClick={() => {setError("");setReload((v) => v + 1);}}>{tr("Reload configuration")}</button></div>}
    {message && <p className="scope-saved" role="status">{message}</p>}
    {!draft ? !error && <LoadingState label="Loading ticket group membership…" rows={4} /> : <form onSubmit={save}>
      <fieldset disabled={busy} className="scope-group-fieldset">
        <legend>{tr("Included after-sales groups")} <span className="scope-selection-count">{draft.groupIds.length} {tr("selected")}</span></legend>
        <p className="muted">{tr("New groups are excluded by default. Select them here to include their tickets.")}</p>
        <div className="scope-group-list">
          {groups.map((g) => {
            const id = String(g.id), checked = draft.groupIds.includes(id);
            return <label className={"scope-group" + (checked ? " is-selected" : "")} key={id}>
              <input type="checkbox" aria-label={String(g.name) + " · " + id} disabled={g.missing && !data.policy.groupIds.includes(id)} checked={checked} onChange={(e) => {
                setMessage(""); setDraft({ ...draft, groupIds: (e.target.checked ? [...draft.groupIds, id] : draft.groupIds.filter((v) => v !== id)).sort() });
              }} />
              <span className="scope-group-name"><strong>{g.name}</strong><small>ID {id}{g.missing ? " · " + tr("Not in the current directory") : ""}</small></span>
              <span className="scope-group-count">{preview && !preview.initializing ? count(id) + " " + tr("tickets") : "—"}</span>
            </label>;
          })}
          <label className={"scope-group scope-unassigned" + (draft.includeUnassigned ? " is-selected" : "")}>
            <input type="checkbox" aria-label={tr("Also show tickets with no Udesk group")} checked={draft.includeUnassigned} onChange={(e) => {setMessage("");setDraft({...draft, includeUnassigned:e.target.checked});}} />
            <span className="scope-group-name"><strong>{tr("Also show tickets with no Udesk group")}</strong><small>{tr("Off by default: their product is unknown. This is unrelated to whether an agent is assigned.")}</small></span>
            <span className="scope-group-count">{preview && !preview.initializing ? count("") + " " + tr("tickets") : "—"}</span>
          </label>
        </div>
      </fieldset>
      <div className="scope-preview" aria-live="polite">
        <div><span className="scope-eyebrow">{tr("Preview of synced tickets")}</span><strong>{previewError ? "—" : !preview ? tr("Calculating…") : preview.initializing ? tr("Ticket data is initializing") : preview.totalCount + " " + tr("tickets")}</strong></div>
        <p>{previewError ? tr("Unable to calculate the preview. Please reload the configuration.") : preview?.initializing ? tr("Counts will be available after the first successful synchronization.") : tr("Based on synced tickets. Changes take effect after saving.")}</p>
      </div>
      <div className="scope-config-footer">
        <small>{tr("Revision")} {data.policy.revision} · {tr("Updated")} {timestamp(data.policy.updatedAt)}<br />{tr("Group directory updated")}: {data.groupsFetchedAt ? timestamp(data.groupsFetchedAt) : tr("Not yet synchronized")}</small>
        <div className="row-actions"><Button disabled={busy || !dirty} onClick={() => {setDraft(data.policy);setMessage("");}}>{tr("Discard changes")}</Button><Button kind="primary" type="submit" disabled={busy || !dirty}>{tr(busy ? "Saving…" : "Save membership")}</Button></div>
      </div>
      {data.history?.length > 0 && <details className="scope-history"><summary>{tr("Configuration history")} <span className="scope-history-zone">{tr("Latest 20 changes · Beijing time (UTC+8)")}</span></summary><ul>{data.history.map((entry) => <li key={entry.revision}>
        <div className="scope-history-meta"><strong>{entry.actorName === "System" ? tr("System") : entry.actorName || entry.actorId}</strong><span>{tr("Revision")} {entry.revision}</span><time dateTime={entry.changedAt}>{timestamp(entry.changedAt)}</time></div>
        <ul className="scope-change-list">{changes(entry, (id) => (groups.find((g) => String(g.id) === id && !g.missing)?.name || defaults[id] || tr("Unavailable group")) + " (" + id + ")").map((change, index) => <li key={index}>{change}</li>)}</ul>
      </li>)}</ul></details>}
    </form>}
  </Panel>;
}
