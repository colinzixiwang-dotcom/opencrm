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
function mailHeaders(text) {
  return /(From|发件人)\s*[:：]/i.test(text) && /(To|收件人)\s*[:：]/i.test(text) &&
    /(Subject|主题)\s*[:：]/i.test(text) && /(Date|Sent|日期|发送时间)\s*[:：]/i.test(text);
}
function extractTail(doc, marker) {
  const before = doc.createRange(); before.selectNodeContents(doc.body); before.setEndBefore(marker);
  if (!before.toString().trim()) return [];
  const tail = doc.createRange(); tail.selectNodeContents(doc.body); tail.setStartBefore(marker);
  return [...tail.extractContents().childNodes];
}
function quotedHistory(doc) {
  // Outlook's explicit reply header is stronger evidence than a blockquote:
  // a customer may quote policy in their NEW message before the old mail starts.
  for (const header of doc.querySelectorAll('[id="divRplyFwdMsg"]')) {
    if (!mailHeaders(header.textContent)) continue;
    const separator = header.previousElementSibling;
    const quote = extractTail(doc, separator?.tagName === "HR" ? separator : header);
    if (quote.length) return quote;
  }
  // Samsung HTML uses a text separator. Require a complete nearby mail header.
  for (const marker of doc.querySelectorAll("div,p")) {
    if (!/^-{3,}\s*(Original message|原始邮件)\s*-{3,}$/i.test(marker.textContent.trim()) || marker.closest("table")) continue;
    const tail = doc.createRange(); tail.selectNodeContents(doc.body); tail.setStartBefore(marker);
    if (!mailHeaders(tail.toString().slice(0, 1600))) continue;
    const quote = extractTail(doc, marker);
    if (quote.length) return quote;
  }
  const quoted = doc.querySelector(".gmail_quote, .yahoo_quoted, blockquote");
  if (quoted) {
    const tail = doc.createRange(); tail.selectNodeContents(doc.body); tail.setStartAfter(quoted);
    // An ordinary in-body quote followed by new writing must remain visible.
    if (tail.toString().trim()) return [];
    const header = quoted.previousElementSibling;
    const includeHeader = header && /^(On .{6,500} wrote:|在.{6,500}写道[：:])$/s.test(header.textContent.trim());
    return extractTail(doc, includeHeader ? header : quoted);
  }
  return [];
}
function inlineFiles(doc) {
  const files = [];
  // Recognize Outlook's explicit file chips. Ordinary prose links stay in place.
  for (const link of doc.querySelectorAll('a[id^="OLK_Beautified_"]')) {
    const href = safeLink(link.getAttribute("href"));
    const name = link.textContent.replace(/[\u200b\ufeff]/g, "").replace(/\s+/g, " ").trim();
    if (!href || !/^https?:/.test(href) || !/\.(pdf|docx?|xlsx?|pptx?|zip|png|jpe?g)$/i.test(name)) continue;
    const host = new URL(href).hostname;
    files.push({ href, name, provider: host === "1drv.ms" || host === "onedrive.live.com" ? "OneDrive" : host });
    link.remove();
  }
  return files;
}
function nodes(list, prefix = "mail", preserveSpace = false) {
  return [...list].map((node, index) => {
    const key = prefix + index;
    if (node.nodeType === 3)
      return preserveSpace
        ? node.textContent
        : node.textContent.replace(/[\u200b\ufeff]/g, "").replace(/\s+/g, " ");
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
    if (tag === "div" && (node.style.marginTop || node.style.marginBottom) && !node.querySelector("div,p,table,ul,ol,blockquote")) props.className = "mail-paragraph";
    if (tag === "ol") {
      const start = Number(node.getAttribute("start"));
      if (Number.isInteger(start) && start > 0) props.start = start;
    }
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
    const files = inlineFiles(doc);
    return { main: nodes(doc.body.childNodes), quote: nodes(quote, "quote"), files };
  }, [html]);
  return (
    <div className="conversation-body mail-content">
      {content.files.length > 0 && <div className="mail-inline-files">
        <span>{tr("Files linked in this email")}</span>
        {content.files.map((file, index) => <a key={index} href={file.href} target="_blank" rel="noopener noreferrer"><span><strong>{file.name}</strong><small>{file.provider}</small></span><span>{tr("Open link")} ↗</span></a>)}
      </div>}
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
