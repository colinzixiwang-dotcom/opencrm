import React, {
  useEffect,
  useRef,
  useState,
  createContext,
  useContext,
  lazy,
  Suspense,
} from "react";
import { Icon, LoadingState, Pagination } from "./components";
import { tr, intlLocale } from "./i18n";

const PDFPreview = lazy(() => import("./pdf-preview"));
export const AttachmentContext = createContext(null);
function attachment(file, index) {
  const raw =
    typeof file === "string"
      ? file
      : file?.url || file?.file_url || file?.download_url;
  try {
    const url = new URL(raw);
    if (!["https:", "http:"].includes(url.protocol)) return null;
    const original =
      typeof file === "object" ? file.name || file.file_name : "";
    const name = (
      original ||
      decodeURIComponent(url.pathname).split("/").pop() ||
      tr("Attachment")
    )
      .split("/")
      .pop();
    const ext = (
      name.match(/\.([a-z0-9]+)$/i)?.[1] ||
      url.pathname.match(/\.([a-z0-9]+)$/i)?.[1] ||
      ""
    ).toLowerCase();
    const mime = file?.content_type || file?.mime_type || "";
    const kind =
      ext === "eml" || mime === "message/rfc822" ? "email" :
      /^(png|jpe?g|gif|webp|avif|bmp)$/.test(ext) || mime.startsWith("image/")
        ? "image"
        : ext === "pdf" || mime === "application/pdf"
          ? "pdf"
          : /^(mp4|webm|mov)$/.test(ext)
            ? "video"
            : /^(mp3|wav|ogg|m4a)$/.test(ext)
              ? "audio"
              : "file";
    return { url: url.href, name, kind, index, size: Number(file?.file_size || file?.size) || 0 };
  } catch {
    return null;
  }
}
function Preview({ file, onClose, navigation, onPrevious, onNext }) {
  const ref = useRef(null);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    ref.current.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="attachment-preview"
      aria-label={tr("Attachment preview")}
      onCancel={onClose}
      onKeyDown={(e) => {
        if (e.altKey || e.ctrlKey || e.metaKey || e.target.closest?.("video,audio,input,textarea,select,[contenteditable]")) return;
        if (e.key === "ArrowLeft" && onPrevious) { e.preventDefault(); onPrevious(); }
        if (e.key === "ArrowRight" && onNext) { e.preventDefault(); onNext(); }
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <header className="attachment-preview-header">
        <div>
          <span className="eyebrow">{tr("Attachment preview")}</span>
          <h2>{file.name}</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={tr("Close preview")}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="attachment-preview-body">
        {!failed &&
          !loaded &&
          ["image", "video", "audio"].includes(file.kind) && (
            <LoadingState
              label="Loading attachment…"
              variant="compact"
              rows={2}
            />
          )}
        {failed ? (
          <p className="attachment-unavailable">
            {tr(
              "Preview unavailable. Open the original attachment to view it.",
            )}
          </p>
        ) : file.kind === "image" ? (
          <img
            src={file.url}
            alt={file.name}
            className={!loaded ? "preview-media-pending" : undefined}
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
          />
        ) : file.kind === "pdf" ? (
          <Suspense
            fallback={
              <LoadingState
                label="Loading attachment…"
                variant="compact"
                rows={3}
              />
            }
          >
            <PDFPreview url={file.url} />
          </Suspense>
        ) : file.kind === "video" ? (
          <video
            controls
            onLoadedData={() => setLoaded(true)}
            src={file.url}
            onError={() => setFailed(true)}
          />
        ) : file.kind === "audio" ? (
          <audio
            controls
            onLoadedData={() => setLoaded(true)}
            src={file.url}
            onError={() => setFailed(true)}
          />
        ) : (
          <div className="attachment-unavailable">
            <Icon name="download" />
            <p>{tr(file.kind === "email" ? "Download this email to view it in your email application." : "This file type opens in its original application.")}</p>
          </div>
        )}
      </div>
      <footer>
        {navigation || <span>{tr("Source attachment from Udesk")}</span>}
        <a
          className="btn secondary"
          href={file.kind === "email" ? file.url : file.originalURL || file.url}
          download={file.kind === "email" ? file.name : undefined}
          target="_blank"
          rel="noreferrer"
        >
          {tr(file.kind === "email" ? "Download original email" : "Open original attachment")}
          <Icon name="arrow" />
        </a>
      </footer>
    </dialog>
  );
}
export function AttachmentList({ value }) {
  const [position, setPosition] = useState({ key: "", index: 0, preview: false });
  const scope = useContext(AttachmentContext);
  const files = (Array.isArray(value) ? value : [value])
    .map(attachment)
    .filter(Boolean)
    .map((file) => {
      if (!scope) return file;
      const url = new URL(file.url),
        params = new URLSearchParams({ ref: url.origin + url.pathname });
      if (file.kind === "email") params.set("download", "1");
      if (scope.replyPage) params.set("replyPage", String(scope.replyPage));
      return {
        ...file,
        originalURL: file.url,
        url:
          `/api/tickets/${encodeURIComponent(scope.ticketId)}/attachment?` +
          params,
      };
    });
  const key = JSON.stringify(files.map((file) => [file.url, file.name]));
  const index = position.key === key ? Math.min(position.index, files.length - 1) : 0;
  const previewOpen = position.key === key && position.preview;
  const move = (delta, preview = false) => setPosition({ key, index: Math.max(0, Math.min(files.length - 1, index + delta)), preview });
  const pager = (preview = false) => files.length > 1 ? <Pagination compact
    label={preview ? "Attachment preview navigation" : "Attachment pagination"}
    previousLabel="Previous attachment" nextLabel="Next attachment"
    page={index + 1} totalPages={files.length}
    onPrevious={() => move(-1, preview)} onNext={() => move(1, preview)} /> : null;
  if (!files.length) return null;
  return (
    <>
      <div className="attachment-gallery">
      <div className="attachment-list" aria-live="polite">
        {files.map((file, i) => file.kind === "email" ? (
          <a key={file.url + ":" + i} className="attachment-card attachment-email" href={file.url} download={file.name} title={file.name} aria-label={tr("Download original email")}>
            <span className="attachment-thumbnail"><Icon name="download" /></span>
            <span className="attachment-caption"><strong>{tr("Original email")}</strong><small>EML{file.size > 0 ? " · " + new Intl.NumberFormat(intlLocale(), {maximumFractionDigits: 1}).format(file.size / 1024) + " KB" : ""}</small></span>
            <span className="attachment-open">{tr("Download")}</span>
          </a>
        ) : (
          <button
            key={file.url + ":" + i}
            type="button"
            className="attachment-card"
            aria-label={tr("Preview {name}", { name: file.name })}
            onClick={() => setPosition({key, index: i, preview: true})}
          >
            <span className="attachment-thumbnail">
              {file.kind === "image" ? (
                <img
                  loading="lazy"
                  src={file.url}
                  alt=""
                  onError={(e) => {
                    e.currentTarget.hidden = true;
                  }}
                />
              ) : (
                <Icon name="download" />
              )}
            </span>
            <span className="attachment-caption">
              <strong title={file.name}>{file.name}</strong>
              <small>
                {tr("Preview attachment")} ·{" "}
                {file.kind === "file" ? tr("File") : file.kind.toUpperCase()}
              </small>
            </span>
            <span className="attachment-open" aria-hidden="true">
              ↗
            </span>
          </button>
        ))}
      </div>
      </div>
      {previewOpen && (
        <Preview
          key={files[index].url}
          file={files[index]}
          onClose={() => setPosition({key, index, preview:false})}
          navigation={pager(true)}
          onPrevious={index > 0 ? () => move(-1, true) : undefined}
          onNext={index < files.length - 1 ? () => move(1, true) : undefined}
        />
      )}
    </>
  );
}
