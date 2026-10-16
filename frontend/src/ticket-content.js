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
