import React, { useState, useRef, useEffect } from "react";
import { useWorkspace, formatDate, money, today, total } from "./context";
import { Icon, Button } from "./components";
const dollar = (c) => ((c || 0) / 100).toFixed(2);
function cents(v) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(String(v)))
    throw Error(
      "Money amounts must be nonnegative with at most two decimal places.",
    );
  const [a, b = ""] = String(v).split(".");
  return Number(a) * 100 + Number(b.padEnd(2, "0"));
}
function Field({
  name,
  label,
  type = "text",
  value = "",
  options,
  required = false,
  min,
  max,
  step,
  full = false,
}) {
  return (
    <label className={full ? "full-field" : ""}>
      {label}
      {options ? (
        <select name={name} defaultValue={value} required={required}>
          {options.map((o) => (
            <option key={o.id ?? o} value={o.id ?? o}>
              {o.label ?? o.name ?? o}
            </option>
          ))}
        </select>
      ) : type === "textarea" ? (
        <textarea
          name={name}
          rows="3"
          maxLength="2000"
          defaultValue={value}
          required={required}
        />
      ) : (
        <input
          name={name}
          type={type}
          defaultValue={value}
          required={required}
          min={min}
          max={max}
          step={step}
          maxLength={type === "password" ? 72 : 160}
          minLength={type === "password" ? 10 : undefined}
          autoComplete={type === "password" ? "new-password" : undefined}
        />
      )}
    </label>
  );
}
function schema(type, r, s) {
  const f = (name, label, value = "", type = "text", extra = {}) => ({
      name,
      label,
      value: value ?? "",
      type,
      ...extra,
    }),
    m = (name, label, value = 0) =>
      f(name, label, dollar(value), "number", {
        min: 0,
        max: 100000,
        step: ".01",
        required: true,
      }),
    sel = (name, label, options, value = "", required = true) =>
      f(name, label, value, "text", { options, required }),
    note = (name, label, value = "") =>
      f(name, label, value, "textarea", { full: true }),
    sup = s.suppliers.map((x) => ({ id: x.id, label: x.name })),
    wh = s.warehouses.map((x) => ({
      id: x.id,
      label: x.name + " · " + x.type,
    })),
    d = today(s.settings.timezone);
  switch (type) {
    case "product":
      return [
        f("sku", "SKU", r?.sku, "text", { required: true }),
        f("name", "Product name", r?.name, "text", { required: true }),
        f("spu", "SPU / variant group", r?.spu),
        f("category", "Category", r?.category || "General", "text", {
          required: true,
        }),
        m("costCents", "Reference purchase cost ($)", r?.costCents),
        m("priceCents", "Selling price ($)", r?.priceCents),
        f("reorderPoint", "Reorder point", r?.reorderPoint ?? 30, "number", {
          min: 0,
          step: 1,
          required: true,
        }),
        f("leadDays", "Lead time (days)", r?.leadDays ?? 14, "number", {
          min: 0,
          max: 365,
          step: 1,
          required: true,
        }),
        sel(
          "supplierId",
          "Default supplier",
          [{ id: "", label: "No default supplier" }, ...sup],
          r?.supplierId || "",
          false,
        ),
        f("unit", "Unit", r?.unit || "pcs", "text", { required: true }),
      ];
    case "supplier":
      return [
        f("name", "Supplier name", "", "text", { required: true }),
        f("contact", "Contact person"),
        f("email", "Email", "", "email"),
        f("terms", "Payment terms", "Net 30"),
      ];
    case "warehouse":
      return [
        f("name", "Warehouse name", "", "text", { required: true }),
        f("location", "Location", "", "text", { required: true }),
        sel("type", "Warehouse type", ["local", "fba", "overseas"], "local"),
      ];
    case "purchase":
      return [
        sel("supplierId", "Supplier", sup, sup[0]?.id),
        sel("warehouseId", "Receiving warehouse", wh, wh[0]?.id),
        f("expectedDate", "Expected arrival", d, "date", { required: true }),
        note("note", "Internal note"),
      ];
    case "sale":
      return [
        f("customer", "Customer", "", "text", { required: true }),
        sel(
          "channel",
          "Sales channel",
          ["Amazon", "Shopify", "Direct", "Wholesale"],
          "Amazon",
        ),
        sel("warehouseId", "Fulfillment warehouse", wh, wh[0]?.id),
        note("note", "Internal note"),
      ];
    case "shipment":
      return [
        sel("sourceId", "Source warehouse", wh, wh[0]?.id),
        sel(
          "destinationId",
          "Destination warehouse",
          wh,
          r?.destinationId || wh[1]?.id,
        ),
        f("carrier", "Carrier", "Internal transport", "text", {
          required: true,
        }),
        f("tracking", "Tracking / reference"),
        f("expectedDate", "Expected arrival", d, "date", { required: true }),
        m("freightCents", "Freight tracking amount ($)"),
        note("note", "Internal note"),
      ];
    case "adjust":
      return [
        sel(
          "productId",
          "Product",
          s.products.map((x) => ({ id: x.id, label: x.sku + " · " + x.name })),
          s.products[0]?.id,
        ),
        sel("warehouseId", "Warehouse", wh, wh[0]?.id),
        f("delta", "Quantity change (+ / −)", 1, "number", {
          step: 1,
          required: true,
        }),
        m(
          "unitCents",
          "Unit cost for added stock ($)",
          s.products[0]?.costCents,
        ),
        { ...note("reason", "Reason (required)"), required: true },
      ];
    case "purchase-payment":
    case "sale-payment":
      return [
        m(
          "amountCents",
          "Amount ($)",
          total(r) - (r.refundCents || 0) - r.paidCents,
        ),
        f("date", "Payment date", d, "date", { required: true }),
        note("note", "Reference / note"),
      ];
    case "expense":
      return [
        sel(
          "category",
          "Category",
          ["Advertising", "Logistics", "Software", "Operations", "Other"],
          "Advertising",
        ),
        m("amountCents", "Amount ($)"),
        f("date", "Expense date", d, "date", { required: true }),
        { ...note("description", "Description (required)"), required: true },
      ];
    case "campaign":
      return [
        f("name", "Campaign name", "", "text", { required: true }),
        sel("channel", "Channel", ["Amazon", "Shopify", "Direct"], "Amazon"),
        m("budgetCents", "Budget ($)"),
        m("spendCents", "Spend ($)"),
        m("attributedSalesCents", "Attributed sales ($)"),
      ];
    case "ticket":
      return [
        f("customer", "Customer", "", "text", { required: true }),
        f("subject", "Subject", "", "text", { required: true }),
        sel(
          "category",
          "Category",
          ["Order", "Return", "Quality", "Other"],
          "Order",
        ),
        sel("priority", "Priority", ["normal", "high"], "normal"),
        sel(
          "orderId",
          "Related order",
          [
            { id: "", label: "No related order" },
            ...s.sales.map((x) => ({
              id: x.id,
              label: x.id + " · " + x.customer,
            })),
          ],
          "",
          false,
        ),
        { ...note("message", "Message (required)"), required: true },
      ];
    case "task":
      return [
        f("title", "Task title", "", "text", { required: true }),
        f("owner", "Owner", s.currentUser.name),
        f("dueDate", "Due date", d, "date", { required: true }),
        sel("priority", "Priority", ["normal", "high"], "normal"),
      ];
    case "user":
      return [
        f("name", "Name", "", "text", { required: true }),
        f("email", "Email", "", "email", { required: true }),
        f("password", "Initial password", "", "password", { required: true }),
        sel(
          "role",
          "Role",
          s.roles
            .filter((x) => x.status === "0")
            .map((x) => ({ id: x.roleKey, label: x.roleName })),
          "analyst",
        ),
      ];
    case "user-edit":
      return [
        sel(
          "role",
          "Primary role (replaces current assignments)",
          s.roles.map((x) => ({ id: x.roleKey, label: x.roleName })),
          r.role,
        ),
        sel(
          "active",
          "Access",
          [
            { id: "true", label: "Active" },
            { id: "false", label: "Disabled" },
          ],
          String(r.active),
        ),
      ];
    case "menu":
      return [
        f("menuName", "Menu name", r.menuName, "text", { required: true }),
        f("orderNum", "Display order", r.orderNum, "number", {
          min: 0,
          max: 10000,
          step: 1,
          required: true,
        }),
        sel(
          "visible",
          "Visibility",
          [
            { id: "0", label: "Shown" },
            { id: "1", label: "Hidden" },
          ],
          r.visible,
        ),
        sel(
          "status",
          "Status",
          [
            { id: "0", label: "Enabled" },
            { id: "1", label: "Disabled" },
          ],
          r.status,
        ),
      ];
    default:
      return [];
  }
}
const titles = {
  product: "Add product",
  supplier: "Add supplier",
  warehouse: "Add warehouse",
  purchase: "New purchase order",
  sale: "New sales order",
  shipment: "Create warehouse transfer",
  receive: "Receive purchase order",
  return: "Record a sales return",
  adjust: "Adjust inventory",
  "purchase-payment": "Record supplier payment",
  "sale-payment": "Record customer payment",
  expense: "Record operating expense",
  campaign: "Record campaign performance",
  ticket: "Open customer ticket",
  task: "New operational task",
  user: "Add workspace user",
  "user-edit": "Edit access",
  role: "Role permissions",
  menu: "Edit menu",
  assign: "Assign user roles",
};
export function ModalHost() {
  const { modal } = useWorkspace();
  return modal ? (
    <FormDialog key={modal.type + "-" + (modal.id || "new")} modal={modal} />
  ) : null;
}
function FormDialog({ modal }) {
  const { state: s, setModal, busy, act, can, notify } = useWorkspace(),
    dialog = useRef(),
    [error, setError] = useState("");
  const { type, id } = modal;
  const collection = {
    product: "products",
    receive: "purchases",
    "purchase-payment": "purchases",
    return: "sales",
    "sale-payment": "sales",
    "user-edit": "users",
    assign: "users",
    role: "roles",
    menu: "permissionMenus",
    "ticket-view": "tickets",
  }[type];
  const record = collection
    ? s[collection].find((x) => String(x.id ?? x.menuId) === String(id))
    : null;
  const initialProduct =
    s.products.find((p) => p.id === modal.initial?.productId) || s.products[0];
  const [lines, setLines] = useState(
    initialProduct
      ? [
          {
            productId: initialProduct.id,
            qty: modal.initial?.qty || 1,
            price: dollar(
              type === "sale"
                ? initialProduct.priceCents
                : initialProduct.costCents,
            ),
          },
        ]
      : [],
  );
  const [menuIds, setMenuIds] = useState(new Set(record?.menuIds || [])),
    [roleIds, setRoleIds] = useState(new Set(record?.roleIds || []));
  const close = () => {
    if (!busy) setModal(null);
  };
  useEffect(() => {
    const d = dialog.current;
    d.showModal();
    const cancel = (e) => {
      e.preventDefault();
      close();
    };
    d.addEventListener("cancel", cancel);
    return () => {
      d.removeEventListener("cancel", cancel);
      if (d.open) d.close();
    };
  }, []);
  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setError("");
    try {
      let p = Object.fromEntries(new FormData(e.target));
      for (const k of [
        "costCents",
        "priceCents",
        "unitCents",
        "amountCents",
        "budgetCents",
        "spendCents",
        "attributedSalesCents",
        "freightCents",
      ])
        if (k in p) p[k] = cents(p[k]);
      for (const k of ["reorderPoint", "leadDays", "delta", "orderNum"])
        if (k in p) p[k] = Number(p[k]);
      if (["purchase", "sale", "shipment"].includes(type)) {
        p.lines = lines.map((l) => ({
          productId: l.productId,
          qty: Number(l.qty),
          unitCents: type === "shipment" ? 0 : cents(l.price),
        }));
        for (const k of ["line-product", "line-qty", "line-price"]) delete p[k];
      }
      const actions = {
        product: record ? "product.update" : "product.create",
        supplier: "supplier.create",
        warehouse: "warehouse.create",
        purchase: "purchase.create",
        sale: "sale.create",
        shipment: "shipment.create",
        adjust: "inventory.adjust",
        expense: "expense.create",
        campaign: "campaign.create",
        ticket: "ticket.create",
        task: "task.create",
        user: "user.create",
        "user-edit": "user.update",
        "purchase-payment": "purchase.pay",
        "sale-payment": "sale.pay",
        receive: "purchase.receive",
        return: "sale.return",
        role: "role.save",
        menu: "menu.save",
        assign: "user.assignRoles",
      };
      if (record) p.id = record.id;
      if (type === "user-edit") p.active = p.active === "true";
      if (type === "receive" || type === "return")
        p = {
          id: record.id,
          lines: record.lines
            .map((l) => ({
              productId: l.productId,
              qty: Number(p["receipt-" + l.productId] || 0),
            }))
            .filter((x) => x.qty > 0),
        };
      if (type === "role")
        p = { ...p, roleId: record?.roleId || 0, menuIds: [...menuIds] };
      if (type === "menu") p.menuId = record.menuId;
      if (type === "assign") p = { id: record.id, roleIds: [...roleIds] };
      await act(
        actions[type],
        p,
        type === "receive"
          ? "Purchase receipt recorded. Stock updated."
          : type === "return"
            ? "Return recorded. Stock and balances updated."
            : "Record saved.",
      );
    } catch (e) {
      setError(e.message);
    }
  };
  if (type === "confirm")
    return (
      <dialog ref={dialog} className="modal">
        <div className="modal-header">
          <div>
            <h2>{modal.title}</h2>
            <p>{modal.description}</p>
          </div>
        </div>
        <div className="modal-footer">
          <Button kind="secondary" onClick={close}>
            Keep document
          </Button>
          <Button kind="danger" onClick={modal.confirm}>
            Cancel document
          </Button>
        </div>
      </dialog>
    );
  if (type === "ticket-view")
    return (
      <dialog ref={dialog} className="modal">
        <div className="modal-header">
          <div>
            <h2>{record.subject}</h2>
            <p>
              {record.customer} · {record.id}
            </p>
          </div>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={close}
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-body">
          <div className="ticket-notes">
            {record.notes.map((n, i) => (
              <article key={i}>
                <div>
                  <strong>{n.actor}</strong>
                  <small>{formatDate(n.at)}</small>
                </div>
                <p>{n.text}</p>
              </article>
            ))}
          </div>
          {can("ticket.transition") && (
            <form
              id="ticket-note-form"
              onSubmit={async (e) => {
                e.preventDefault();
                try {
                  await act(
                    "ticket.transition",
                    { id: record.id, note: new FormData(e.target).get("note") },
                    "Internal note added.",
                  );
                } catch (e) {
                  setError(e.message);
                }
              }}
            >
              <label>
                Add internal note
                <textarea name="note" required maxLength="2000" rows="3" />
              </label>
              {error && <p className="form-error">{error}</p>}
              <button className="btn primary" type="submit" disabled={busy}>
                Add note
              </button>
            </form>
          )}
        </div>
      </dialog>
    );
  const isLines = ["purchase", "sale", "shipment"].includes(type),
    isReceipt = type === "receive" || type === "return";
  const schemaRecord = type === "shipment" ? modal.initial : record;
  return (
    <dialog ref={dialog} className="modal" aria-label={titles[type]}>
      <div className="modal-header">
        <div>
          <span className="eyebrow">
            {["role", "menu", "assign"].includes(type)
              ? "RUOYI PERMISSION SYSTEM"
              : "WORKSPACE ACTION"}
          </span>
          <h2>
            {record && type === "product" ? "Edit product" : titles[type]}
          </h2>
          <p>
            {type === "role"
              ? "Assign page visibility and individual action permissions. Changes apply on the next request."
              : type === "assign"
                ? "A user receives the union of permissions from all enabled assigned roles."
                : type === "shipment"
                  ? "Reserve → dispatch → receive. Inventory cost travels with the goods."
                  : type === "campaign"
                    ? "Manual tracking only. No external campaign is created."
                    : record?.id || "Changes are saved in this workspace."}
          </p>
        </div>
        <button
          className="icon-button modal-close"
          aria-label="Close dialog"
          onClick={close}
        >
          <Icon name="close" />
        </button>
      </div>
      <form id="action-form" onSubmit={submit}>
        <div className="modal-body">
          <div className="form-grid">
            {schema(type, schemaRecord, s).map((f) => (
              <Field key={f.name} {...f} />
            ))}
          </div>
          {isLines && (
            <div className="line-editor">
              <div className="line-editor-heading">
                <h3>Line items</h3>
                <span>USD · whole quantities</span>
              </div>
              <div id="line-rows">
                {lines.map((line, index) => (
                  <div className="line-row" key={index}>
                    <label>
                      Product
                      <select
                        className="line-product"
                        name="line-product"
                        value={line.productId}
                        onChange={(e) => {
                          const p = s.products.find(
                            (p) => p.id === e.target.value,
                          );
                          setLines((a) =>
                            a.map((l, i) =>
                              i === index
                                ? {
                                    ...l,
                                    productId: p.id,
                                    price: dollar(
                                      type === "sale"
                                        ? p.priceCents
                                        : p.costCents,
                                    ),
                                  }
                                : l,
                            ),
                          );
                        }}
                      >
                        {s.products.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.sku} · {p.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Quantity
                      <input
                        name="line-qty"
                        type="number"
                        min="1"
                        max="1000000"
                        step="1"
                        value={line.qty}
                        required
                        onChange={(e) =>
                          setLines((a) =>
                            a.map((l, i) =>
                              i === index ? { ...l, qty: e.target.value } : l,
                            ),
                          )
                        }
                      />
                    </label>
                    {type !== "shipment" && (
                      <label>
                        Unit {type === "sale" ? "price" : "cost"} ($)
                        <input
                          name="line-price"
                          type="number"
                          min="0"
                          max="100000"
                          step=".01"
                          value={line.price}
                          required
                          onChange={(e) =>
                            setLines((a) =>
                              a.map((l, i) =>
                                i === index
                                  ? { ...l, price: e.target.value }
                                  : l,
                              ),
                            )
                          }
                        />
                      </label>
                    )}
                    <button
                      type="button"
                      className="icon-button remove-line"
                      aria-label="Remove line item"
                      onClick={() =>
                        lines.length === 1
                          ? notify(
                              "A document needs at least one line.",
                              "error",
                            )
                          : setLines((a) => a.filter((_, i) => i !== index))
                      }
                    >
                      <Icon name="close" />
                    </button>
                  </div>
                ))}
              </div>
              <Button
                kind="small secondary"
                id="add-line"
                onClick={() => {
                  const next = s.products.find(
                    (p) => !lines.some((l) => l.productId === p.id),
                  );
                  if (!next) {
                    notify("All catalog products have been added.", "error");
                    return;
                  }
                  setLines((a) => [
                    ...a,
                    {
                      productId: next.id,
                      qty: 1,
                      price: dollar(
                        type === "sale" ? next.priceCents : next.costCents,
                      ),
                    },
                  ]);
                }}
              >
                <Icon name="plus" />
                Add another product
              </Button>
              <div id="line-total" className="line-total">
                {type === "shipment" ? (
                  `${lines.length} product line(s)`
                ) : (
                  <>
                    Document total
                    <strong>
                      {money(
                        Math.round(
                          lines.reduce(
                            (n, l) => n + Number(l.qty) * Number(l.price) * 100,
                            0,
                          ),
                        ),
                      )}
                    </strong>
                  </>
                )}
              </div>
            </div>
          )}
          {isReceipt && (
            <div className="receipt-lines">
              <p className="help-text">
                {type === "receive"
                  ? "Receive all remaining quantities, or enter a partial receipt."
                  : "Enter returned quantities. Goods return to the original warehouse."}
              </p>
              {record.lines
                .filter(
                  (l) =>
                    l.qty - l[type === "receive" ? "received" : "returned"] > 0,
                )
                .map((l) => (
                  <label className="receipt-line" key={l.productId}>
                    <div>
                      <strong>
                        {s.products.find((p) => p.id === l.productId)?.name}
                      </strong>
                      <small>
                        {s.products.find((p) => p.id === l.productId)?.sku} ·{" "}
                        {l.qty -
                          l[type === "receive" ? "received" : "returned"]}{" "}
                        remaining
                      </small>
                    </div>
                    <input
                      data-product={l.productId}
                      name={"receipt-" + l.productId}
                      type="number"
                      min="0"
                      max={
                        l.qty - l[type === "receive" ? "received" : "returned"]
                      }
                      step="1"
                      defaultValue={type === "receive" ? l.qty - l.received : 0}
                      required
                      aria-label={
                        "Quantity for " +
                        s.products.find((p) => p.id === l.productId)?.sku
                      }
                    />
                  </label>
                ))}
            </div>
          )}
          {type === "role" && (
            <>
              <div className="form-grid">
                <Field
                  name="roleName"
                  label="Role name"
                  value={record?.roleName}
                  required
                />
                <Field
                  name="roleKey"
                  label="Role key"
                  value={record?.roleKey}
                  required
                />
                <Field
                  name="status"
                  label="Status"
                  value={record?.status || "0"}
                  options={[
                    { id: "0", label: "Enabled" },
                    { id: "1", label: "Disabled" },
                  ]}
                />
                <Field
                  name="remark"
                  label="Description"
                  value={record?.remark}
                />
              </div>
              <div className="permission-groups">
                {s.permissionMenus
                  .filter((m) => m.menuType !== "F")
                  .map((root) => (
                    <fieldset key={root.menuId}>
                      <legend>{root.menuName}</legend>
                      <label>
                        <input
                          type="checkbox"
                          aria-label={"View " + root.menuName}
                          checked={menuIds.has(root.menuId)}
                          onChange={(e) =>
                            setMenuIds((old) => {
                              const n = new Set(old);
                              if (e.target.checked) n.add(root.menuId);
                              else {
                                n.delete(root.menuId);
                                s.permissionMenus
                                  .filter((m) => m.parentId === root.menuId)
                                  .forEach((m) => n.delete(m.menuId));
                              }
                              return n;
                            })
                          }
                        />
                        View page <code>{root.perms}</code>
                      </label>
                      {s.permissionMenus
                        .filter(
                          (m) =>
                            m.parentId === root.menuId && m.menuType === "F",
                        )
                        .map((m) => (
                          <label key={m.menuId}>
                            <input
                              type="checkbox"
                              aria-label={m.action}
                              checked={menuIds.has(m.menuId)}
                              onChange={(e) =>
                                setMenuIds((old) => {
                                  const n = new Set(old);
                                  if (e.target.checked) {
                                    n.add(m.menuId);
                                    n.add(root.menuId);
                                  } else n.delete(m.menuId);
                                  return n;
                                })
                              }
                            />
                            {m.action}
                            <code>{m.perms}</code>
                          </label>
                        ))}
                    </fieldset>
                  ))}
              </div>
            </>
          )}
          {type === "assign" && (
            <div className="permission-groups">
              {s.roles.map((r) => (
                <label key={r.roleId} className="role-choice">
                  <input
                    type="checkbox"
                    aria-label={r.roleName}
                    checked={roleIds.has(r.roleId)}
                    onChange={(e) =>
                      setRoleIds((old) => {
                        const n = new Set(old);
                        e.target.checked ? n.add(r.roleId) : n.delete(r.roleId);
                        return n;
                      })
                    }
                  />
                  <strong>{r.roleName}</strong>
                  <span>
                    {r.roleKey} · {r.status === "0" ? "Enabled" : "Disabled"}
                  </span>
                </label>
              ))}
            </div>
          )}
          {error && <p className="form-error">{error}</p>}
        </div>
        <div className="modal-footer">
          <span>
            <Icon name="check" />
            Saved to this workspace
          </span>
          <Button kind="secondary" id="form-cancel" onClick={close}>
            Cancel
          </Button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy
              ? "Saving…"
              : record && type === "product"
                ? "Save changes"
                : "Save record"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
