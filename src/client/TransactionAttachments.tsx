import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Paperclip, Download, Trash2, ExternalLink } from "lucide-react";
import { api } from "./api";
import { useWorkspace } from "./context";
import { Button, ErrorNotice, Modal } from "./ui";
import { prepareAttachment } from "./attachment-compression";
import {
  fileSize,
  MAX_ATTACHMENTS,
  type Attachment,
  type CompressionSettings,
} from "../shared/attachments";
import "./attachments.css";

type Upload = { id: string; file: File; prepared?: File; error?: string };
const path = (transactionId: string) =>
  `/transactions/${encodeURIComponent(transactionId)}/attachments`;
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [failed, setFailed] = useState<Upload[]>([]);
  const [preview, setPreview] = useState<Attachment | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const previewTrigger = useRef<HTMLButtonElement | null>(null);
  const request = useRef<XMLHttpRequest | null>(null);
  const mounted = useRef(true);
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
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
    };
  }, []);
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
    setBusy(value);
    onBusyChange(value);
  }
  async function upload(files: Upload[]) {
    if (!transactionId) return;
    markBusy(true);
    setError(null);
    setFailed([]);
    const failures: Upload[] = [];
    let completed = 0;
    try {
      const settings = await api<CompressionSettings>(
        "/settings/attachment-compression",
      );
      for (const item of files) {
        if (!mounted.current) break;
        try {
          setStatus(`Preparing ${item.file.name}…`);
          const prepared =
            item.prepared ?? (await prepareAttachment(item.file, settings));
          item.prepared = prepared;
          if (!mounted.current) break;
          const attachment = await new Promise<Attachment>(
            (resolve, reject) => {
              const xhr = new XMLHttpRequest();
              request.current = xhr;
              xhr.open("POST", "/api" + path(transactionId));
              xhr.timeout = 120000;
              xhr.setRequestHeader("Content-Type", prepared.type);
              xhr.setRequestHeader(
                "X-File-Name",
                encodeURIComponent(prepared.name),
              );
              xhr.setRequestHeader("X-Original-Size", String(item.file.size));
              xhr.setRequestHeader("Idempotency-Key", item.id);
              xhr.upload.onprogress = (e) =>
                setStatus(
                  `Uploading ${item.file.name}${e.lengthComputable ? ` · ${Math.round((e.loaded / e.total) * 100)}%` : ""}…`,
                );
              xhr.onload = () => {
                try {
                  const data = JSON.parse(xhr.responseText);
                  if (xhr.status >= 200 && xhr.status < 300 && data?.id)
                    resolve(data);
                  else
                    reject(
                      new Error(
                        data.error ??
                          "Upload failed. Refresh the list and retry.",
                      ),
                    );
                } catch {
                  reject(
                    new Error(
                      "Could not confirm the upload. Refresh the list before retrying.",
                    ),
                  );
                }
              };
              xhr.onerror = () =>
                reject(
                  new Error(
                    "Connection lost. Retry to safely confirm this upload.",
                  ),
                );
              xhr.ontimeout = () =>
                reject(
                  new Error(
                    "Upload timed out. Retry to safely confirm this upload.",
                  ),
                );
              xhr.onabort = () => reject(new Error("Upload cancelled."));
              xhr.send(prepared);
            },
          );
          if (!mounted.current) break;
          setAttachments((current) => [
            ...current.filter((a) => a.id !== attachment.id),
            attachment,
          ]);
          completed++;
        } catch (e) {
          failures.push({ ...item, error: (e as Error).message });
        }
      }
      setFailed(failures);
      setStatus(
        `${completed} ${completed === 1 ? "file" : "files"} attached${failures.length ? `; ${failures.length} could not be uploaded` : ""}.`,
      );
    } catch (e) {
      setError((e as Error).message);
      setFailed(files);
      setStatus("");
    } finally {
      request.current = null;
      markBusy(false);
      if (completed && mounted.current) refresh();
    }
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
          <>
            <input
              ref={input}
              hidden
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/avif,application/pdf,.heic,.heif,.avif"
              aria-label="Choose receipt or invoice files"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = "";
                if (files.length + attachments.length > MAX_ATTACHMENTS) {
                  setError(
                    `Choose up to ${MAX_ATTACHMENTS - attachments.length} more files.`,
                  );
                  return;
                }
                if (files.length)
                  void upload(
                    files.map((file) => ({ file, id: crypto.randomUUID() })),
                  );
              }}
            />
            <Button
              type="button"
              variant="secondary"
              disabled={
                disabled ||
                busy ||
                loading ||
                attachments.length >= MAX_ATTACHMENTS
              }
              onClick={() => input.current?.click()}
            >
              Add files
            </Button>
          </>
        )}
      </div>
      {!transactionId ? (
        <p className="inline-note">
          Save this transaction, then reopen it to attach receipts or invoices.
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
          {status && (
            <p className="inline-note" role="status">
              {status}
              {busy && " Please keep this dialog open."}
            </p>
          )}
          {failed.length > 0 && (
            <div className="attachment-failures">
              <ul>
                {failed.map((item) => (
                  <li key={item.id}>
                    {item.file.name}: {item.error ?? "Upload did not start."}
                  </li>
                ))}
              </ul>
              <Button
                type="button"
                variant="secondary"
                disabled={busy || disabled}
                onClick={() => void upload(failed)}
              >
                Retry failed files
              </Button>
            </div>
          )}
          <ErrorNotice error={error} />
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
