import { useEffect, useState } from "react";
import {
  Link2,
  RefreshCw,
  Download,
  Upload,
  KeyRound,
  Copy,
  Trash2,
  ExternalLink,
  ShieldCheck,
  Plus,
  Server,
} from "lucide-react";
import { useWorkspace } from "../context";
import { api, post } from "../api";
import {
  PageHeading,
  Panel,
  Button,
  Field,
  Modal,
  ErrorNotice,
  useAsync,
} from "../ui";
import { scopes, type Scope } from "../../shared/models";
type Sync = {
  connection: {
    status: string;
    last_success: string | null;
    last_error: string | null;
  } | null;
  jobs: {
    id: string;
    kind: string;
    status: string;
    progress: string;
    error: string | null;
    created_at: string;
  }[];
};
type Token = {
  id: string;
  name: string;
  scopes: string;
  expires_at: number;
  last_used_at: string | null;
};
export default function Settings() {
  const { version, refresh, notify, sourceUrl } = useWorkspace();
  const [tick, setTick] = useState(0),
    [error, setError] = useState<string | null>(null),
    [setup, setSetup] = useState(""),
    [start, setStart] = useState(""),
    [busy, setBusy] = useState(false),
    [tokenDialog, setTokenDialog] = useState(false),
    [secret, setSecret] = useState<string | null>(null);
  const sync = useAsync(() => api<Sync>("/sync"), [version, tick]);
  const tokens = useAsync(() => api<Token[]>("/tokens"), [version]);
  useEffect(() => {
    const active = sync.data?.jobs.some((j) =>
      ["queued", "running"].includes(j.status),
    );
    if (active) {
      const timer = setTimeout(() => {
        setTick((t) => t + 1);
        refresh();
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [sync.data]);
  const run = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      refresh();
      notify(message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeading title="Settings" />
      <ErrorNotice error={error ?? sync.error ?? tokens.error} />
      <div className="settings-grid">
        <Panel
          title="Bank connection"
          caption="Read-only transaction sync through SimpleFIN."
          action={<LandmarkIcon />}
        >
          <div className="panel-body">
            <div className="connection-status">
              <Link2 size={20} className="positive" />
              <div>
                <strong>
                  {sync.data?.connection
                    ? "SimpleFIN connected"
                    : "Ready when you are"}
                </strong>
                <p>
                  {sync.data?.connection?.last_success
                    ? "Last successful sync " +
                      new Date(
                        sync.data.connection.last_success,
                      ).toLocaleString()
                    : "Connect once. Your transactions update twice a day."}
                </p>
              </div>
            </div>
            {sync.data?.connection?.last_error && (
              <ErrorNotice error={sync.data.connection.last_error} />
            )}
            <form
              className="form-stack"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await post("/sync/connect", { token: setup });
                  setSetup("");
                }, "Connection saved; first sync queued");
              }}
            >
              <Field
                label={
                  sync.data?.connection
                    ? "Replace connection token"
                    : "SimpleFIN setup token"
                }
                hint="Generate a one-time setup token in your SimpleFIN account."
              >
                <input
                  type="password"
                  value={setup}
                  onChange={(e) => setSetup(e.target.value)}
                  required
                  autoComplete="off"
                  placeholder="Paste setup token"
                />
              </Field>
              <div className="actions">
                <Button busy={busy} disabled={!setup}>
                  <Link2 size={15} />
                  Connect SimpleFIN
                </Button>
                <a
                  className="text-link"
                  href="https://bridge.simplefin.org/simplefin/create"
                  target="_blank"
                  rel="noreferrer"
                >
                  Get a setup token <ExternalLink size={13} />
                </a>
              </div>
            </form>
            {sync.data?.connection && (
              <div className="form-section">
                <div className="actions">
                  <Button
                    variant="secondary"
                    busy={busy}
                    onClick={() =>
                      void run(() => post("/sync", {}), "Sync queued")
                    }
                  >
                    <RefreshCw size={15} />
                    Sync now
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      if (
                        confirm(
                          "Disconnect SimpleFIN? Existing transactions stay in your ledger.",
                        )
                      )
                        void run(
                          () => post("/sync", {}, "DELETE"),
                          "Bank disconnected",
                        );
                    }}
                  >
                    Disconnect
                  </Button>
                </div>
                <div className="field-row" style={{ marginTop: 18 }}>
                  <Field label="Backfill from">
                    <input
                      type="date"
                      value={start}
                      onChange={(e) => setStart(e.target.value)}
                    />
                  </Field>
                  <Button
                    variant="secondary"
                    style={{ alignSelf: "end" }}
                    disabled={!start || busy}
                    onClick={() =>
                      void run(
                        () => post("/sync", { start }),
                        "Backfill queued",
                      )
                    }
                  >
                    Request history
                  </Button>
                </div>
                <p className="inline-note">
                  History depends on your institution. Requests are spaced
                  within SimpleFIN’s limits.
                </p>
              </div>
            )}
          </div>
        </Panel>
        <Panel
          title="MCP access"
          action={<Server size={19} className="muted" />}
        >
          <div className="panel-body">
            <p>
              Use this server URL in an MCP-compatible client. OAuth opens your
              admin sign-in and shows the permissions requested.
            </p>
            <div className="code-block">{location.origin}/mcp</div>
            <Button
              variant="secondary"
              onClick={async () => {
                await navigator.clipboard.writeText(location.origin + "/mcp");
                notify("MCP URL copied");
              }}
            >
              <Copy size={14} />
              Copy server URL
            </Button>
            <div className="form-section">
              <h3>Personal access tokens</h3>
              <p>
                For clients that support a Bearer authorization header. Start
                with read access and add only the permissions you need.
              </p>
              <Button
                variant="secondary"
                style={{ marginTop: 15 }}
                onClick={() => setTokenDialog(true)}
              >
                <Plus size={15} />
                Create access token
              </Button>
            </div>
            {tokens.data?.map((t) => (
              <div className="token-row" key={t.id}>
                <div>
                  <strong>{t.name}</strong>
                  <small>{JSON.parse(t.scopes).join(", ")}</small>
                  <small>
                    Expires {new Date(t.expires_at * 1000).toLocaleDateString()}
                    {t.last_used_at
                      ? " · Last used " +
                        new Date(t.last_used_at).toLocaleDateString()
                      : ""}
                  </small>
                </div>
                <button
                  className="icon-button"
                  aria-label={"Revoke " + t.name}
                  onClick={() =>
                    void run(
                      () => post("/tokens/" + t.id, {}, "DELETE"),
                      "Access revoked",
                    )
                  }
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="Export & backup">
          <div className="panel-body">
            <p>
              CSV works with spreadsheets. A JSON backup includes your ledger,
              categories, rules, and saved tax plans. Credentials are excluded.
            </p>
            <div className="actions" style={{ marginTop: 20 }}>
              <a className="button secondary" href="/api/export">
                <Download size={15} />
                All transactions
              </a>
              <a className="button secondary" href="/api/backup">
                <Download size={15} />
                Full backup
              </a>
            </div>
            <details className="details" style={{ marginTop: 20 }}>
              <summary>Restore a backup</summary>
              <div>
                <p>
                  Restore into an empty ledger. Existing category defaults will
                  be replaced with the backup. Bank credentials and MCP access
                  must be connected again.
                </p>
                <Field label="Choose a Phooey JSON backup">
                  <input
                    type="file"
                    accept=".json"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      if (
                        !confirm("Restore this backup into this empty ledger?")
                      )
                        return;
                      await run(async () => {
                        if (file.size > 10_000_000)
                          throw new Error(
                            "Use SQL restore for files larger than 10 MB",
                          );
                        await post("/restore", JSON.parse(await file.text()));
                      }, "Backup restored");
                    }}
                  />
                </Field>
              </div>
            </details>
          </div>
        </Panel>
        <Panel
          title="About"
          action={<ShieldCheck size={19} className="muted" />}
        >
          <div className="panel-body">
            <p>
              Phooey Finance runs in your Cloudflare account. Administrator
              credentials are configured as server secrets. No analytics or
              telemetry are added by the application.
            </p>
            <div className="notice" style={{ marginTop: 20 }}>
              AGPL-3.0 · Free software, without warranty. You may use, modify,
              and share it under the license terms.
            </div>
            <div className="actions" style={{ marginTop: 20 }}>
              <a
                className="text-link"
                href={sourceUrl}
                target="_blank"
                rel="noreferrer"
              >
                View source & deployment guide <ExternalLink size={13} />
              </a>
              <a className="text-link" href="/source.tar.gz">
                Download source
              </a>
              <a
                className="text-link"
                href="/LICENSE.txt"
                target="_blank"
                rel="noreferrer"
              >
                License <ExternalLink size={13} />
              </a>
            </div>
          </div>
        </Panel>
        <Panel title="Activity" className="full">
          {sync.data?.jobs.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Job</th>
                    <th>Started</th>
                    <th>Status</th>
                    <th>Progress</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {sync.data.jobs.map((j) => (
                    <tr key={j.id}>
                      <td>{j.kind}</td>
                      <td>{new Date(j.created_at + "Z").toLocaleString()}</td>
                      <td>
                        <span
                          className={`badge ${j.status === "failed" ? "amber" : "neutral"}`}
                        >
                          {j.status}
                        </span>
                      </td>
                      <td>{j.error ?? j.progress ?? "Waiting to start"}</td>
                      <td>
                        {j.status === "failed" && (
                          <Button
                            variant="secondary"
                            onClick={() =>
                              void run(
                                () => post("/jobs/" + j.id + "/retry", {}),
                                "Job queued",
                              )
                            }
                          >
                            Retry
                          </Button>
                        )}
                        {j.kind === "export" && j.status === "complete" && (
                          <a className="text-link" href={"/api/files/" + j.id}>
                            Download
                          </a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="panel-body">
              <p>
                No background jobs yet. Your next import or sync will appear
                here.
              </p>
            </div>
          )}
        </Panel>
      </div>
      {tokenDialog && (
        <TokenDialog
          onClose={() => setTokenDialog(false)}
          onCreated={(token) => {
            setSecret(token);
            setTokenDialog(false);
            refresh();
          }}
        />
      )}
      {secret && (
        <Modal title="Your access token" onClose={() => setSecret(null)}>
          <p>
            Copy it now. You can revoke this token in Settings, but it will not
            be shown again.
          </p>
          <div className="code-block">{secret}</div>
          <Button
            onClick={async () => {
              await navigator.clipboard.writeText(secret);
              notify("Token copied");
            }}
          >
            <Copy size={15} />
            Copy token
          </Button>
          <p className="inline-note">
            Client header: Authorization: Bearer YOUR_TOKEN
          </p>
        </Modal>
      )}
    </>
  );
}
function LandmarkIcon() {
  return <Link2 size={19} className="muted" />;
}
function TokenDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (s: string) => void;
}) {
  const [name, setName] = useState("Personal assistant"),
    [permissions, setPermissions] = useState<Scope[]>(["finance:read"]),
    [days, setDays] = useState(30),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  return (
    <Modal title="Create access token" onClose={onClose}>
      <form
        className="form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const result = await post<{ token: string }>("/tokens", {
              name,
              scopes: permissions,
              days,
            });
            onCreated(result.token);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Connection name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </Field>
        <Field label="Expires in days">
          <input
            type="number"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            min="1"
            max="365"
            required
          />
        </Field>
        {scopes.map((s) => (
          <label className="checkbox-label" key={s}>
            <input
              type="checkbox"
              checked={permissions.includes(s)}
              onChange={(e) =>
                setPermissions(
                  e.target.checked
                    ? [...permissions, s]
                    : permissions.filter((p) => p !== s),
                )
              }
            />
            {s}
          </label>
        ))}
        <ErrorNotice error={error} />
        <div className="form-footer">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button busy={busy} disabled={!permissions.length}>
            Create token
          </Button>
        </div>
      </form>
    </Modal>
  );
}
