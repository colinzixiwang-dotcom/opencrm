import React, { useEffect, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import workerURL from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { LoadingState, Pagination } from "./components";
import { tr } from "./i18n";

GlobalWorkerOptions.workerSrc = workerURL;
export default function PDFPreview({ url }) {
  const container = useRef(null),
    canvas = useRef(null);
  const [pdf, setPdf] = useState(null),
    [page, setPage] = useState(1),
    [width, setWidth] = useState(600),
    [busy, setBusy] = useState(true),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    const task = getDocument({
      url,
      isEvalSupported: false,
      useSystemFonts: true,
    });
    task.promise
      .then((doc) => {
        if (active) setPdf(doc);
      })
      .catch(() => {
        if (active) {
          setFailed(true);
          setBusy(false);
        }
      });
    return () => {
      active = false;
      task.destroy();
    };
  }, [url]);
  useEffect(() => {
    const observer = new window.ResizeObserver((entries) =>
      setWidth(Math.max(200, entries[0].contentRect.width)),
    );
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!pdf) return;
    let active = true,
      task;
    setBusy(true);
    pdf
      .getPage(page)
      .then((source) => {
        if (!active) return;
        const base = source.getViewport({ scale: 1 }),
          fit = (width - 24) / base.width,
          ratio = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = source.getViewport({ scale: fit * ratio }),
          node = canvas.current;
        node.width = Math.ceil(viewport.width);
        node.height = Math.ceil(viewport.height);
        node.style.width = Math.floor(viewport.width / ratio) + "px";
        node.style.height = Math.floor(viewport.height / ratio) + "px";
        task = source.render({
          canvasContext: node.getContext("2d"),
          viewport,
        });
        return task.promise;
      })
      .then(() => {
        if (active) setBusy(false);
      })
      .catch((error) => {
        if (active && error.name !== "RenderingCancelledException") {
          setFailed(true);
          setBusy(false);
        }
      });
    return () => {
      active = false;
      task?.cancel();
    };
  }, [pdf, page, width]);
  return (
    <div className="pdf-preview" ref={container}>
      {failed ? (
        <p className="attachment-unavailable" role="alert">
          {tr("Preview unavailable. Open the original attachment to view it.")}
        </p>
      ) : (
        <>
          <div className="pdf-page">
            {busy && (
              <LoadingState
                label="Loading attachment…"
                variant="compact"
                rows={3}
              />
            )}
            <canvas
              ref={canvas}
              aria-label={tr("PDF page {page}", { page })}
              data-rendered={!busy}
              style={{ visibility: busy ? "hidden" : "visible" }}
            />
          </div>
          {pdf && (
            <Pagination
              label="PDF pagination"
              page={page}
              totalPages={pdf.numPages}
              onPrevious={() => setPage((n) => n - 1)}
              onNext={() => setPage((n) => n + 1)}
            />
          )}
        </>
      )}
    </div>
  );
}
