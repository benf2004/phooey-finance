import { useState } from "react";
import { Plus, Pencil, ArrowRight, Workflow } from "lucide-react";
import { useWorkspace } from "../context";
import { api, post, useSubmit } from "../api";
import {
  PageHeading,
  Panel,
  Button,
  Field,
  Modal,
  ErrorNotice,
  Empty,
  MoneyInput,
  useAsync,
} from "../ui";
import type { Category, Rule } from "../../shared/models";
import { formatMoney } from "../../shared/money";
export default function Categories() {
  const { categories, accounts, version, refresh, notify } = useWorkspace();
  const [tab, setTab] = useState("categories"),
    [edit, setEdit] = useState<Category | null | undefined>(),
    [rule, setRule] = useState<Rule | null | undefined>(),
    [error, setError] = useState<string | null>(null);
  const rules = useAsync(() => api<Rule[]>("/rules"), [version]);
  return (
    <>
      <PageHeading
        title="Categories & rules"
        actions={
          <Button
            onClick={() =>
              tab === "categories" ? setEdit(null) : setRule(null)
            }
          >
            <Plus size={16} />
            New {tab === "categories" ? "category" : "rule"}
          </Button>
        }
      />
      <div className="tabs">
        <button
          className={tab === "categories" ? "active" : ""}
          onClick={() => setTab("categories")}
        >
          Categories <span className="badge-count">{categories.length}</span>
        </button>
        <button
          className={tab === "rules" ? "active" : ""}
          onClick={() => setTab("rules")}
        >
          Categorization rules{" "}
          <span className="badge-count">{rules.data?.length ?? 0}</span>
        </button>
      </div>
      <ErrorNotice error={error ?? rules.error} />
      {tab === "categories" ? (
        <div className="panel table-scroll">
          <table>
            <thead>
              <tr>
                <th>Category</th>
                <th>Type</th>
                <th>Tax treatment</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {!categories.length && (
                <tr>
                  <td colSpan={4} className="muted">
                    No categories. Add one to get started.
                  </td>
                </tr>
              )}
              {categories.map((c) => (
                <tr key={c.id}>
                  <td>
                    <span
                      className="dot"
                      style={{ background: c.color, marginRight: 10 }}
                    />
                    {c.name}
                  </td>
                  <td>
                    <span className="badge neutral">{c.type}</span>
                  </td>
                  <td>{c.tax_treatment.replaceAll("_", " ")}</td>
                  <td className="align-right">
                    <button
                      className="icon-button"
                      aria-label={"Edit " + c.name}
                      onClick={() => setEdit(c)}
                    >
                      <Pencil size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Panel
          title="Rules"
          caption="First matching rule wins. Manual edits always take priority."
        >
          {rules.data?.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Priority</th>
                    <th>Rule</th>
                    <th>Matches</th>
                    <th>Category</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rules.data.map((r) => (
                    <tr key={r.id}>
                      <td>{r.priority}</td>
                      <td>
                        {r.name}
                        <small>{r.enabled ? "Enabled" : "Disabled"}</small>
                      </td>
                      <td>
                        {r.match_field} contains “{r.pattern}”
                      </td>
                      <td>
                        {categories.find((c) => c.id === r.category_id)?.name}
                      </td>
                      <td>
                        <Button variant="ghost" onClick={() => setRule(r)}>
                          Preview & edit <ArrowRight size={14} />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              title="No rules"
              detail="Add a rule to categorize matching transactions."
              action={
                <Button onClick={() => setRule(null)}>
                  <Workflow size={16} />
                  Create your first rule
                </Button>
              }
            />
          )}
        </Panel>
      )}
      {edit !== undefined && (
        <CategoryEditor
          category={edit}
          onClose={() => setEdit(undefined)}
          onSaved={() => {
            refresh();
            notify("Category saved");
            setEdit(undefined);
          }}
        />
      )}
      {rule !== undefined && (
        <RuleEditor rule={rule} onClose={() => setRule(undefined)} />
      )}
    </>
  );
}
function CategoryEditor({
  category,
  onClose,
  onSaved,
}: {
  category: Category | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const submit = useSubmit();
  const [data, setData] = useState({
      name: category?.name ?? "",
      type: category?.type ?? "expense",
      tax_treatment: category?.tax_treatment ?? "personal",
      color: category?.color ?? "#28634a",
    }),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  return (
    <Modal
      title={category ? "Edit category" : "Add category"}
      onClose={onClose}
    >
      <form
        className="form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await submit(
              category ? "/categories/" + category.id : "/categories",
              data,
              category ? "PUT" : "POST",
            );
            onSaved();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Name">
          <input
            required
            value={data.name}
            onChange={(e) => setData({ ...data, name: e.target.value })}
          />
        </Field>
        <div className="field-row">
          <Field label="Type">
            <select
              value={data.type}
              onChange={(e) =>
                setData({ ...data, type: e.target.value as typeof data.type })
              }
            >
              {["expense", "income", "transfer"].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </Field>
          <Field label="Tax treatment">
            <select
              value={data.tax_treatment}
              onChange={(e) =>
                setData({
                  ...data,
                  tax_treatment: e.target.value as typeof data.tax_treatment,
                })
              }
            >
              {[
                "personal",
                "business_income",
                "business_expense",
                "tax_payment",
                "excluded",
              ].map((v) => (
                <option value={v} key={v}>
                  {v.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Color">
          <input
            type="color"
            value={data.color}
            onChange={(e) => setData({ ...data, color: e.target.value })}
          />
        </Field>
        <ErrorNotice error={error} />
        <div className="form-footer">
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button busy={busy}>Save category</Button>
        </div>
      </form>
    </Modal>
  );
}
function RuleEditor({
  rule,
  onClose,
}: {
  rule: Rule | null;
  onClose: () => void;
}) {
  const submit = useSubmit();
  const { categories, accounts, refresh, notify } = useWorkspace();
  const [data, setData] = useState({
      name: rule?.name ?? "",
      pattern: rule?.pattern ?? "",
      priority: rule?.priority ?? 100,
      enabled: !!(rule?.enabled ?? true),
      match_field: rule?.match_field ?? "description",
      account_id: rule?.account_id ?? null,
      min_amount: rule?.min_amount ?? null,
      max_amount: rule?.max_amount ?? null,
      direction: rule?.direction ?? "any",
      category_id: rule?.category_id ?? categories[0]?.id ?? "",
    }),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState<{
      matches: {
        id: string;
        description: string;
        amount: number;
        revision: number;
        currency: string;
      }[];
      total: number;
      limited: boolean;
    } | null>(null),
    [ruleId, setRuleId] = useState(rule?.id);
  const change = (patch: Partial<typeof data>) => {
    setData({ ...data, ...patch });
    setPreview(null);
  };
  return (
    <Modal title={rule ? "Edit rule" : "Add rule"} onClose={onClose} wide>
      <form
        className="form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const saved = await submit<{ id: string }>(
              ruleId ? "/rules/" + ruleId : "/rules",
              data,
              ruleId ? "PUT" : "POST",
            );
            setRuleId(saved.id);
            refresh();
            notify("Rule saved");
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="field-row">
          <Field label="Rule name">
            <input
              required
              value={data.name}
              onChange={(e) => change({ name: e.target.value })}
            />
          </Field>
          <Field label="Priority (lower runs first)">
            <input
              required
              type="number"
              min="0"
              max="10000"
              value={data.priority}
              onChange={(e) => change({ priority: Number(e.target.value) })}
            />
          </Field>
        </div>
        <div className="field-row">
          <Field label="Match field">
            <select
              value={data.match_field}
              onChange={(e) =>
                change({
                  match_field: e.target.value as typeof data.match_field,
                })
              }
            >
              <option value="description">Description</option>
              <option value="merchant">Merchant</option>
            </select>
          </Field>
          <Field label="Contains (case insensitive)">
            <input
              required
              value={data.pattern}
              onChange={(e) => change({ pattern: e.target.value })}
              placeholder="e.g. Adobe"
            />
          </Field>
        </div>
        <div className="field-row">
          <Field label="Account">
            <select
              value={data.account_id ?? ""}
              onChange={(e) => change({ account_id: e.target.value || null })}
            >
              <option value="">Any account</option>
              {accounts.map((a) => (
                <option value={a.id} key={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Direction">
            <select
              value={data.direction}
              onChange={(e) =>
                change({ direction: e.target.value as typeof data.direction })
              }
            >
              <option value="any">Any direction</option>
              <option value="in">Money in</option>
              <option value="out">Money out</option>
            </select>
          </Field>
        </div>
        <div className="field-row">
          <Field label="Min signed amount (optional)">
            <input
              type="number"
              step="0.01"
              value={data.min_amount === null ? "" : data.min_amount / 100}
              onChange={(e) =>
                change({
                  min_amount: e.target.value
                    ? Math.round(Number(e.target.value) * 100)
                    : null,
                })
              }
            />
          </Field>
          <Field label="Max signed amount (optional)">
            <input
              type="number"
              step="0.01"
              value={data.max_amount === null ? "" : data.max_amount / 100}
              onChange={(e) =>
                change({
                  max_amount: e.target.value
                    ? Math.round(Number(e.target.value) * 100)
                    : null,
                })
              }
            />
          </Field>
        </div>
        <Field label="Assign category">
          <select
            value={data.category_id}
            onChange={(e) => change({ category_id: e.target.value })}
          >
            {categories.map((c) => (
              <option value={c.id} key={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={data.enabled}
            onChange={(e) => change({ enabled: e.target.checked })}
          />
          Rule enabled
        </label>
        <ErrorNotice error={error} />
        <div className="actions">
          <Button
            variant="secondary"
            type="button"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                setPreview(await post("/rules/preview", data));
                setError(null);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Preview matches
          </Button>
          <Button busy={busy} type="submit">
            Save rule
          </Button>
        </div>
        {preview && (
          <div>
            <h3>
              {preview.total} matching transactions{" "}
              {preview.limited ? "(first 5,000 scanned)" : ""}
            </h3>
            <p className="inline-note">
              Manually edited and split transactions are excluded. Preview does
              not change your ledger.
            </p>
            <div className="import-preview">
              <table>
                <tbody>
                  {preview.matches.slice(0, 500).map((t) => (
                    <tr key={t.id}>
                      <td>{t.description}</td>
                      <td className="money">
                        {formatMoney(t.amount, t.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Button
              type="button"
              variant="secondary"
              disabled={!ruleId || !preview.total}
              busy={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const saved = await submit<{ id: string }>(
                    ruleId ? "/rules/" + ruleId : "/rules",
                    data,
                    ruleId ? "PUT" : "POST",
                  );
                  const result = await post<{ updated: number }>(
                    "/rules/" + saved.id + "/apply",
                    {
                      items: preview.matches
                        .slice(0, 500)
                        .map((t) => ({ id: t.id, revision: t.revision })),
                    },
                  );
                  notify(`${result.updated} transactions categorized`);
                  refresh();
                  onClose();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Save and apply to {Math.min(500, preview.total)} matches
            </Button>
          </div>
        )}
      </form>
    </Modal>
  );
}
