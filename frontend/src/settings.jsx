import React, { useState } from "react";
import { useWorkspace, formatDate } from "./context";
import {
  Heading,
  Panel,
  Table,
  Tabs,
  Badge,
  NewButton,
  Note,
  Button,
  Icon,
  Export,
} from "./components";
import { WarrantySettings } from "./warranty";
const col = (label, render, key) => ({ label, render, key });
export function Settings() {
  const { state: s, can, setModal, act } = useWorkspace(),
    [tab, setTab] = useState("company"),
    [error, setError] = useState("");
  const tabs = [
    ["company", "Company"],
 ["warranty", "Warranty rules"],
    ["users", "Users & roles", s.users.length],
    ...(can("role.save")
      ? [["roles", "Role permissions", s.roles.length]]
      : []),
    ...(can("menu.save") ? [["menus", "Menus & buttons"]] : []),
    ["audit", "Audit trail"],
    ["integrations", "Integrations"],
  ];
  return (
    <>
      <Heading>
        {tab === "users" && (
          <NewButton label="Add user" type="user" permission="user.create" />
        )}
        {tab === "roles" && (
          <NewButton label="Add role" type="role" permission="role.save" />
        )}
        {tab === "audit" && <Export collection="audit" />}
      </Heading>
      <Tabs value={tab} onChange={setTab} items={tabs} />
      {tab === "warranty" ? <WarrantySettings key={s.supportConfig.warrantyPolicy.revision} /> : tab === "users" ? (
        <>
          <Panel>
            <Table
              search={false}
              rows={s.users}
              columns={[
                col("User", (u) => (
                  <>
                    <strong>{u.name}</strong>
                    <small className="cell-sub">{u.email}</small>
                  </>
                )),
                col("Roles", (u) => (
                  <div className="row-actions">
                    {u.roles.map((r) => (
                      <Badge key={r} value={r} />
                    ))}
                  </div>
                )),
                col("Access", (u) => (
                  <Badge value={u.active ? "active" : "inactive"} />
                )),
                col("", (u) => (
                  <div className="row-actions">
                    {can("user.update") && (
                      <Button
                        kind="small"
                        onClick={() =>
                          setModal({ type: "user-edit", id: u.id })
                        }
                      >
                        Edit access
                      </Button>
                    )}
                    {can("user.assignRoles") && (
                      <Button
                        kind="small"
                        onClick={() => setModal({ type: "assign", id: u.id })}
                      >
                        Assign roles
                      </Button>
                    )}
                  </div>
                )),
              ]}
            />
          </Panel>
          <Note icon="users">
            RuoYi RBAC: users receive the union of their enabled roles’ menu and
            button grants. Every write and protected read is checked on the
            server.
          </Note>
        </>
      ) : tab === "roles" ? (
        <>
          <Panel>
            <Table
              rows={s.roles}
              columns={[
                col("Role", (r) => (
                  <>
                    <strong>{r.roleName}</strong>
                    <small className="cell-sub">{r.roleKey}</small>
                  </>
                )),
                col("Status", (r) => (
                  <Badge value={r.status === "0" ? "active" : "inactive"} />
                )),
                col("Menu & button grants", (r) =>
                  r.roleKey === "admin" ? "All permissions" : r.menuIds.length,
                ),
                col("Description", (r) => r.remark || "—"),
                col("", (r) =>
                  r.roleKey === "admin" ? (
                    <span className="category">Protected administrator</span>
                  ) : (
                    <Button
                      kind="small"
                      onClick={() => setModal({ type: "role", id: r.roleId })}
                    >
                      Edit permissions
                    </Button>
                  ),
                ),
              ]}
            />
          </Panel>
          <Note>
            Assign individual page and action permissions. Disabling a role
            removes its grants on the next authenticated request.
            Organization/department row-level data scopes are not implemented.
          </Note>
        </>
      ) : tab === "menus" ? (
        <>
          <Panel>
            <Table
              rows={s.permissionMenus.map((x) => ({ ...x, id: x.menuId }))}
              columns={[
                col("Menu / action", (m) => (
                  <strong>
                    {m.menuType === "F" ? "↳ " : ""}
                    {m.menuName}
                  </strong>
                )),
                col("Type", (m) => (
                  <Badge value={m.menuType === "F" ? "button" : "page"} />
                )),
                col("Permission", (m) => <code>{m.perms}</code>),
                col("Route", (m) => m.url || "—"),
                col("Visible", (m) => (m.visible === "0" ? "Shown" : "Hidden")),
                col("Status", (m) => (
                  <Badge value={m.status === "0" ? "active" : "inactive"} />
                )),
                col("", (m) => (
                  <Button
                    kind="small"
                    onClick={() => setModal({ type: "menu", id: m.menuId })}
                  >
                    Edit menu
                  </Button>
                )),
              ]}
            />
          </Panel>
          <Note>
            Permission identifiers and route mappings are fixed by backend code.
            Menu names, ordering, visibility, and enabled state are configurable
            here.
          </Note>
        </>
      ) : tab === "audit" ? (
        <Panel>
          <Table
            rows={s.audit}
            columns={[
              col(
                "Time",
                (r) =>
                  new Intl.DateTimeFormat("en-US", {
                    dateStyle: "medium",
                    timeStyle: "short",
                    timeZone: s.settings.timezone,
                  }).format(new Date(r.at)),
                "at",
              ),
              col("Action", (r) => <strong>{r.action}</strong>),
              col("Reference", (r) => r.reference),
              col("Actor", (r) => r.actor),
            ]}
          />
        </Panel>
      ) : tab === "integrations" ? (
        <div className="integration-grid">
          {[
            ["Amazon", "Marketplace listings, orders, FBA, and advertising"],
            ["Shopify", "Store orders, inventory, and customers"],
            ["1688", "Supplier purchasing and product pairing"],
            ["Carrier services", "Shipping labels and live tracking"],
          ].map(([name, d]) => (
            <Panel className="integration-card" key={name}>
              <span className="integration-logo">{name[0]}</span>
              <h2>{name}</h2>
              <p>{d}</p>
              <Badge value="not_connected" />
              <div className="integration-note">
                No integration adapter is configured. Credentials are not
                requested or stored.
              </div>
            </Panel>
          ))}
        </div>
      ) : (
        <div className="two-columns">
          <Panel className="settings-form">
            <h2>Company preferences</h2>
            <p>Used for display and reporting context.</p>
            <form
              id="settings-form"
              onSubmit={async (e) => {
                e.preventDefault();
                const p = Object.fromEntries(new FormData(e.target));
                try {
                  await act(
                    "settings.update",
                    { ...p, lowStockDays: Number(p.lowStockDays) },
                    "Company preferences saved.",
                  );
                } catch (e) {
                  setError(e.message);
                }
              }}
            >
              <label>
                Company name
                <input
                  name="company"
                  required
                  defaultValue={s.settings.company}
                  disabled={!can("settings.update")}
                />
              </label>
              <label>
                Timezone
                <select
                  name="timezone"
                  defaultValue={s.settings.timezone}
                  disabled={!can("settings.update")}
                >
                  {[
                    "Asia/Shanghai",
                    "America/New_York",
                    "Europe/London",
                    "UTC",
                  ].map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </label>
              <label>
                Stock coverage threshold (days)
                <input
                  name="lowStockDays"
                  type="number"
                  min="1"
                  max="90"
                  defaultValue={s.settings.lowStockDays}
                  disabled={!can("settings.update")}
                />
              </label>
              <p className="help-text">
                Stored for future coverage forecasts. Current suggestions use
                product reorder points.
              </p>
              {error && <p className="form-error">{error}</p>}
              {can("settings.update") ? (
                <button className="btn primary" type="submit">
                  Save preferences
                </button>
              ) : (
                <span className="muted">Read-only access</span>
              )}
            </form>
          </Panel>
          <Panel className="workspace-details">
            <h2>Your local workspace</h2>
            {[
              ["Frontend", "React + Vite"],
              ["Backend", "Go + Gin"],
              ["Permissions", "RuoYi-Go adapted RBAC"],
              ["Storage", "SQLite · persistent"],
              ["Currency", "USD"],
              ["State revision", s.version],
            ].map(([k, v]) => (
              <div className="balance-row" key={k}>
                <span>{k}</span>
                <strong>{v}</strong>
              </div>
            ))}
            <p>Business records and permissions are saved on this computer.</p>
            {can("role.save") && (
              <a className="btn secondary" href="/api/backup" download>
                <Icon name="download" />
                Download business snapshot
              </a>
            )}
            <small>
              Business snapshot excludes authentication data. Back up the SQLite
              database for complete recovery.
            </small>
          </Panel>
        </div>
      )}
    </>
  );
}
