import {
  accountSchema,
  categorySchema,
  transactionSchema,
  ruleSchema,
  filterSchema,
  type Account,
  type Category,
  type Rule,
  type Transaction,
  type TransactionInput,
  type Filters,
} from "../shared/models";
import { assert, id, hash, AppError } from "./util";
export function ruleMatches(
  rule: Rule,
  tx: {
    description: string;
    merchant: string;
    account_id: string;
    amount: number;
  },
) {
  return (
    !!rule.enabled &&
    (!rule.account_id || rule.account_id === tx.account_id) &&
    (rule.direction === "any" ||
      (rule.direction === "in" ? tx.amount > 0 : tx.amount < 0)) &&
    (rule.min_amount === null || tx.amount >= rule.min_amount) &&
    (rule.max_amount === null || tx.amount <= rule.max_amount) &&
    tx[rule.match_field]
      .toLocaleLowerCase()
      .includes(rule.pattern.toLocaleLowerCase())
  );
}
export class Ledger {
  constructor(
    public db: D1Database,
    public actor = "admin",
  ) {}
  async accounts(includeHidden = false) {
    return (
      await this.db
        .prepare(
          `SELECT * FROM accounts ${includeHidden ? "" : "WHERE archived=0"} ORDER BY archived,name`,
        )
        .all<Account>()
    ).results;
  }
  async categories() {
    return (
      await this.db
        .prepare("SELECT * FROM categories ORDER BY type,name")
        .all<Category>()
    ).results;
  }
  async rules() {
    return (
      await this.db
        .prepare("SELECT * FROM rules ORDER BY priority,created_at,id")
        .all<Rule>()
    ).results;
  }
  auditStatement(
    action: string,
    entity: string,
    before: unknown,
    after: unknown,
  ) {
    return this.db
      .prepare(
        "INSERT INTO audit(id,actor,action,entity_id,before_json,after_json) VALUES(?,?,?,?,?,?)",
      )
      .bind(
        id(),
        this.actor,
        action,
        entity,
        before == null
          ? null
          : JSON.stringify(before, (key, value) =>
              key === "history" ? undefined : value,
            ),
        after == null
          ? null
          : JSON.stringify(after, (key, value) =>
              key === "history" ? undefined : value,
            ),
      );
  }
  async prepareRequest<T>(operation: string, input: unknown, key?: string) {
    if (!key)
      return {
        prior: undefined as T | undefined,
        statements: (_response: T): D1PreparedStatement[] => [],
      };
    assert(
      key.length >= 8 && key.length <= 200,
      400,
      "Use a request key between 8 and 200 characters",
    );
    const scoped = `${this.actor}:${operation}:${key}`;
    const fingerprint = await hash(JSON.stringify(input));
    const existing = await this.db
      .prepare("SELECT fingerprint,response FROM idempotency WHERE key=?")
      .bind(scoped)
      .first<{ fingerprint: string; response: string }>();
    if (existing)
      assert(
        existing.fingerprint === fingerprint,
        409,
        "Request key already used for different data",
      );
    return {
      prior: existing ? (JSON.parse(existing.response) as T) : undefined,
      statements: (response: T) => [
        this.db
          .prepare(
            "INSERT INTO idempotency(key,fingerprint,response) VALUES(?,?,?)",
          )
          .bind(scoped, fingerprint, JSON.stringify(response)),
      ],
    };
  }
  async saveAccount(input: unknown, accountId?: string, requestKey?: string) {
    const data = accountSchema.parse(input);
    const request = await this.prepareRequest<{ id: string } & typeof data>(
      "account.save",
      { data, id: accountId ?? null },
      requestKey,
    );
    if (request.prior) return request.prior;
    const account = accountId
      ? await this.db
          .prepare("SELECT * FROM accounts WHERE id=?")
          .bind(accountId)
          .first<Account>()
      : null;
    assert(!accountId || account, 404, "Account not found");
    if (account) {
      data.currency = account.currency;
      if (account.source !== "manual") data.balance = account.balance;
    }
    const key = accountId ?? id();
    await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO accounts(id,name,institution,kind,currency,balance,balance_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,institution=excluded.institution,kind=excluded.kind,balance=CASE WHEN accounts.source='manual' THEN excluded.balance ELSE accounts.balance END,balance_at=CASE WHEN accounts.source='manual' THEN excluded.balance_at ELSE accounts.balance_at END",
        )
        .bind(
          key,
          data.name,
          data.institution,
          data.kind,
          data.currency,
          data.balance,
          account?.source === "simplefin"
            ? account.balance_at
            : new Date().toISOString(),
        ),
      this.auditStatement("account.save", key, account, data),
      ...request.statements({ id: key, ...data }),
    ]);
    return { id: key, ...data };
  }
  async saveCategory(input: unknown, categoryId?: string, requestKey?: string) {
    const data = categorySchema.parse(input);
    const request = await this.prepareRequest<{ id: string } & typeof data>(
      "category.save",
      { data, id: categoryId ?? null },
      requestKey,
    );
    if (request.prior) return request.prior;
    const key = categoryId ?? id();
    if (categoryId)
      assert(
        await this.db
          .prepare("SELECT id FROM categories WHERE id=?")
          .bind(key)
          .first(),
        404,
        "Category not found",
      );
    await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO categories(id,name,type,tax_treatment,color) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,type=excluded.type,tax_treatment=excluded.tax_treatment,color=excluded.color",
        )
        .bind(key, data.name, data.type, data.tax_treatment, data.color),
      this.auditStatement("category.save", key, null, data),
      ...request.statements({ id: key, ...data }),
    ]);
    return { id: key, ...data };
  }
  where(input: unknown, alias = "t") {
    const f = filterSchema.parse(input);
    const clauses = [
      `${alias}.deleted=0`,
      `${alias}.account_id IN (SELECT id FROM accounts WHERE archived=0)`,
    ];
    const args: (string | number)[] = [];
    const add = (sql: string, value: string | number) => {
      clauses.push(sql);
      args.push(value);
    };
    if (f.q.trim()) {
      const query = f.q
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => '"' + w.replace(/"/g, '""') + '"*')
        .join(" AND ");
      add(
        `${alias}.rowid IN (SELECT rowid FROM transaction_search WHERE transaction_search MATCH ?)`,
        query,
      );
    }
    if (f.currency)
      add(
        `${alias}.account_id IN (SELECT id FROM accounts WHERE currency=?)`,
        f.currency,
      );
    if (f.from) add(`${alias}.posted>=?`, f.from);
    if (f.to) add(`${alias}.posted<=?`, f.to);
    if (f.account) add(`${alias}.account_id=?`, f.account);
    if (f.category === "uncategorized")
      clauses.push(
        `(${alias}.category_id IS NULL AND NOT EXISTS(SELECT 1 FROM splits WHERE transaction_id=${alias}.id) OR EXISTS(SELECT 1 FROM splits WHERE transaction_id=${alias}.id AND category_id IS NULL))`,
      );
    else if (f.category) {
      clauses.push(
        `((${alias}.category_id=? AND NOT EXISTS(SELECT 1 FROM splits WHERE transaction_id=${alias}.id)) OR EXISTS(SELECT 1 FROM splits WHERE transaction_id=${alias}.id AND category_id=?))`,
      );
      args.push(f.category, f.category);
    }
    if (f.type) {
      clauses.push(
        `((${alias}.type=? AND NOT EXISTS(SELECT 1 FROM splits WHERE transaction_id=${alias}.id)) OR EXISTS(SELECT 1 FROM splits WHERE transaction_id=${alias}.id AND type=?))`,
      );
      args.push(f.type, f.type);
    }
    if (f.reviewed) add(`${alias}.reviewed=?`, Number(f.reviewed));
    if (f.pending) add(`${alias}.pending=?`, Number(f.pending));
    if (f.source) add(`${alias}.source=?`, f.source);
    if (f.min !== undefined) add(`${alias}.amount>=?`, f.min);
    if (f.max !== undefined) add(`${alias}.amount<=?`, f.max);
    return { f, sql: clauses.join(" AND "), args };
  }
  async transactions(input: unknown = {}) {
    const { f, sql, args } = this.where(input);
    const count = await this.db
      .prepare(`SELECT COUNT(*) total FROM transactions t WHERE ${sql}`)
      .bind(...args)
      .first<{ total: number }>();
    const items = await this.db
      .prepare(
        `SELECT t.*,a.name account_name,a.currency,c.name category_name,r.name rule_name,(SELECT COUNT(*) FROM splits s WHERE s.transaction_id=t.id) split_count FROM transactions t JOIN accounts a ON a.id=t.account_id LEFT JOIN categories c ON c.id=t.category_id LEFT JOIN rules r ON r.id=t.rule_id WHERE ${sql} ORDER BY t.posted DESC,t.id DESC LIMIT ? OFFSET ?`,
      )
      .bind(...args, f.limit, (f.page - 1) * f.limit)
      .all<Transaction>();
    return {
      items: items.results,
      total: count?.total ?? 0,
      page: f.page,
      limit: f.limit,
    };
  }
  async transaction(key: string) {
    const tx = await this.db
      .prepare(
        "SELECT t.*,a.name account_name,a.currency,c.name category_name FROM transactions t JOIN accounts a ON a.id=t.account_id LEFT JOIN categories c ON c.id=t.category_id WHERE t.id=? AND t.deleted=0 AND a.archived=0",
      )
      .bind(key)
      .first<Transaction>();
    assert(tx, 404, "Transaction not found");
    const splits = (
      await this.db
        .prepare(
          "SELECT amount,category_id,type,notes FROM splits WHERE transaction_id=?",
        )
        .bind(key)
        .all()
    ).results;
    const history = (
      await this.db
        .prepare(
          "SELECT actor,action,created_at,before_json,after_json FROM audit WHERE entity_id=? ORDER BY created_at DESC LIMIT 30",
        )
        .bind(key)
        .all()
    ).results;
    return { ...tx, splits, history };
  }
  async saveTransaction(
    input: unknown,
    options: {
      id?: string;
      revision?: number;
      requestKey?: string;
      source?: string;
      importId?: string;
      auto?: boolean;
    } = {},
  ) {
    const data = transactionSchema.parse(input);
    assert(
      await this.db
        .prepare("SELECT id FROM accounts WHERE id=? AND archived=0")
        .bind(data.account_id)
        .first(),
      400,
      "Choose an active account",
    );
    const categories = await this.categories();
    for (const c of [
      data.category_id,
      ...data.splits.map((s) => s.category_id),
    ])
      assert(
        c === null || categories.some((x) => x.id === c),
        400,
        "Category does not exist",
      );
    const requestKey = options.requestKey
      ? `${this.actor}:${options.requestKey}`
      : null;
    const fingerprint = await hash(
      JSON.stringify({
        data,
        id: options.id ?? null,
        revision: options.revision ?? null,
      }),
    );
    if (requestKey) {
      const prior = await this.db
        .prepare("SELECT fingerprint,response FROM idempotency WHERE key=?")
        .bind(requestKey)
        .first<{ fingerprint: string; response: string }>();
      if (prior) {
        assert(
          prior.fingerprint === fingerprint,
          409,
          "Request key already used for different data",
        );
        return JSON.parse(prior.response) as { id: string; revision: number };
      }
    }
    const existing = options.id ? await this.transaction(options.id) : null;
    assert(
      !existing || existing.revision === options.revision,
      409,
      "This transaction changed. Refresh before saving.",
    );
    if (existing?.source === "simplefin")
      assert(
        existing.account_id === data.account_id,
        400,
        "Bank transactions must stay in their provider account",
      );
    if (existing?.transfer_id)
      assert(
        data.amount === existing.amount &&
          data.account_id === existing.account_id &&
          data.type === "transfer" &&
          data.splits.length === 0,
        409,
        "Unlink the transfer before changing its amount, account, type, or splits.",
      );
    let rule: Rule | undefined;
    if (options.auto && !data.category_id)
      rule = (await this.rules()).find((r) => ruleMatches(r, data));
    if (rule) {
      data.category_id = rule.category_id;
      data.type = categories.find((c) => c.id === rule.category_id)!.type;
    }
    const key = options.id ?? id(),
      revision = (existing?.revision ?? 0) + 1;
    const statements: D1PreparedStatement[] = [];
    const guard = id();
    if (existing)
      statements.push(
        this.db
          .prepare(
            "INSERT INTO write_guards(id,valid) VALUES(?,COALESCE((SELECT revision=? AND deleted=0 FROM transactions WHERE id=?),0))",
          )
          .bind(guard, options.revision, key),
      );
    statements.push(
      this.db
        .prepare(
          "INSERT INTO transactions(id,account_id,posted,amount,description,merchant,category_id,type,notes,pending,reviewed,source,user_edited,rule_id,import_id,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id,posted=excluded.posted,amount=excluded.amount,description=excluded.description,merchant=excluded.merchant,category_id=excluded.category_id,type=excluded.type,notes=excluded.notes,pending=excluded.pending,reviewed=excluded.reviewed,user_edited=1,rule_id=NULL,revision=excluded.revision",
        )
        .bind(
          key,
          data.account_id,
          data.posted,
          data.amount,
          data.description,
          data.merchant,
          data.category_id,
          data.type,
          data.notes,
          +data.pending,
          +data.reviewed,
          options.source ?? "manual",
          options.auto ? 0 : 1,
          rule?.id ?? null,
          options.importId ?? null,
          revision,
        ),
    );
    statements.push(
      this.db.prepare("DELETE FROM splits WHERE transaction_id=?").bind(key),
    );
    for (const s of data.splits)
      statements.push(
        this.db
          .prepare(
            "INSERT INTO splits(id,transaction_id,amount,category_id,type,notes) VALUES(?,?,?,?,?,?)",
          )
          .bind(id(), key, s.amount, s.category_id, s.type, s.notes),
      );
    statements.push(
      this.auditStatement(
        existing ? "transaction.update" : "transaction.create",
        key,
        existing,
        data,
      ),
    );
    if (existing)
      statements.push(
        this.db.prepare("DELETE FROM write_guards WHERE id=?").bind(guard),
      );
    const result = { id: key, revision };
    if (requestKey)
      statements.push(
        this.db
          .prepare(
            "INSERT INTO idempotency(key,fingerprint,response) VALUES(?,?,?)",
          )
          .bind(requestKey, fingerprint, JSON.stringify(result)),
      );
    try {
      await this.db.batch(statements);
    } catch (e) {
      if (requestKey) {
        const prior = await this.db
          .prepare("SELECT fingerprint,response FROM idempotency WHERE key=?")
          .bind(requestKey)
          .first<{ fingerprint: string; response: string }>();
        if (prior) {
          assert(
            prior.fingerprint === fingerprint,
            409,
            "Request key already used",
          );
          return JSON.parse(prior.response) as typeof result;
        }
      }
      if (String(e).includes("CHECK constraint"))
        throw new AppError(
          409,
          "This transaction changed. Refresh before saving.",
        );
      throw e;
    }
    return result;
  }
  async deleteTransaction(key: string, revision: number) {
    const before = await this.transaction(key);
    assert(!before.transfer_id, 409, "Unlink the transfer before deleting it");
    const guard = id();
    await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO write_guards VALUES(?,COALESCE((SELECT revision=? AND deleted=0 FROM transactions WHERE id=?),0))",
        )
        .bind(guard, revision, key),
      this.db
        .prepare(
          "UPDATE transactions SET deleted=1,revision=revision+1 WHERE id=?",
        )
        .bind(key),
      this.auditStatement("transaction.delete", key, before, null),
      this.db.prepare("DELETE FROM write_guards WHERE id=?").bind(guard),
    ]);
    return { deleted: true };
  }
  async linkTransfer(a: string, b: string) {
    assert(a !== b, 400, "Select two different transactions");
    const [left, right] = await Promise.all([
      this.transaction(a),
      this.transaction(b),
    ]);
    assert(
      left.account_id !== right.account_id &&
        left.currency === right.currency &&
        left.amount === -right.amount &&
        left.amount !== 0,
      400,
      "Transfers need equal opposite amounts in different accounts with the same currency",
    );
    assert(
      !left.splits.length &&
        !right.splits.length &&
        !left.transfer_id &&
        !right.transfer_id,
      400,
      "Transactions must be unsplit and unlinked",
    );
    const transfer = id();
    const guard = id();
    await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO write_guards VALUES(?,(SELECT COUNT(*)=2 FROM transactions WHERE id IN (?,?) AND transfer_id IS NULL AND deleted=0 AND ((id=? AND revision=?) OR (id=? AND revision=?))))",
        )
        .bind(guard, a, b, a, left.revision, b, right.revision),
      this.db
        .prepare(
          "UPDATE transactions SET transfer_id=?,type='transfer',category_id=NULL,user_edited=1,reviewed=1,revision=revision+1 WHERE id IN (?,?)",
        )
        .bind(transfer, a, b),
      this.auditStatement("transfer.link", a, left, {
        transfer_id: transfer,
        other: b,
      }),
      this.auditStatement("transfer.link", b, right, {
        transfer_id: transfer,
        other: a,
      }),
      this.db.prepare("DELETE FROM write_guards WHERE id=?").bind(guard),
    ]);
    return { transfer_id: transfer };
  }
  async unlinkTransfer(key: string) {
    const tx = await this.transaction(key);
    assert(tx.transfer_id, 400, "Transaction is not linked");
    await this.db.batch([
      this.db
        .prepare(
          "UPDATE transactions SET transfer_id=NULL,revision=revision+1 WHERE transfer_id=?",
        )
        .bind(tx.transfer_id),
      this.auditStatement("transfer.unlink", key, tx, null),
    ]);
    return { unlinked: true };
  }
  async saveRule(input: unknown, key?: string, requestKey?: string) {
    const data = ruleSchema.parse(input);
    const request = await this.prepareRequest<{ id: string } & typeof data>(
      "rule.save",
      { data, id: key ?? null },
      requestKey,
    );
    if (request.prior) return request.prior;
    assert(
      await this.db
        .prepare("SELECT id FROM categories WHERE id=?")
        .bind(data.category_id)
        .first(),
      400,
      "Category not found",
    );
    const ruleId = key ?? id();
    if (key)
      assert(
        await this.db
          .prepare("SELECT id FROM rules WHERE id=?")
          .bind(key)
          .first(),
        404,
        "Rule not found",
      );
    await this.db.batch([
      this.db
        .prepare(
          "INSERT INTO rules(id,name,priority,enabled,pattern,match_field,account_id,min_amount,max_amount,direction,category_id) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,priority=excluded.priority,enabled=excluded.enabled,pattern=excluded.pattern,match_field=excluded.match_field,account_id=excluded.account_id,min_amount=excluded.min_amount,max_amount=excluded.max_amount,direction=excluded.direction,category_id=excluded.category_id",
        )
        .bind(
          ruleId,
          data.name,
          data.priority,
          +data.enabled,
          data.pattern,
          data.match_field,
          data.account_id,
          data.min_amount,
          data.max_amount,
          data.direction,
          data.category_id,
        ),
      this.auditStatement("rule.save", ruleId, null, data),
      ...request.statements({ id: ruleId, ...data }),
    ]);
    return { id: ruleId, ...data };
  }
  async previewRule(input: unknown) {
    const data = ruleSchema.parse(input);
    const rows = (
      await this.db
        .prepare(
          "SELECT t.id,t.description,t.merchant,t.account_id,t.amount,t.revision,a.currency FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE t.deleted=0 AND t.user_edited=0 AND NOT EXISTS(SELECT 1 FROM splits s WHERE s.transaction_id=t.id) ORDER BY t.posted DESC LIMIT 5000",
        )
        .all<{
          id: string;
          description: string;
          merchant: string;
          account_id: string;
          amount: number;
          revision: number;
          currency: string;
        }>()
    ).results;
    const matches = rows.filter((t) =>
      ruleMatches({ ...data, id: "preview", enabled: +data.enabled }, t),
    );
    return {
      matches,
      total: matches.length,
      scanned: rows.length,
      limited: rows.length === 5000,
    };
  }
  async applyRule(key: string, items: { id: string; revision: number }[]) {
    const rule = (await this.rules()).find((r) => r.id === key);
    assert(rule, 404, "Rule not found");
    assert(items.length <= 500, 400, "Apply up to 500 transactions at once");
    const category = (await this.categories()).find(
      (c) => c.id === rule.category_id,
    )!;
    const rows = (
      await this.db
        .prepare(
          "SELECT t.* FROM transactions t JOIN json_each(?) j ON t.id=json_extract(j.value,'$.id') AND t.revision=json_extract(j.value,'$.revision') WHERE t.deleted=0 AND t.user_edited=0 AND NOT EXISTS(SELECT 1 FROM splits s WHERE s.transaction_id=t.id)",
        )
        .bind(JSON.stringify(items))
        .all<Transaction>()
    ).results;
    const matched = rows.filter((tx) => ruleMatches(rule, tx));
    if (!matched.length) return { updated: 0 };
    const guard = id();
    const statements: D1PreparedStatement[] = [
      this.db
        .prepare(
          "INSERT INTO write_guards VALUES(?,(SELECT COUNT(*) FROM transactions t JOIN json_each(?) j ON t.id=json_extract(j.value,'$.id') AND t.revision=json_extract(j.value,'$.revision') WHERE t.deleted=0 AND t.user_edited=0)=?)",
        )
        .bind(
          guard,
          JSON.stringify(
            matched.map((t) => ({ id: t.id, revision: t.revision })),
          ),
          matched.length,
        ),
    ];
    for (const tx of matched) {
      statements.push(
        this.db
          .prepare(
            "UPDATE transactions SET category_id=?,type=?,rule_id=?,revision=revision+1 WHERE id=?",
          )
          .bind(rule.category_id, category.type, rule.id, tx.id),
        this.auditStatement("rule.apply", tx.id, tx, {
          rule_id: key,
          category_id: rule.category_id,
        }),
      );
    }
    statements.push(
      this.db.prepare("DELETE FROM write_guards WHERE id=?").bind(guard),
    );
    await this.db.batch(statements);
    return { updated: matched.length };
  }

  async report(from: string, to: string) {
    const rows = (
      await this.db
        .prepare(
          `SELECT SUM(e.amount) amount,e.type,e.currency,substr(e.posted,1,7) posted,e.category_id,c.name category_name,c.tax_treatment FROM ledger_entries e LEFT JOIN categories c ON c.id=e.category_id WHERE e.deleted=0 AND e.pending=0 AND e.account_id IN (SELECT id FROM accounts WHERE archived=0) AND e.posted>=? AND e.posted<=? GROUP BY e.currency,substr(e.posted,1,7),e.type,e.category_id ORDER BY posted`,
        )
        .bind(from, to)
        .all<{
          amount: number;
          type: string;
          currency: string;
          posted: string;
          category_id: string | null;
          category_name: string | null;
          tax_treatment: string;
        }>()
    ).results;
    const currencies = [...new Set(rows.map((r) => r.currency))];
    const groups: Record<
      string,
      {
        income: number;
        expenses: number;
        net: number;
        businessIncome: number;
        businessExpenses: number;
        months: Record<string, { income: number; expenses: number }>;
        categories: Record<string, { name: string; amount: number }>;
      }
    > = {};
    for (const r of rows) {
      const g = (groups[r.currency] ??= {
        income: 0,
        expenses: 0,
        net: 0,
        businessIncome: 0,
        businessExpenses: 0,
        months: {},
        categories: {},
      });
      const month = (g.months[r.posted.slice(0, 7)] ??= {
        income: 0,
        expenses: 0,
      });
      if (r.type === "income") {
        g.income += r.amount;
        month.income += r.amount;
      }
      if (r.type === "expense") {
        g.expenses -= r.amount;
        month.expenses -= r.amount;
        const cat = (g.categories[r.category_id ?? "uncategorized"] ??= {
          name: r.category_name ?? "Uncategorized",
          amount: 0,
        });
        cat.amount -= r.amount;
      }
      if (r.type !== "transfer") {
        g.net += r.amount;
        if (r.tax_treatment === "business_income") g.businessIncome += r.amount;
        if (r.tax_treatment === "business_expense")
          g.businessExpenses -= r.amount;
      }
    }
    const review = await this.db
      .prepare(
        "SELECT COUNT(*) count FROM transactions WHERE deleted=0 AND reviewed=0",
      )
      .first<{ count: number }>();
    return { from, to, currencies, groups, reviewCount: review?.count ?? 0 };
  }
  async bulkCategory(
    items: { id: string; revision: number }[],
    categoryId: string | null,
  ) {
    assert(
      items.length > 0 && items.length <= 100,
      400,
      "Select 1–100 transactions",
    );
    const category = categoryId
      ? (await this.categories()).find((c) => c.id === categoryId)
      : null;
    assert(!categoryId || category, 400, "Category not found");
    const statements: D1PreparedStatement[] = [];
    for (const item of items) {
      const tx = await this.transaction(item.id);
      assert(
        !tx.splits.length && !tx.transfer_id,
        400,
        "Edit split or linked transactions individually",
      );
      const guard = id();
      statements.push(
        this.db
          .prepare(
            "INSERT INTO write_guards VALUES(?,COALESCE((SELECT revision=? AND deleted=0 FROM transactions WHERE id=?),0))",
          )
          .bind(guard, item.revision, item.id),
        this.db
          .prepare(
            "UPDATE transactions SET category_id=?,type=?,reviewed=1,user_edited=1,rule_id=NULL,revision=revision+1 WHERE id=?",
          )
          .bind(categoryId, category?.type ?? tx.type, item.id),
        this.auditStatement("transaction.categorize", item.id, tx, {
          category_id: categoryId,
        }),
        this.db.prepare("DELETE FROM write_guards WHERE id=?").bind(guard),
      );
    }
    await this.db.batch(statements);
    return { updated: items.length };
  }
}
