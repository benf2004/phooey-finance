import { useState } from "react";
import {
  Plus,
  Landmark,
  Wallet,
  ArrowUpRight,
  Pencil,
  Link2,
} from "lucide-react";
import { useWorkspace } from "../context";
import { api, post, useSubmit } from "../api";
import {
  PageHeading,
  Panel,
  Button,
  Field,
  MoneyInput,
  Modal,
  ErrorNotice,
  Empty,
  useAsync,
} from "../ui";
import { formatMoney } from "../../shared/money";
import type { Account } from "../../shared/models";
export default function Accounts() {
  const { accounts, navigate, refresh, notify } = useWorkspace();
  const [edit, setEdit] = useState<Account | null | undefined>(undefined),
    [history, setHistory] = useState<Account | null>(null);
  return (
    <>
      <PageHeading
        title="Accounts"
        actions={
          <>
            <Button variant="secondary" onClick={() => navigate("/settings")}>
              <Link2 size={16} />
              Connect a bank
            </Button>
            <Button onClick={() => setEdit(null)}>
              <Plus size={16} />
              Add account
            </Button>
          </>
        }
      />
      {accounts.length ? (
        <div className="account-grid">
          {accounts.map((a) => (
            <section className="panel account-card" key={a.id}>
              <div className="account-icon">
                <Landmark size={25} strokeWidth={1.4} className="positive" />
                <span
                  className={`badge ${a.source === "manual" ? "neutral" : ""}`}
                >
                  {a.source === "manual" ? "Manual account" : "SimpleFIN"}
                </span>
              </div>
              <h3>{a.name}</h3>
              <small>
                {a.institution || "Personal account"} · {a.kind}
              </small>
              <div className="stat-value">
                {formatMoney(a.balance, a.currency)}
              </div>
              <small>
                {a.balance_at
                  ? "Updated " + new Date(a.balance_at).toLocaleDateString()
                  : "Set your current balance"}
              </small>
              <div className="account-bottom">
                <button
                  className="text-link"
                  onClick={() => navigate("/transactions?account=" + a.id)}
                >
                  View transactions <ArrowUpRight size={15} />
                </button>
                <div className="actions">
                  <button
                    className="icon-button"
                    aria-label={"Edit " + a.name}
                    onClick={() => setEdit(a)}
                  >
                    <Pencil size={15} />
                  </button>
                  {a.source === "simplefin" && (
                    <Button variant="ghost" onClick={() => setHistory(a)}>
                      History
                    </Button>
                  )}
                </div>
              </div>
            </section>
          ))}
        </div>
      ) : (
        <Panel title="Accounts">
          <Empty
            title="No accounts"
            detail="Connect SimpleFIN or add a manual account."
            action={
              <Button onClick={() => setEdit(null)}>
                <Plus size={16} />
                Add your first account
              </Button>
            }
          />
        </Panel>
      )}
      <div className="notice" style={{ marginTop: 24 }}>
        Manual account balances are snapshots you set yourself. Bank balances
        reflect the provider’s latest update. Each currency is kept separate.
      </div>
      {edit !== undefined && (
        <AccountEditor
          account={edit}
          onClose={() => setEdit(undefined)}
          onSaved={() => {
            refresh();
            notify("Account saved");
            setEdit(undefined);
          }}
        />
      )}
      {history && (
        <AccountHistory account={history} onClose={() => setHistory(null)} />
      )}
    </>
  );
}
function AccountEditor({
  account,
  onClose,
  onSaved,
}: {
  account: Account | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const submit = useSubmit();
  const [data, setData] = useState({
      name: account?.name ?? "",
      institution: account?.institution ?? "",
      kind: account?.kind ?? "checking",
      currency: account?.currency ?? "USD",
      balance: account?.balance ?? 0,
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  return (
    <Modal title={account ? "Edit account" : "Add account"} onClose={onClose}>
      <form
        className="form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await submit(
              account ? "/accounts/" + account.id : "/accounts",
              data,
              account ? "PUT" : "POST",
            );
            onSaved();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Account name">
          <input
            autoFocus
            required
            value={data.name}
            onChange={(e) => setData({ ...data, name: e.target.value })}
            placeholder="Everyday checking"
          />
        </Field>
        <Field label="Institution">
          <input
            value={data.institution}
            onChange={(e) => setData({ ...data, institution: e.target.value })}
            placeholder="Bank or institution name"
          />
        </Field>
        <div className="field-row">
          <Field label="Account type">
            <select
              value={data.kind}
              onChange={(e) =>
                setData({ ...data, kind: e.target.value as typeof data.kind })
              }
            >
              {[
                "checking",
                "savings",
                "cash",
                "credit",
                "investment",
                "loan",
                "other",
              ].map((v) => (
                <option key={v} value={v}>
                  {v[0].toUpperCase() + v.slice(1)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Currency">
            <input
              required
              pattern="[A-Z]{3}"
              maxLength={3}
              disabled={!!account}
              value={data.currency}
              onChange={(e) =>
                setData({ ...data, currency: e.target.value.toUpperCase() })
              }
            />
          </Field>
        </div>
        <Field
          label="Current balance"
          hint="Use a negative balance for money you owe."
        >
          <MoneyInput
            required
            disabled={account?.source === "simplefin"}
            value={data.balance}
            onChange={(v) => setData({ ...data, balance: v })}
          />
        </Field>
        <ErrorNotice error={error} />
        <div className="form-footer">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            Save account
          </Button>
        </div>
      </form>
    </Modal>
  );
}
function AccountHistory({
  account,
  onClose,
}: {
  account: Account;
  onClose: () => void;
}) {
  const { data, error } = useAsync(
    () =>
      api<{ balance: number; captured_at: string }[]>(
        "/accounts/" + account.id + "/history",
      ),
    [account.id],
  );
  return (
    <Modal title={account.name + " history"} onClose={onClose}>
      <ErrorNotice error={error} />
      <table>
        <thead>
          <tr>
            <th>Captured</th>
            <th>Balance</th>
          </tr>
        </thead>
        <tbody>
          {data?.map((h) => (
            <tr key={h.captured_at}>
              <td>{new Date(h.captured_at).toLocaleString()}</td>
              <td className="money">
                {formatMoney(h.balance, account.currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
