import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api } from "./api";
import { useWorkspace } from "./context";
import { Button, ErrorNotice } from "./ui";
import { prepareAttachment } from "./attachment-compression";
import {
  MAX_ATTACHMENTS,
  type Attachment,
  type CompressionSettings,
} from "../shared/attachments";

type Upload = { id: string; file: File; prepared?: File; error?: string };
type UploadTarget = { id: string; description?: string };

export const attachmentPath = (id: string) =>
  `/transactions/${encodeURIComponent(id)}/attachments`;

export function useAttachmentUpload(
  onAttachment?: (attachment: Attachment) => void,
  onBusyChange?: (busy: boolean) => void,
) {
  const { refresh } = useWorkspace();
  const [target, setTarget] = useState<UploadTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [failed, setFailed] = useState<Upload[]>([]);
  const running = useRef(false);
  const request = useRef<XMLHttpRequest | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
    };
  }, []);
  async function upload(target: UploadTarget, files: Upload[]) {
    if (running.current) return;
    running.current = true;
    setTarget(target);
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    setStatus("Preparing files…");
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
              xhr.open("POST", "/api" + attachmentPath(target.id));
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
          onAttachment?.(attachment);
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
      running.current = false;
      setBusy(false);
      onBusyChange?.(false);
      if (completed) refresh();
    }
  }

  function choose(target: UploadTarget, count: number, files: File[]) {
    if (!files.length || running.current) return;
    if (count + files.length > MAX_ATTACHMENTS) {
      setTarget(target);
      setFailed([]);
      setStatus("");
      setError(`Choose up to ${MAX_ATTACHMENTS - count} more files.`);
      return;
    }
    void upload(
      target,
      files.map((file) => ({ file, id: crypto.randomUUID() })),
    );
  }
  return {
    busy,
    error,
    setError,
    status,
    setStatus,
    failed,
    target,
    choose,
    retry: () => {
      if (target && failed.length) void upload(target, failed);
    },
  };
}

export function AttachmentPicker({
  count,
  disabled,
  label,
  children,
  className,
  onChoose,
}: {
  count: number;
  disabled: boolean;
  label: string;
  children: ReactNode;
  className: string;
  onChoose: (files: File[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
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
          onChoose(files);
        }}
      />
      <button
        type="button"
        className={className}
        aria-label={label}
        title={count >= MAX_ATTACHMENTS ? "Attachment limit reached" : label}
        disabled={disabled || count >= MAX_ATTACHMENTS}
        onClick={() => input.current?.click()}
      >
        {children}
      </button>
    </>
  );
}

export function UploadFeedback({
  upload,
  disabled = false,
}: {
  upload: ReturnType<typeof useAttachmentUpload>;
  disabled?: boolean;
}) {
  const { target, status, failed, busy, error } = upload;
  return (
    <>
      {target?.description && (status || error) && (
        <strong>{target.description}</strong>
      )}
      {status && (
        <p className="inline-note" role="status">
          {status}
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
            onClick={upload.retry}
          >
            Retry failed files
          </Button>
        </div>
      )}
      <ErrorNotice error={error} />
    </>
  );
}
