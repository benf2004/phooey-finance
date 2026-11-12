import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { type AppEnv, type Principal, requireScope } from "./auth";
import { Ledger } from "./ledger";
import {
  filterSchema,
  transactionSchema,
  categorySchema,
  ruleSchema,
  paymentSchema,
  dateSchema,
  type Scope,
} from "../shared/models";
import { taxSchema } from "../shared/tax";
import { taxState, saveTax, addPayment } from "./taxes";
import { requestSync } from "./sync";
import { queueExport } from "./files";
import { errorMessage } from "./util";
export function handleMcp(
  request: Request,
  env: AppEnv,
  ctx: ExecutionContext,
  principal: Principal,
) {
  const ledger = new Ledger(env.DB, principal.actor);
  const serverFactory = () => {
    const server = new McpServer({ name: "phooey-finance", version: "0.1.0" });
    function tool<S extends z.ZodRawShape>(
      name: string,
      description: string,
      schema: z.ZodObject<S>,
      scope: Scope,
      fn: (args: z.output<z.ZodObject<S>>) => Promise<unknown>,
    ) {
      server.registerTool(
        name,
        {
          description,
          inputSchema: schema,
          annotations: {
            readOnlyHint: scope === "finance:read",
            destructiveHint: scope !== "finance:read",
            openWorldHint: scope === "sync:write",
          },
        },
        async (args) => {
          try {
            requireScope(principal, scope);
            const value = await fn(args as z.output<z.ZodObject<S>>);
            return {
              content: [{ type: "text" as const, text: JSON.stringify(value) }],
            };
          } catch (e) {
            return {
              isError: true,
              content: [{ type: "text" as const, text: errorMessage(e) }],
            };
          }
        },
      );
    }
    tool(
      "list_accounts",
      "List accounts with currency, balances and freshness timestamps.",
      z.object({}),
      "finance:read",
      () => ledger.accounts(),
    );
    tool(
      "search_transactions",
      "Search the ledger with combined filters. Amount filters are integer minor units. Results are paginated.",
      filterSchema,
      "finance:read",
      (a) => ledger.transactions(a),
    );
    tool(
      "get_transaction",
      "Inspect a transaction, its splits and edit history.",
      z.object({ id: z.string() }),
      "finance:read",
      (a) => ledger.transaction(a.id),
    );
    tool(
      "list_categories",
      "List category types and tax treatment.",
      z.object({}),
      "finance:read",
      () => ledger.categories(),
    );
    tool(
      "list_rules",
      "List ordered categorization rules.",
      z.object({}),
      "finance:read",
      () => ledger.rules(),
    );
    tool(
      "get_report",
      "Summarize posted transactions for an inclusive date range. Currencies are never combined; transfers are excluded.",
      z.object({ from: dateSchema, to: dateSchema }),
      "finance:read",
      (a) => ledger.report(a.from, a.to),
    );
    tool(
      "create_transaction",
      "Create a manual transaction. Supply a unique request_key and reuse it for retries. Amounts are integer minor units.",
      z.object({
        transaction: transactionSchema,
        request_key: z.string().min(8).max(200),
      }),
      "transactions:write",
      (a) =>
        ledger.saveTransaction(a.transaction, { requestKey: a.request_key }),
    );
    tool(
      "update_transaction",
      "Replace editable transaction fields and splits. Requires current revision and a unique request_key.",
      z.object({
        id: z.string(),
        revision: z.number().int(),
        transaction: transactionSchema,
        request_key: z.string().min(8).max(200),
      }),
      "transactions:write",
      (a) =>
        ledger.saveTransaction(a.transaction, {
          id: a.id,
          revision: a.revision,
          requestKey: a.request_key,
        }),
    );
    tool(
      "categorize_transactions",
      "Categorize up to 100 unsplit, unlinked transactions with revision checks.",
      z.object({
        items: z
          .array(z.object({ id: z.string(), revision: z.number().int() }))
          .min(1)
          .max(100),
        category_id: z.string().nullable(),
      }),
      "transactions:write",
      (a) => ledger.bulkCategory(a.items, a.category_id),
    );
    tool(
      "link_transfer",
      "Link two equal opposite transactions in different accounts of the same currency.",
      z.object({ first: z.string(), second: z.string() }),
      "transactions:write",
      (a) => ledger.linkTransfer(a.first, a.second),
    );
    tool(
      "save_category",
      "Create or update a category and its tax treatment.",
      z.object({
        id: z.string().optional(),
        category: categorySchema,
        request_key: z.string().min(8).max(200),
      }),
      "rules:write",
      (a) => ledger.saveCategory(a.category, a.id, a.request_key),
    );
    tool(
      "preview_rule",
      "Preview matches without changing records. Manual overrides are excluded.",
      z.object({ rule: ruleSchema }),
      "finance:read",
      (a) => ledger.previewRule(a.rule),
    );
    tool(
      "save_rule",
      "Create or update an automatic categorization rule. Does not change existing transactions.",
      z.object({
        id: z.string().optional(),
        rule: ruleSchema,
        request_key: z.string().min(8).max(200),
      }),
      "rules:write",
      (a) => ledger.saveRule(a.rule, a.id, a.request_key),
    );
    tool(
      "apply_rule",
      "Apply a saved rule to explicitly selected preview matches using their revisions.",
      z.object({
        id: z.string(),
        items: z
          .array(z.object({ id: z.string(), revision: z.number().int() }))
          .max(500),
      }),
      "rules:write",
      (a) => ledger.applyRule(a.id, a.items),
    );
    tool(
      "get_tax_estimate",
      "Get saved assumptions, calculation bands, payment schedule, limitations and data freshness for a tax year.",
      z.object({ year: z.number().int().min(2000).max(2100) }),
      "finance:read",
      (a) => taxState(ledger, a.year),
    );
    tool(
      "simulate_taxes",
      "Calculate a hypothetical tax profile without saving it. Use get_tax_estimate to obtain the base profile.",
      z.object({ profile: taxSchema }),
      "finance:read",
      (a) => taxState(ledger, a.profile.year, a.profile),
    );
    tool(
      "save_tax_profile",
      "Persist tax assumptions and rate tables with a revision check.",
      z.object({ profile: taxSchema, revision: z.number().int().min(0) }),
      "tax:write",
      (a) => saveTax(ledger, a.profile, a.revision),
    );
    tool(
      "record_tax_payment",
      "Record an estimated tax payment in integer USD cents.",
      z.object({
        payment: paymentSchema,
        request_key: z.string().min(8).max(200),
      }),
      "tax:write",
      (a) => addPayment(ledger, a.payment, a.request_key),
    );
    tool(
      "request_sync",
      "Enqueue a rate-limited bank synchronization. Optional start date requests historical backfill.",
      z.object({ start: dateSchema.optional() }),
      "sync:write",
      (a) => requestSync(env, a.start),
    );
    tool(
      "get_job",
      "Check progress of an import, export or synchronization job.",
      z.object({ id: z.string() }),
      "finance:read",
      (a) =>
        env.DB.prepare(
          "SELECT id,kind,status,progress,error,updated_at FROM jobs WHERE id=?",
        )
          .bind(a.id)
          .first(),
    );
    tool(
      "export_transactions",
      "Queue a CSV export of filtered transactions. Poll get_job until complete, then download with authentication.",
      filterSchema,
      "finance:read",
      (a) => queueExport(env, a),
    );
    return server;
  };
  const origin = new URL(request.url);
  return createMcpHandler(serverFactory, {
    route: "/mcp",
    corsOptions: false,
    allowedHostnames: [origin.hostname],
    allowedOriginHostnames: [origin.hostname],
  })(request, env, ctx);
}
