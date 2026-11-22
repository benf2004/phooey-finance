import { LoaderCircle } from "lucide-react";
import { Button, Panel } from "../ui";
import "./bank-sync.css";

export type SyncJob = {
  id: string;
  kind: string;
  status: string;
  progress: string;
  error: string | null;
  created_at: string;
  syncProgress: {
    from: string;
    to: string;
    totalWindows: number;
    completedWindows: number;
    recordsProcessed: number;
    percent: number;
  } | null;
};

export function BankSyncQueue({
  jobs,
  loading,
  busy,
  onRetry,
}: {
  jobs: SyncJob[];
  loading: boolean;
  busy: boolean;
  onRetry: (id: string) => void;
}) {
  const active = jobs.some((job) => ["queued", "running"].includes(job.status));
  return (
    <Panel
      title="Bank sync queue"
      caption={
        active
          ? "Updates automatically. You can leave this page while syncing continues."
          : undefined
      }
    >
      <div className="panel-body bank-sync-queue" aria-live="polite">
        {!jobs.length && (
          <p className="muted">
            {loading
              ? "Loading sync jobs…"
              : "No bank syncs yet. Your imports will appear here."}
          </p>
        )}
        {jobs.map((job) => {
          const syncing = ["queued", "running"].includes(job.status);
          const progress = job.syncProgress;
          return (
            <article className="bank-sync-job" key={job.id}>
              <div className="bank-sync-job-heading">
                <strong>
                  {syncing && <LoaderCircle size={14} className="spin" />}{" "}
                  {job.status === "complete" && job.error
                    ? "Complete with warnings"
                    : job.status === "running"
                      ? "Syncing"
                      : job.status === "queued"
                        ? "Queued"
                        : job.status === "failed"
                          ? "Failed"
                          : job.status === "cancelled"
                            ? "Cancelled"
                            : "Complete"}
                </strong>
                <time className="muted">
                  {new Date(
                    job.created_at.replace(" ", "T") + "Z",
                  ).toLocaleString()}
                </time>
              </div>
              {progress && (
                <>
                  <p className="muted">
                    {progress.from} → {progress.to}
                  </p>
                  <progress
                    aria-label="Bank sync progress"
                    max={100}
                    value={progress.percent}
                  />
                  <p className="bank-sync-counts">
                    <span>
                      {progress.percent}% · {progress.completedWindows} of{" "}
                      {progress.totalWindows} date ranges finished
                    </span>
                    <span>
                      {progress.recordsProcessed.toLocaleString()} records
                      processed
                    </span>
                  </p>
                </>
              )}
              <p>
                {job.progress || (syncing ? "Waiting to start" : job.status)}
              </p>
              {job.error && (
                <p className="bank-sync-error">
                  {job.error}
                  {syncing && " — Retrying automatically."}
                </p>
              )}
              {job.status === "failed" && (
                <Button
                  variant="secondary"
                  busy={busy}
                  disabled={active}
                  onClick={() => onRetry(job.id)}
                >
                  Retry sync
                </Button>
              )}
            </article>
          );
        })}
      </div>
    </Panel>
  );
}
