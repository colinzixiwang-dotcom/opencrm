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
export function problemPresentation(ticket, metadata, original) {
  const entries = Object.entries(customValues(ticket)).map(([name, value]) => ({
    name,
    value,
    ...customDefinition(name, ticket, metadata),
  }));
  const problem = entries.find(
    (e) =>
      /^(Customer Question\s*\/\s*Problem Description|Problem Description|问题描述|客户问题)$/i.test(
        e.label,
      ) &&
      typeof e.value === "string" &&
      e.value.trim(),
  );
  if (!problem || !comparable(original).includes(comparable(problem.value)))
    return { text: original, original: "", omitted: [] };
  // Fold generated submissions only when every piece is represented elsewhere.
  let residue = comparable(original);
  for (const e of [...entries].sort(
    (a, b) => String(b.value).length - String(a.value).length,
  )) {
    if (typeof e.value !== "string" || !e.value.trim()) continue;
    const options = [];
    const visit = (list) =>
      (list || []).forEach((option) => {
        options.push(option);
        visit(option.subs);
      });
    visit(e.field?.options);
    const option = options.find((o) => String(o.value) === String(e.value));
    const shown = option?.title || e.value;
    residue = residue.split(comparable(shown)).join("");
    residue = residue.split(comparable(e.label)).join("");
  }
  residue = residue
    .replace(/^Original customer submission\s*:/i, "")
    .replace(/[\s:;,/|—–-]+/g, "");
  const covered =
    /^Original customer submission\s*:/i.test(original) && !residue;
  return {
    text: covered ? problem.value.trim() : original,
    original: covered ? original : "",
    omitted: [problem.name],
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

// Extract only an unmistakable trailing contact block; never infer a summary.
export function structureProblem(text, ticket = {}) {
  let body = String(text || "")
    .replace(/\r\n?/g, "\n")
    .trim();
  const contacts = [];
  const lines = body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const email = ticket.user_email;
  const contactLine = email
    ? lines.findIndex((line) =>
        line.toLowerCase().endsWith(email.toLowerCase()),
      )
    : -1;
  if (contactLine >= 0 && lines.length - contactLine <= 8) {
    const line = lines[contactLine];
    const emailAt = line.toLowerCase().lastIndexOf(email.toLowerCase());
    const before = line.slice(0, emailAt).trim();
    const name = ticket.user_name || "";
    const knownSuffix = !before || (name && before.endsWith(name));
    const tail = lines.slice(contactLine + 1);
    const phone = (value) =>
      /^\+?[\d() .-]{7,25}$/.test(value) &&
      (value.match(/\d/g) || []).length >= 7;
    const address = (value) =>
      (/\b(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|court|ct|blvd|way|suite|apt)\b/i.test(
        value,
      ) &&
        /\d/.test(value)) ||
      /\b\d{5}(?:-\d{4})?$/.test(value) ||
      /^.{2,60}(?:省|市|区|县|路|街|号).*$/.test(value);
    if (knownSuffix && tail.every((value) => phone(value) || address(value))) {
      const prefix =
        name && before.endsWith(name)
          ? before.slice(0, -name.length).trim()
          : before;
      const addressLines = tail.filter((value) => !phone(value));
      const phones = tail.filter(phone);
      if (addressLines.length)
        contacts.push({
          label: "Submitted address",
          value: addressLines.join("\n"),
        });
      for (const value of phones)
        if (
          value.replace(/\D/g, "") !==
          String(
            ticket.user_cellphone || ticket.customer_telephone || "",
          ).replace(/\D/g, "")
        )
          contacts.push({ label: "Submitted phone", value });
      // Email/name already appear in the customer sidebar. Preserve all source text in the original toggle.
      const candidate = [...lines.slice(0, contactLine), prefix]
        .filter(Boolean)
        .join("\n")
        .trim();
      if (candidate) body = candidate;
      else contacts.length = 0;
    }
  }
  const numbered =
    /\bfirst (?:issue|problem)\b/i.test(body) &&
    /\b(?:second|third) (?:issue|problem)|\b(?:The|My) second\b/i.test(body);
  const paragraphs = body
    .split(/\n\s*\n/)
    .filter(Boolean)
    .flatMap((part) =>
      numbered
        ? part.split(/(?<=[.!?])\s+(?=(?:The|My) (?:second|third)\b)/i)
        : [part],
    );
  return {
    paragraphs,
    contacts,
    numbered: numbered && paragraphs.length > 1,
    reformatted:
      body !==
      String(text || "")
        .replace(/\r\n?/g, "\n")
        .trim(),
  };
}
