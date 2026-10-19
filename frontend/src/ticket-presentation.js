// Presentation consumes the CRM support contract, never provider DTOs.
export function customValues(ticket) {
  return ticket.customValues || {};
}
export function customDefinition(name, ticket, metadata) {
  const template = (metadata?.templates || []).find(t => String(t.id) === String(ticket.templateId));
  const field = (metadata?.fields || []).find(f => f.key === name);
  return { field, label: field?.label || template?.fields?.find(f => f.key === name)?.label || name };
}
const comparable = (value) =>
  String(value || "")
    .replace(/\s+/g, " ")
    .trim();
const populated = (value) =>
  value != null &&
  (typeof value === "string"
    ? value.trim() !== "" && !/^[-—–－]+$/.test(value.trim())
    : Array.isArray(value)
      ? value.some(populated)
      : typeof value === "object"
        ? Object.values(value).some(populated)
        : true);
const problemLabel = (label) =>
  /^(Customer Question\s*\/\s*Problem Description|Problem Description|问题描述|客户问题)$/i.test(
    label,
  );
export function problemPresentation(ticket, metadata, original) {
  const unchanged = { text: original, original: "", omitted: [], fields: [] };
  if (
    String(ticket.channelCode || ticket.channel || "").toLowerCase() !==
    "api"
  )
    return unchanged;
  if (!metadata) return unchanged;
  const entries = Object.entries(customValues(ticket))
    .filter(([, value]) => populated(value))
    .map(([name, value]) => ({
      name,
      value,
      ...customDefinition(name, ticket, metadata),
    }));
  // A legacy API submission may carry known form fields only in its body.
  // Read explicit field-label lines using Udesk definitions, never prose inference.
  const definitions = metadata?.fields || [];
  const lines = original.split("\n");
  const remainder = [];
  for (const line of lines) {
    const definition = definitions.find(
      (field) =>
        line.trim().startsWith(field.label + ":") ||
        line.trim().startsWith(field.label + "："),
    );
    if (!definition) {
      remainder.push(line);
      continue;
    }
    const value = line
      .trim()
      .slice(definition.label.length + 1)
      .trim();
    if (!value || problemLabel(definition.label)) {
      remainder.push(line);
      continue;
    }
    if (
      !entries.some(
        (entry) =>
          entry.name === definition.key ||
          entry.label === definition.label,
      )
    )
      entries.push({
        name: definition.key,
        value,
        label: definition.label,
        field: undefined,
      });
  }
  const problem = entries.find(
    (entry) => problemLabel(entry.label) && typeof entry.value === "string",
  );
  const fields = entries.filter(
    (entry) =>
      !problemLabel(entry.label) && !/submission id/i.test(entry.label),
  );
  const order = [
    "Primary Category",
    "Secondary Issue",
    "Tertiary Symptoms / Keywords",
    "Order Number",
    "Product Serial Number",
    "Purchase Channel",
    "Country / Region",
  ];
  fields.sort(
    (a, b) =>
      (order.includes(a.label) ? order.indexOf(a.label) : 99) -
      (order.includes(b.label) ? order.indexOf(b.label) : 99),
  );
  const text =
    problem?.value.trim() ||
    (fields.length
      ? remainder
          .join("\n")
          .replace(/^\s*Original customer submission\s*:\s*/i, "")
          .trim()
      : original);
  return {
    text,
    original:
      original && (fields.length || comparable(text) !== comparable(original))
        ? original
        : "",
    omitted: [
      ...fields.map((entry) => entry.name),
      ...(problem ? [problem.name] : []),
    ],
    fields,
  };
}
export function isInitialSubmission(reply, ticket, replyText, original) {
  if (!comparable(original) || comparable(replyText) !== comparable(original))
    return false;
  if (reply.kind === "internal") return false;
  const author = reply.author || {};
  const kind = String(author.kind || "").toLowerCase();
  const customer =
    ["customer", "user", "end_user"].includes(kind) &&
    (author.id != null && ticket.customerId != null
      ? String(author.id) === String(ticket.customerId)
      : (author.email &&
          ticket.customerEmail &&
          author.email.toLowerCase() === ticket.customerEmail.toLowerCase()) ||
        (author.name && author.name === ticket.customerName));
  const delta = Date.parse(reply.createdAt) - Date.parse(ticket.createdAt);
  return customer && Number.isFinite(delta) && delta >= 0 && delta <= 60000;
}
