// Source records remain intact; these helpers only select their presentation.
export function customValues(ticket) {
  const object = (value) => {
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        return {};
      }
    }
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  };
  return {
    ...object(ticket.custom_fields_v2),
    ...object(ticket.custom_fields),
  };
}
export function customDefinition(name, ticket, metadata) {
  const template = (metadata?.templates?.templates || []).find(
    (t) => String(t.id) === String(ticket.template_id),
  );
  const field = (metadata?.fields?.fields || []).find(
    (f) => f.field_name === name,
  );
  return {
    field,
    label:
      field?.field_label ||
      template?.custom_fields?.find((f) => f.field_name === name)
        ?.field_title ||
      name,
  };
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
    String(ticket.platform_name || ticket.platform || "").toLowerCase() !==
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
  const definitions = metadata?.fields?.fields || [];
  const lines = original.split("\n");
  const remainder = [];
  for (const line of lines) {
    const definition = definitions.find(
      (field) =>
        line.trim().startsWith(field.field_label + ":") ||
        line.trim().startsWith(field.field_label + "："),
    );
    if (!definition) {
      remainder.push(line);
      continue;
    }
    const value = line
      .trim()
      .slice(definition.field_label.length + 1)
      .trim();
    if (!value || problemLabel(definition.field_label)) {
      remainder.push(line);
      continue;
    }
    if (
      !entries.some(
        (entry) =>
          entry.name === definition.field_name ||
          entry.label === definition.field_label,
      )
    )
      entries.push({
        name: definition.field_name,
        value,
        label: definition.field_label,
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
  if (["internal", "internat"].includes(reply.function_type)) return false;
  const author = reply.author || {};
  const kind = String(author.user_type || "").toLowerCase();
  const customer =
    ["customer", "user", "end_user"].includes(kind) &&
    (author.id != null && ticket.user_id != null
      ? String(author.id) === String(ticket.user_id)
      : (author.email &&
          ticket.user_email &&
          author.email.toLowerCase() === ticket.user_email.toLowerCase()) ||
        (author.nick_name && author.nick_name === ticket.user_name));
  const delta = Date.parse(reply.created_at) - Date.parse(ticket.created_at);
  return customer && Number.isFinite(delta) && delta >= 0 && delta <= 60000;
}
