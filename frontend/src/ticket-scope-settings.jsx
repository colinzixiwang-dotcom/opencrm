import React, { useEffect, useState } from "react";
import { api, useWorkspace, formatDate } from "./context";
import { tr } from "./i18n";
import { Panel, PanelHeading, Button, Icon, LoadingState } from "./components";

const endpoint = "/api/integrations/udesk/ticket-scope";
const defaults = {
  "4918": "morpho--Email组", "4974": "运营组", "5041": "Email-售前组-Morpho",
  "5042": "Email-售后组-Morpho", "5043": "技术组", "5044": "客诉升级组",
};
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
  groups.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const count = (id) => preview?.groupCounts.find((g) => g.groupId === id)?.count || 0;
  return <Panel className="ticket-scope-settings">
    <PanelHeading title="Ticket after-sales group membership">
      <Button disabled={busy || !data} onClick={syncGroups}><Icon name="refresh" />{tr("Update group directory")}</Button>
    </PanelHeading>
    <p className="scope-intro">{tr("Choose the Udesk handling groups whose tickets belong to Morpho. All active CRM users share this scope and can create RMAs from these tickets.")}</p>
    {error && <div className="scope-error" role="alert">{tr(error)} <button className="text-button" disabled={busy} onClick={() => {setError("");setReload((v) => v + 1);}}>{tr("Reload configuration")}</button></div>}
    {message && <p className="scope-saved" role="status">{message}</p>}
    {!draft ? !error && <LoadingState label="Loading ticket group membership…" rows={4} /> : <form onSubmit={save}>
      <div className="scope-template-summary">
        <div><span className="scope-eyebrow">{tr("Active template")}</span><strong>{tr("Morpho tickets")}</strong></div>
        <div><span className="scope-eyebrow">{tr("Membership rule")}</span><strong>{tr("Udesk handling group")}</strong></div>
        <div><span className="scope-eyebrow">{tr("Selected groups")}</span><strong>{draft.groupIds.length}</strong></div>
      </div>
      <fieldset disabled={busy} className="scope-group-fieldset">
        <legend>{tr("Included after-sales groups")}</legend>
        <p className="muted">{tr("New Udesk groups are excluded until an administrator selects them. Group names are for display; membership uses group IDs.")}</p>
        <div className="scope-group-list">
          {groups.map((g) => {
            const id = String(g.id), checked = draft.groupIds.includes(id);
            return <label className={"scope-group" + (checked ? " is-selected" : "")} key={id}>
              <input type="checkbox" aria-label={String(g.name) + " · " + id} checked={checked} onChange={(e) => {
                setMessage(""); setDraft({ ...draft, groupIds: (e.target.checked ? [...draft.groupIds, id] : draft.groupIds.filter((v) => v !== id)).sort() });
              }} />
              <span className="scope-group-name"><strong>{g.name}</strong><small>ID {id}{g.missing ? " · " + tr("Not in the current directory") : ""}</small></span>
              <span className="scope-group-count">{preview && !preview.initializing ? count(id) + " " + tr("tickets") : "—"}</span>
            </label>;
          })}
          <label className={"scope-group scope-unassigned" + (draft.includeUnassigned ? " is-selected" : "")}>
            <input type="checkbox" checked={draft.includeUnassigned} onChange={(e) => {setMessage("");setDraft({...draft, includeUnassigned:e.target.checked});}} />
            <span className="scope-group-name"><strong>{tr("Include tickets without a handling group")}</strong><small>{tr("Controls unassigned groups, regardless of the assigned agent.")}</small></span>
            <span className="scope-group-count">{preview && !preview.initializing ? count("") + " " + tr("tickets") : "—"}</span>
          </label>
        </div>
      </fieldset>
      <div className="scope-preview" aria-live="polite">
        <div><span className="scope-eyebrow">{tr("Preview of synced tickets")}</span><strong>{previewError ? "—" : !preview ? tr("Calculating…") : preview.initializing ? tr("Ticket data is initializing") : preview.totalCount + " " + tr("tickets")}</strong></div>
        <p>{previewError ? tr("Unable to calculate the preview. Please reload the configuration.") : preview?.initializing ? tr("Counts will be available after the first successful synchronization.") : tr("Preview uses the latest local index. Saving applies the selection immediately; source group changes follow background synchronization.")}</p>
      </div>
      <div className="scope-config-footer">
        <small>{tr("Revision")} {data.policy.revision} · {tr("Updated")} {formatDate(data.policy.updatedAt)}<br />{tr("Group directory updated")}: {data.groupsFetchedAt ? formatDate(data.groupsFetchedAt) : tr("Not yet synchronized")}</small>
        <div className="row-actions"><Button disabled={busy || !dirty} onClick={() => {setDraft(data.policy);setMessage("");}}>{tr("Discard changes")}</Button><Button kind="primary" type="submit" disabled={busy || !dirty}>{tr(busy ? "Saving…" : "Save membership")}</Button></div>
      </div>
      {data.history?.length > 0 && <details className="scope-history"><summary>{tr("Configuration history")}</summary><ul>{data.history.map((entry) => <li key={entry.revision}><strong>{tr("Revision")} {entry.revision}</strong><span>{entry.actorName || entry.actorId}</span><time>{formatDate(entry.changedAt)}</time></li>)}</ul></details>}
    </form>}
  </Panel>;
}
