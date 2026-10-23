import React from "react";
import { tr } from "./i18n";
const labels = {
  salesRecordNumber: "Platform order number",
  platformOrderId: "Mabang order number",
  erpOrderId: "Mabang internal ID",
  id: "Source ID",
  shopId: "Shop ID",
  shopName: "Shop",
  platformId: "Purchased platform",
  orderStatus: "Order status",
  paidTime: "Payment time",
  expressTime: "Shipment time",
  shipTime: "Delivery time (source)",
  createDate: "Created at",
  update_time: "Updated at",
  buyerName: "Recipient",
  buyerUserId: "Buyer ID",
  buyerEmail: "Email address",
  buyerPhone: "Phone",
  buyerMobile: "Mobile",
  buyerAddress1: "Address line 1",
  buyerAddress2: "Address line 2",
  buyerCity: "City",
  buyerProvince: "State / province",
  buyerPostCode: "Postal code",
  buyerStreet: "Street",
  countryCode: "Country",
  trackNumber: "Tracking number",
  trackNumber1: "Internal tracking number",
  trackNumber2: "Alternate tracking number",
  myLogisticsChannelName: "Shipping channel",
  myLogisticsId: "Carrier ID",
  myLogisticsChannelId: "Shipping channel ID",
  shippingProvider: "Shipping service",
  shipping_warehouse: "Shipping warehouse",
  warehouseName: "Warehouse",
  currencyId: "Currency",
  itemTotalOrigin: "Original goods amount",
  orderFee: "Order amount",
  shippingFee: "Shipping income",
  orderItem: "Order items",
  stockSku: "SKU",
  platformSku: "Platform SKU",
  title: "Product name",
  quantity: "Quantity",
  sellPriceOrigin: "Original unit price",
  isTuotou: "Delivery status",
  remark: "Remarks",
  buyerMessage: "Buyer message",
  billing_address: "Billing address",
  district: "District",
  phone1: "Phone",
  postCode: "Postal code",
  province: "State / province",
  hasBuyerMessage: "Buyer message flag",
  sellerName: "Salesperson",
  weight: "Weight",
  canSend: "Order exception flag",
  paidFlag: "Payment status",
  source: "Order source",
  orderCost: "Order cost",
  orderWeight: "Order weight",
  shippingWeight: "Shipping weight",
  orderFinancialDetails: "Financial breakdown",
  platformOrderTags: "Platform order tags",
  platformFulfillmentStatus: "Platform fulfillment",
  originExtendShopName: "Original shop",
  originExtendEmail: "Original email",
};
function present(v) {
  if (v == null || v === "") return false;
  if (Array.isArray(v)) return v.some(present);
  if (typeof v === "object") return Object.values(v).some(present);
  return true;
}
function Value({ value }) {
  if (Array.isArray(value))
    return (
      <div className="source-array">
        {value.filter(present).map((v, i) => (
          <div key={i} className="source-array-item">
            <small>{i + 1}</small>
            <Value value={v} />
          </div>
        ))}
      </div>
    );
  if (value && typeof value === "object")
    return (
      <dl className="source-field-grid">
        {Object.entries(value)
          .filter(([, v]) => present(v))
          .map(([k, v]) => (
            <div
              key={k}
              className={typeof v === "object" ? "source-field-nested" : ""}
            >
              <dt>{tr(labels[k] || k)}</dt>
              <dd>
                <Value value={v} />
              </dd>
            </div>
          ))}
      </dl>
    );
  return (
    <span>
      {typeof value === "boolean" ? tr(value ? "Yes" : "No") : String(value)}
    </span>
  );
}
export function OrderSourceFields({ fields, open = false }) {
  const entries = Object.entries(fields || {}).filter(([, v]) => present(v));
  if (!entries.length) return null;
  const groups = [
    [
      "Buyer and delivery address",
      /buyer|address|city|province|post|street|country|district|email|phone|mobile/i,
    ],
    [
      "Shipping and delivery",
      /logistic|track|shipping|express|warehouse|tuotou|shipTime|transport/i,
    ],
    [
      "Payment and amounts",
      /fee|price|cost|amount|currency|rate|paid|payment|financial|settlement/i,
    ],
    ["Order items and remaining fields", /.*/],
  ];
  let rest = entries;
  return (
    <details className="order-source-fields" open={open}>
      <summary>
        {tr("Complete order information")}{" "}
        <span>
          {entries.length} {tr("source fields")}
        </span>
      </summary>
      <p className="help-text">
        {tr(
          "All non-empty source fields are retained. Unmapped fields use their source names; dates and codes follow the source values.",
        )}
      </p>
      {groups.map(([name, pattern]) => {
        const values = rest.filter(([k]) => pattern.test(k));
        rest = rest.filter(([k]) => !pattern.test(k));
        return values.length ? (
          <details className="order-source-group" key={name} open>
            <summary>
              {tr(name)} <small>{values.length}</small>
            </summary>
            <Value value={Object.fromEntries(values)} />
          </details>
        ) : null;
      })}
    </details>
  );
}
