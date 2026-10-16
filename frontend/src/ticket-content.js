// Keep meaningful paragraph breaks while removing mail-client layout whitespace.
export function normalizeMessage(value) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u00a0\u200b\ufeff]/g, " ")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
export function messageText(value, html = false) {
  if (!html) return normalizeMessage(value);
  const doc = new window.DOMParser().parseFromString(
    String(value || ""),
    "text/html",
  );
  doc
    .querySelectorAll("script,style,noscript,head")
    .forEach((node) => node.remove());
  const read = (node) => {
    if (node.nodeType === 3) return node.textContent.replace(/\s+/g, " ");
    if (node.nodeType !== 1) return "";
    if (node.tagName === "BR") return "\n";
    if (node.tagName === "PRE") return "\n" + node.textContent + "\n";
    const content = [...node.childNodes].map(read).join("");
    if (node.tagName === "P") return "\n" + content.trim() + "\n\n";
    if (["TD", "TH"].includes(node.tagName)) return content.trim() + "  ";
    if (node.tagName === "LI") return "\n• " + content.trim() + "\n";
    if (
      [
        "DIV",
        "SECTION",
        "ARTICLE",
        "TR",
        "TABLE",
        "UL",
        "OL",
        "BLOCKQUOTE",
        "H1",
        "H2",
        "H3",
        "H4",
      ].includes(node.tagName)
    )
      return "\n" + content + "\n";
    return content;
  };
  return normalizeMessage(read(doc.body));
}

export function messageParts(value, html = false) {
  const full = messageText(value, html);
  if (html) {
    const doc = new window.DOMParser().parseFromString(
      String(value || ""),
      "text/html",
    );
    doc
      .querySelectorAll("script,style,noscript,head")
      .forEach((node) => node.remove());
    const quoted = doc.querySelector(".gmail_quote, .yahoo_quoted, blockquote");
    if (quoted) {
      const range = doc.createRange();
      range.selectNodeContents(doc.body);
      range.setStartAfter(quoted);
      // Keep the full body if the user added new text after a quote.
      if (!normalizeMessage(range.toString())) {
        const quote = messageText(quoted.outerHTML, true);
        quoted.remove();
        const main = messageText(doc.body.innerHTML, true);
        if (main && quote) return { main, quote };
      }
    }
  }
  const lines = full.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const header = lines[i].trim();
    const nearby = lines.slice(i, i + 12).join("\n");
    const wrote = /^(On .{6,250} wrote:|在.{6,250}写道[：:])$/.test(header);
    const original = /^-{3,}\s*(Original Message|原始邮件)\s*-{3,}$/i.test(
      header,
    );
    const emailHeaders =
      /^(From|发件人)\s*[:：]/i.test(header) &&
      /^(To|收件人)\s*[:：]/im.test(nearby) &&
      /^(Subject|主题|Sent|发送时间|Date|日期)\s*[:：]/im.test(nearby);
    if (wrote || original || emailHeaders) {
      const main = lines.slice(0, i).join("\n").trim();
      if (main) return { main, quote: lines.slice(i).join("\n").trim() };
    }
  }
  return { main: full, quote: "" };
}
