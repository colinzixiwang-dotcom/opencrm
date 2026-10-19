import React, { useMemo } from "react";
import { tr } from "./i18n";

const allowed = new Set([
  "p",
  "br",
  "div",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "ul",
  "ol",
  "li",
  "strong",
  "b",
  "em",
  "i",
  "u",
  "pre",
  "code",
  "blockquote",
  "hr",
]);
const blocked = new Set([
  "script",
  "style",
  "noscript",
  "head",
  "iframe",
  "object",
  "embed",
  "form",
  "input",
  "button",
  "svg",
  "math",
  "link",
  "meta",
]);
function safeLink(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol)
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
// Flatten only explicit mail layout tables with at most one meaningful cell per
// row. Ambiguous tables and any headers/merged cells retain their data structure.
function layoutTable(table) {
  const explicit = table.getAttribute("role") === "presentation" ||
    ["border", "cellpadding", "cellspacing"].every((key) => table.getAttribute(key) === "0");
  return explicit && ![...table.querySelectorAll("th,[colspan],[rowspan]")].some((cell) => cell.closest("table") === table) &&
    [...table.rows].every((row) => [...row.cells].filter((cell) => cell.textContent.trim()).length <= 1);
}
function quotedHistory(doc) {
  const quoted = doc.querySelector(".gmail_quote, .yahoo_quoted, blockquote");
  if (quoted) {
    const tail = doc.createRange();
    tail.selectNodeContents(doc.body); tail.setStartAfter(quoted);
    // Never hide inline replies placed after a recognized quote.
    if (tail.toString().trim()) return [];
    const header = quoted.previousElementSibling;
    const includeHeader = header && /^(On .{6,500} wrote:|在.{6,500}写道[：:])$/s.test(header.textContent.trim());
    const before = doc.createRange(); before.selectNodeContents(doc.body); before.setEndBefore(includeHeader ? header : quoted);
    if (!before.toString().trim()) return [];
    const result = [...(includeHeader ? [header] : []), quoted];
    if (includeHeader) header.remove(); quoted.remove();
    return result;
  }
  // Samsung/Outlook HTML often has no blockquote. Require both a separator and
  // recognizable message headers, and keep the complete original HTML in a fold.
  for (const marker of doc.querySelectorAll("div,p")) {
    if (!/^-{3,}\s*(Original message|原始邮件)\s*-{3,}$/i.test(marker.textContent.trim()) || marker.closest("table")) continue;
    const tail = doc.createRange(); tail.selectNodeContents(doc.body); tail.setStartBefore(marker);
    const text = tail.toString();
    if (!/(From|发件人)\s*[:：]/i.test(text) || !/(To|收件人)\s*[:：]/i.test(text) || !/(Subject|主题)\s*[:：]/i.test(text) || !/(Date|Sent|日期|发送时间)\s*[:：]/i.test(text)) continue;
    const before = doc.createRange(); before.selectNodeContents(doc.body); before.setEndBefore(marker);
    if (!before.toString().trim()) continue;
    return [...tail.extractContents().childNodes];
  }
  return [];
}
function nodes(list, prefix = "mail", preserveSpace = false) {
  return [...list].map((node, index) => {
    const key = prefix + index;
    if (node.nodeType === 3)
      return preserveSpace
        ? node.textContent
        : node.textContent.replace(/\s+/g, " ");
    if (node.nodeType !== 1) return null;
    const tag = node.tagName.toLowerCase();
    if (blocked.has(tag) || tag === "img") return null;
    if (
      !["br", "hr", "td", "th"].includes(tag) &&
      !node.textContent.trim() &&
      !node.querySelector("table")
    )
      return null;
    if (tag === "table" && layoutTable(node))
      return <div key={key} className="mail-layout">{[...node.rows].map((row, rowIndex) =>
        <div key={rowIndex}>{[...row.cells].map((cell, cellIndex) => <div key={cellIndex}>{nodes(cell.childNodes, key + "-layout-" + rowIndex + "-" + cellIndex)}</div>)}</div>
      )}</div>;
    const children = nodes(
      node.childNodes,
      key + "-",
      preserveSpace || tag === "pre",
    );
    if (tag === "a") {
      const href = safeLink(node.getAttribute("href"));
      return href ? (
        <a key={key} href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      ) : (
        <React.Fragment key={key}>{children}</React.Fragment>
      );
    }
    if (tag === "table")
      return (
        <div key={key} className="mail-table-scroll">
          <table>{children}</table>
        </div>
      );
    if (!allowed.has(tag))
      return <React.Fragment key={key}>{children}</React.Fragment>;
    const props = { key };
    if (node.id === "composer_signature" || node.classList.contains("gmail_signature")) props.className = "mail-signature";
    if (["td", "th"].includes(tag))
      for (const [attribute, prop] of [
        ["colspan", "colSpan"],
        ["rowspan", "rowSpan"],
      ]) {
        const span = Number(node.getAttribute(attribute));
        if (Number.isInteger(span) && span > 1 && span <= 50)
          props[prop] = span;
      }
    return React.createElement(
      tag,
      props,
      ["br", "hr"].includes(tag) ? undefined : children,
    );
  });
}
export function MailContent({ html }) {
  const content = useMemo(() => {
    const doc = new window.DOMParser().parseFromString(
      String(html || ""),
      "text/html",
    );
    doc
      .querySelectorAll("script,style,noscript,head,iframe,object,embed")
      .forEach((node) => node.remove());
    const quote = quotedHistory(doc);
    return { main: nodes(doc.body.childNodes), quote: nodes(quote, "quote") };
  }, [html]);
  return (
    <div className="conversation-body mail-content">
      {content.main}
      {content.quote.length > 0 && (
        <details className="conversation-quote">
          <summary>{tr("Expand quoted history")}</summary>
          <div className="mail-quoted">{content.quote}</div>
        </details>
      )}
    </div>
  );
}
