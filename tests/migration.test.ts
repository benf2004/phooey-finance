import { it, expect } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile, readdir } from "node:fs/promises";
it("upgrades existing bank connections without deleting ledger data or selecting accounts", async () => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: { DB: "upgrade" },
    }),
  );
  try {
    const db = await mf.getD1Database("DB");
    for (const file of (await readdir("migrations"))
      .sort()
      .filter((f) => f < "0005"))
      await db.exec(
        (await readFile("migrations/" + file, "utf8")).replaceAll("\n", " "),
      );
    await db.exec(
      "INSERT INTO connections(id,secret,generation) VALUES('simplefin','encrypted','old'); INSERT INTO accounts(id,name,provider_id,source) VALUES('sf:business','Business','business','simplefin'); INSERT INTO transactions(id,account_id,posted,amount,description,type) VALUES('tx','sf:business','2026-10-01',100,'Existing','income'); INSERT INTO jobs(id,kind,status) VALUES('old-job','sync','queued');",
    );
    await db.exec(
      (
        await readFile("migrations/0005_account_selection.sql", "utf8")
      ).replaceAll("\n", " "),
    );
    const connection = await db
      .prepare(
        "SELECT selection_ready,selected_accounts,available_accounts,generation,status FROM connections",
      )
      .first<{
        selection_ready: number;
        selected_accounts: string;
        available_accounts: string;
        generation: string;
        status: string;
      }>();
    expect(connection?.selection_ready).toBe(0);
    expect(connection?.selected_accounts).toBe("[]");
    expect(connection?.status).toBe("selecting");
    expect(connection?.generation).not.toBe("old");
    expect(JSON.parse(connection!.available_accounts)).toEqual([
      { id: "business", name: "Business", institution: "", currency: "USD" },
    ]);
    expect((await db.prepare("SELECT status FROM jobs").first())?.status).toBe(
      "cancelled",
    );
    expect(
      (await db.prepare("SELECT COUNT(*) AS count FROM transactions").first())
        ?.count,
    ).toBe(1);
  } finally {
    await mf.dispose();
  }
});
