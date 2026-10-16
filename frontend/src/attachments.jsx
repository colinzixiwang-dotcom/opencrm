import React, { useEffect, useRef, useState } from "react";
import { Icon } from "./components";
import { tr } from "./i18n";

function attachment(file, index) {
  const raw = typeof file === "string" ? file : file?.url || file?.file_url || file?.download_url;
  try {
    const url = new URL(raw);
    if (!["https:", "http:"].includes(url.protocol)) return null;
    const original = typeof file === "object" ? file.name || file.file_name : "";
    const name = (original || decodeURIComponent(url.pathname).split("/").pop() || tr("Attachment")).split("/").pop();
    const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] || url.pathname.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
    const mime = file?.content_type || file?.mime_type || "";
    const kind = /^(png|jpe?g|gif|webp|avif|bmp)$/.test(ext) || mime.startsWith("image/") ? "image" : ext === "pdf" || mime === "application/pdf" ? "pdf" : /^(mp4|webm|mov)$/.test(ext) ? "video" : /^(mp3|wav|ogg|m4a)$/.test(ext) ? "audio" : "file";
    return {url:url.href,name,kind,index};
  } catch { return null; }
}
function Preview({ file, onClose }) {
  const ref = useRef(null);
  const [failed,setFailed] = useState(false);
  useEffect(()=>{ref.current.showModal();},[]);
  return <dialog ref={ref} className="attachment-preview" aria-label={tr("Attachment preview")} onCancel={onClose} onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
    <header className="attachment-preview-header"><div><span className="eyebrow">{tr("Attachment preview")}</span><h2>{file.name}</h2></div><button type="button" className="icon-button" aria-label={tr("Close preview")} onClick={onClose}><Icon name="close" /></button></header>
    <div className="attachment-preview-body">
      {failed ? <p className="attachment-unavailable">{tr("Preview unavailable. Open the original attachment to view it.")}</p> : file.kind === "image" ? <img src={file.url} alt={file.name} onError={()=>setFailed(true)} /> : file.kind === "pdf" ? <iframe title={file.name} src={file.url} sandbox="allow-same-origin" referrerPolicy="no-referrer" /> : file.kind === "video" ? <video controls src={file.url} onError={()=>setFailed(true)} /> : file.kind === "audio" ? <audio controls src={file.url} onError={()=>setFailed(true)} /> : <div className="attachment-unavailable"><Icon name="download" /><p>{tr("This file type opens in its original application.")}</p></div>}
    </div>
    <footer><span>{tr("Source attachment from Udesk")}</span><a className="btn secondary" href={file.url} target="_blank" rel="noreferrer">{tr("Open original attachment")}<Icon name="arrow" /></a></footer>
  </dialog>;
}
export function AttachmentList({ value }) {
  const [selected,setSelected] = useState(null);
  const files = (Array.isArray(value) ? value : [value]).map(attachment).filter(Boolean);
  if (!files.length) return null;
  return <><div className="attachment-list">{files.map((file,i)=><button key={file.url+":"+i} type="button" className="attachment-card" aria-label={tr("Preview {name}",{name:file.name})} onClick={()=>setSelected(file)}>
    <span className="attachment-thumbnail">{file.kind === "image" ? <img loading="lazy" src={file.url} alt="" onError={e=>{e.currentTarget.hidden=true;}} /> : <Icon name="download" />}</span><span className="attachment-caption"><strong title={file.name}>{file.name}</strong><small>{tr("Preview attachment")} · {file.kind === "file" ? tr("File") : file.kind.toUpperCase()}</small></span><span className="attachment-open" aria-hidden="true">↗</span>
  </button>)}</div>{selected && <Preview key={selected.url} file={selected} onClose={()=>setSelected(null)} />}</>;
}
