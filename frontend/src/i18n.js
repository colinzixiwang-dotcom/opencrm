import zh from "./locales/zh-CN.json" with { type: "json" };

const listeners = new Set();
let language = "en";
try {
  if (
    typeof window !== "undefined" &&
    window.localStorage.getItem("harbor.language") === "zh-CN"
  )
    language = "zh-CN";
} catch {
  /* Storage may be disabled. */
}
const normalized = new Map(
  Object.entries(zh).map(([key, value]) => [
    key.replace(/\s+/g, " ").trim().toLowerCase(),
    value,
  ]),
);
export const getLanguage = () => language;
export const intlLocale = () => (language === "zh-CN" ? "zh-CN" : "en-US");
export function subscribeLanguage(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function setLanguage(next) {
  if (!["en", "zh-CN"].includes(next)) return;
  language = next;
  try {
    window.localStorage.setItem("harbor.language", next);
  } catch {
    /* Keep the in-memory preference. */
  }
  if (typeof document !== "undefined") {
    document.documentElement.lang = next;
    document.title = next === "zh-CN" ? "Harbor · 售后与运营" : "Harbor ERP";
  }
  for (const listener of listeners) listener();
}
export function tr(text, params = {}) {
  if (typeof text !== "string") return text;
  const clean = text.replace(/\s+/g, " ").trim();
  let translated = text;
  if (language === "zh-CN") {
    const value =
      (Object.hasOwn(zh, text) ? zh[text] : undefined) ??
      normalized.get(clean.toLowerCase());
    if (value != null)
      translated =
        text.slice(0, text.indexOf(clean[0])) +
        value +
        (text.match(/\s+$/)?.[0] || "");
    else translated = translatePattern(text);
  }
  return translated.replace(/\{(\w+)\}/g, (match, key) =>
    params[key] == null ? match : String(params[key]),
  );
}
const patterns = [
  [/^Udesk returned HTTP (\d+)\.$/, (m) => `Udesk 返回 HTTP ${m[1]}。`],
  [
    /^Udesk rejected the request \(code (.+)\)\.$/,
    (m) => `Udesk 拒绝了请求（错误码 ${m[1]}）。`,
  ],
  [/^View (.+)$/, (m) => `查看${tr(m[1])}`],
  [/^Sort by (.+)$/, (m) => `按${tr(m[1])}排序`],
  [/^Edit (.+)$/, (m) => `编辑${tr(m[1])}`],
  [/^Add (.+)$/, (m) => `新增${tr(m[1])}`],
  [/^(.+) must be a whole number\.$/, (m) => `${tr(m[1])}必须为整数。`],
  [
    /^Insufficient available stock for (.+)\.$/,
    (m) => `${m[1]} 的可用库存不足。`,
  ],
  [/^Invalid value: (.+)$/, (m) => `无效值：${m[1]}`],
  [/^(.+) is required\.$/, (m) => `${tr(m[1])}为必填项。`],
  [/^Invalid option for (.+)\.$/, (m) => `${tr(m[1])}的选项无效。`],
  [/^(.+) record not found\.$/, (m) => `未找到${tr(m[1])}记录。`],
  [
    /^Text must be at most (\d+) characters\.$/,
    (m) => `文本最多允许 ${m[1]} 个字符。`,
  ],
  [
    /^(.+) must be a whole number between (-?\d+) and (\d+)\.$/,
    (m) => `${tr(m[1])}必须为 ${m[2]} 到 ${m[3]} 之间的整数。`,
  ],
  [/^(.+) must be unique\.$/, (m) => `${tr(m[1])}必须唯一。`],
  [/^(\d+) days$/, (m) => `${m[1]} 天`],
  [/^(\d+) shipped orders$/, (m) => `${m[1]} 笔已发货订单`],
  [/^(.+) units sold · net of returns$/, (m) => `售出 ${m[1]} 件 · 扣除退货`],
  [
    /^(.+)% margin · after product cost$/,
    (m) => `${m[1]}% 利润率 · 扣除商品成本`,
  ],
  [/^(\d+) product line\(s\)$/, (m) => `${m[1]} 条商品明细`],
];
function translatePattern(text) {
  for (const [pattern, render] of patterns) {
    const match = text.match(pattern);
    if (match) return render(match);
  }
  return text;
}
const statusLabels = {
  open: "待处理",
  done: "已完成",
  draft: "草稿",
  pending: "待审核",
  approved: "已批准",
  ordered: "已订货",
  partial: "部分收货",
  received: "已收货",
  cancelled: "已取消",
  confirmed: "已确认",
  shipped: "已发货",
  completed: "已完成",
  reserved: "已预留",
  in_transit: "运输中",
  active: "已启用",
  inactive: "已停用",
  paused: "已暂停",
  in_progress: "进行中",
  resolved: "已解决",
  pending_approval: "待审批",
  blocked: "已阻塞",
  ready: "可执行",
  rejected: "已拒绝",
  not_required: "无需审批",
  covered: "质保有效",
  expired: "已过保",
  incomplete: "资料不完整",
  ineligible: "不符合条件",
  not_started: "尚未起保",
  admin: "管理员",
  operator: "运营人员",
  analyst: "分析员",
  support_agent: "售后客服",
  support_supervisor: "售后主管",
  device: "整机",
  part: "配件",
  general: "通用",
  printhead: "喷头",
  accessory: "附件",
  component: "组件",
  other: "其他",
  printhead_1080: "1080 喷头",
  printhead_3200: "3200 喷头",
  none: "无",
  normal: "普通",
  high: "高",
  inbound: "入库 / 退回",
  outbound: "出库 / 补发",
  local: "本地",
  overseas: "海外",
  fba: "FBA",
  text: "文本",
  textarea: "长文本",
  select: "选项",
  number: "数字",
  date: "日期",
  rma: "RMA 售后单",
  task: "任务输入",
  execution: "任务执行",
  product: "商品",
  order: "订单",
  serial: "序列号",
  not_connected: "未连接",
  button: "按钮",
  page: "页面",
  enabled: "已启用",
  disabled: "已停用",
  in_stock: "在库",
  sold: "已售",
  returned: "已退回",
  replaced: "已更换",
  retired: "已退役",
  placed: "已下单",
  paid: "已付款",
  delivered: "已签收",
  gift_card: "礼品卡",
  promo_code: "优惠码",
  refund: "退款",
  send_parts: "补发配件",
  send_device: "补发整机",
  return_device: "退回整机",
  purchase_receipt: "采购收货",
  adjustment: "库存调整",
  transfer_out: "调拨出库",
  transfer_in: "调拨入库",
  sale: "销售出库",
  sales_return: "销售退货",
  inflow: "收款",
  outflow: "付款",
};
export function statusTitle(value) {
  const key = String(value || "");
  if (language === "zh-CN" && statusLabels[key]) return statusLabels[key];
  return tr(key.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase()));
}
