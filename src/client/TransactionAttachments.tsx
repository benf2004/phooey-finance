import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Paperclip, Download, Trash2, ExternalLink } from "lucide-react";
import { api } from "./api";
import { useWorkspace } from "./context";
import { Button, ErrorNotice, Modal } from "./ui";
import {
  attachmentPath as path,
  AttachmentPicker,
  UploadFeedback,
  useAttachmentUpload,
} from "./AttachmentUpload";
import { fileSize, type Attachment } from "../shared/attachments";
import "./attachments.css";

const url = (attachment: Attachment) =>
  `/api${path(attachment.transaction_id)}/${encodeURIComponent(attachment.id)}`;

export function TransactionAttachments({
  transactionId,
  disabled,
  onBusyChange,
  onPreviewChange,
  autoFocus = false,
}: {
  transactionId?: string;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onPreviewChange: (open: boolean) => void;
  autoFocus?: boolean;
}) {
  const { refresh } = useWorkspace();
  const section = useRef<HTMLElement>(null);
  const focused = useRef(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(!!transactionId);
  const [removing, setRemoving] = useState(false);
  const upload = useAttachmentUpload((attachment) => {
    setAttachments((current) => [
      ...current.filter((a) => a.id !== attachment.id),
      attachment,
    ]);
  }, onBusyChange);
  const { error, setError, setStatus } = upload;
  const busy = removing || upload.busy;
  const [preview, setPreview] = useState<Attachment | null>(null);
  const previewTrigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!autoFocus || loading || focused.current || !section.current) return;
    focused.current = true;
    section.current.focus({ preventScroll: true });
    const dialog = section.current.closest("dialog");
    if (dialog)
      dialog.scrollTop +=
        section.current.getBoundingClientRect().top -
        dialog.getBoundingClientRect().top -
        16;
  }, [autoFocus, loading]);
  useEffect(() => {
    onPreviewChange(!!preview);
    if (!preview) previewTrigger.current?.focus();
  }, [preview, onPreviewChange]);
  const load = async () => {
    if (!transactionId) return;
    setLoading(true);
    try {
      setAttachments(await api<Attachment[]>(path(transactionId)));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
  }, [transactionId]);
  function markBusy(value: boolean) {
    setRemoving(value);
    onBusyChange(value);
  }
  return (
    <section
      ref={section}
      tabIndex={-1}
      className="transaction-attachments"
      aria-label="Receipts and invoices"
    >
      <div className="attachment-heading">
        <h3>
          <Paperclip size={15} /> Receipts & invoices{" "}
          {attachments.length > 0 && (
            <span className="muted">({attachments.length})</span>
          )}
        </h3>
        {transactionId && (
          <AttachmentPicker
            label="Add files"
            className="button secondary"
            count={attachments.length}
            disabled={disabled || busy || loading}
            onChoose={(files) =>
              upload.choose({ id: transactionId }, attachments.length, files)
            }
          >
            Add files
          </AttachmentPicker>
        )}
      </div>
      {!transactionId ? (
        <p className="inline-note">
          Save this transaction, then add receipts from the Transactions table.
        </p>
      ) : (
        <>
          <p className="inline-note">
            Images or PDFs · 20 MB per stored file · Photos optimized using your
            Settings. PDFs kept unchanged.
          </p>
          {loading && <p role="status">Loading attachments…</p>}
          {attachments.length > 0 && (
            <ul className="attachment-list">
              {attachments.map((attachment) => (
                <li key={attachment.id}>
                  <button
                    type="button"
                    className="attachment-name"
                    onClick={(e) => {
                      previewTrigger.current = e.currentTarget;
                      setPreview(attachment);
                    }}
                    title={`Preview ${attachment.filename}`}
                  >
                    <span>{attachment.filename}</span>
                    <small>
                      {fileSize(attachment.size)}
                      {attachment.original_size > attachment.size
                        ? ` · ${Math.round((1 - attachment.size / attachment.original_size) * 100)}% smaller`
                        : " · original size"}
                    </small>
                  </button>
                  <a
                    className="icon-button"
                    href={url(attachment) + "?download=1"}
                    download
                    aria-label={`Download ${attachment.filename}`}
                  >
                    <Download size={16} />
                  </a>
                  <button
                    type="button"
                    className="icon-button"
                    disabled={disabled || busy}
                    aria-label={`Remove ${attachment.filename}`}
                    onClick={async () => {
                      if (
                        !confirm(
                          `Remove ${attachment.filename} from this transaction?`,
                        )
                      )
                        return;
                      markBusy(true);
                      setError(null);
                      try {
                        await api(path(transactionId) + "/" + attachment.id, {
                          method: "DELETE",
                        });
                        setAttachments((current) =>
                          current.filter((a) => a.id !== attachment.id),
                        );
                        setStatus("Attachment removed.");
                        refresh();
                      } catch (e) {
                        setError((e as Error).message);
                      } finally {
                        markBusy(false);
                      }
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <UploadFeedback upload={upload} disabled={disabled || removing} />
          {error && (
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => void load()}
            >
              Refresh attachments
            </Button>
          )}
          <small className="muted">Attachments save immediately.</small>
        </>
      )}
      {preview &&
        createPortal(
          <AttachmentPreview
            attachment={preview}
            onClose={() => setPreview(null)}
          />,
          document.body,
        )}
    </section>
  );
}

function AttachmentPreview({
  attachment,
  onClose,
}: {
  attachment: Attachment;
  onClose: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actualSize, setActualSize] = useState(false);
  const pdf = attachment.content_type === "application/pdf";
  const supportsPDF = navigator.pdfViewerEnabled;
  useEffect(() => {
    const dialog = container.current?.querySelector("dialog");
    dialog?.setAttribute("aria-label", attachment.filename);
    const cancel = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    dialog?.addEventListener("cancel", cancel);
    return () => dialog?.removeEventListener("cancel", cancel);
  }, [onClose]);
  useEffect(() => {
    const abort = new AbortController();
    let objectUrl: string | undefined;
    const timer = setTimeout(() => {
      abort.abort();
      setError(
        "The preview took too long to load. Open the file in a new tab or download it instead.",
      );
      setLoading(false);
    }, 15000);
    void (async () => {
      try {
        const response = await fetch(url(attachment), { signal: abort.signal });
        if (!response.ok) {
          const data = (await response.json()) as { error?: string };
          throw new Error(data.error ?? "Preview unavailable.");
        }
        const blob = await response.blob();
        if (abort.signal.aborted) return;
        clearTimeout(timer);
        objectUrl = URL.createObjectURL(blob);
        setSource(objectUrl);
        if (pdf && !supportsPDF) setLoading(false);
      } catch (e) {
        clearTimeout(timer);
        if (!abort.signal.aborted) {
          setError((e as Error).message);
          setLoading(false);
        }
      }
    })();
    return () => {
      clearTimeout(timer);
      abort.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.id]);
  return (
    <div ref={container}>
      <Modal
        title={attachment.filename}
        onClose={onClose}
        className="attachment-preview"
        wide
      >
        <div className="actions attachment-preview-actions">
          <a
            className="button secondary"
            href={url(attachment)}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink size={15} />
            Open in new tab
          </a>
          <a
            className="button secondary"
            href={url(attachment) + "?download=1"}
            download
          >
            <Download size={15} />
            Download
          </a>
          <span className="muted">{fileSize(attachment.size)}</span>
          {!pdf && source && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => setActualSize((value) => !value)}
            >
              {actualSize ? "Fit image" : "Actual size"}
            </Button>
          )}
        </div>
        {loading && <p role="status">Loading preview…</p>}
        <ErrorNotice error={error} />
        {source &&
          !error &&
          (pdf ? (
            supportsPDF ? (
              <iframe
                className="attachment-pdf"
                src={source}
                title={`PDF preview: ${attachment.filename}`}
                onLoad={() => setLoading(false)}
                onError={() => {
                  setError(
                    "The PDF preview could not load. Open or download the file instead.",
                  );
                  setLoading(false);
                }}
              />
            ) : (
              <p className="notice">
                This browser does not support embedded PDFs. Download the
                document to read every page.
              </p>
            )
          ) : (
            <div
              className={`attachment-image-scroll ${actualSize ? "actual-size" : ""}`}
              tabIndex={actualSize ? 0 : undefined}
              aria-label="Image preview"
            >
              <img
                className="attachment-image"
                src={source}
                alt={attachment.filename}
                onLoad={() => setLoading(false)}
                onError={() => {
                  setError(
                    "This image could not be previewed. Download it to open in another app.",
                  );
                  setLoading(false);
                }}
              />
            </div>
          ))}
        {pdf && (
          <p className="inline-note">
            Use the PDF viewer’s page controls to read the full document. If the
            preview is blank, open it in a new tab or download it.
          </p>
        )}
      </Modal>
    </div>
  );
}
