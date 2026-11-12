import { z } from "zod";
import type { AppEnv } from "./auth";
import type { Account } from "../shared/models";
import { assert, id } from "./util";

export async function deleteAccount(
  env: AppEnv,
  accountId: string,
  input: unknown,
) {
  z.object({ confirmation: z.literal("DELETE ACCOUNT") }).parse(input);
  const account = await env.DB.prepare("SELECT * FROM accounts WHERE id=?")
    .bind(accountId)
    .first<Account>();
  assert(account, 404, "Account not found");
  assert(
    !(await env.DB.prepare(
      "SELECT id FROM jobs WHERE kind='import' AND status='running' LIMIT 1",
    ).first()),
    409,
    "Wait for the current import to finish, then delete the account",
  );
  const guard = id();
  const statements = [
    env.DB.prepare(
      "INSERT INTO write_guards VALUES(?,NOT EXISTS(SELECT 1 FROM jobs WHERE kind='import' AND status='running'))",
    ).bind(guard),
  ];
  if (account.source === "simplefin") {
    statements.push(
      env.DB.prepare(
        "UPDATE jobs SET status='cancelled',lease_until=0 WHERE kind='sync' AND status IN ('queued','running')",
      ),
      env.DB.prepare(
        "UPDATE connections SET selected_accounts=(SELECT COALESCE(json_group_array(value),'[]') FROM json_each(selected_accounts) WHERE value<>COALESCE(?,'')),generation=? WHERE id='simplefin'",
      ).bind(account.provider_id, id()),
      env.DB.prepare(
        "UPDATE connections SET status='paused' WHERE id='simplefin' AND json_array_length(selected_accounts)=0",
      ),
    );
  }
  statements.push(
    env.DB.prepare(
      "UPDATE tax_payments SET transaction_id=NULL WHERE transaction_id IN (SELECT id FROM transactions WHERE account_id=?)",
    ).bind(accountId),
    env.DB.prepare(
      "UPDATE transactions SET transfer_id=NULL,revision=revision+1 WHERE transfer_id IN (SELECT transfer_id FROM transactions WHERE account_id=?)",
    ).bind(accountId),
    env.DB.prepare(
      "DELETE FROM audit WHERE entity_id=? OR entity_id IN (SELECT id FROM transactions WHERE account_id=?) OR entity_id IN (SELECT id FROM rules WHERE account_id=?)",
    ).bind(accountId, accountId, accountId),
    env.DB.prepare(
      "DELETE FROM idempotency WHERE json_extract(response,'$.account_id')=? OR json_extract(response,'$.id')=?",
    ).bind(accountId, accountId),
    env.DB.prepare("DELETE FROM transactions WHERE account_id=?").bind(
      accountId,
    ),
    env.DB.prepare("DELETE FROM rules WHERE account_id=?").bind(accountId),
    env.DB.prepare("DELETE FROM balance_snapshots WHERE account_id=?").bind(
      accountId,
    ),
    env.DB.prepare("DELETE FROM accounts WHERE id=?").bind(accountId),
    env.DB.prepare("DELETE FROM write_guards WHERE id=?").bind(guard),
  );
  await env.DB.batch(statements);
  return { ok: true };
}
