import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  csvMappingSchema,
  detectCSVMapping,
  encodeCSV,
  mapCSV,
  parseCSV,
} from "../src/shared/csv";
import {
  exportCSV,
  importChunk,
  previewImport,
  queueImport,
} from "../src/server/files";
import { Ledger } from "../src/server/ledger";
import type { AppEnv } from "../src/server/auth";
import { categoryFixtures } from "./fixtures";

const basicMapping = {
  date: 0,
  description: 1,
  amount: 2,
  dateFormat: "iso" as const,
  invert: false,
};
const headers = [
  "Date",
  "Description",
  "Amount",
  "Tags",
  "Merchant",
  "Notes",
  "Category",
  "Type",
  "Pending",
  "Reviewed",
];
const mapping = detectCSVMapping(headers);

describe("CSV optional field parsing", () => {
  it("detects aliases without mistaking unrelated export columns for required fields", () => {
    expect(
      detectCSVMapping([
        "Transaction ID",
        " posted_date ",
        "Payee",
        "Net Amount",
        "Labels",
        "Vendor",
        "Comments",
        "Category ID",
        "Transaction Type",
        "Is Pending",
        "Is Reviewed",
      ]),
    ).toEqual({
      date: 1,
      description: 2,
      amount: 3,
      tags: 4,
      merchant: 5,
      notes: 6,
      category: 7,
      type: 8,
      pending: 9,
      reviewed: 10,
      dateFormat: "iso",
      invert: false,
    });
    expect(
      detectCSVMapping(["Date", "Description", "Amount"]).tags,
    ).toBeUndefined();
    expect(
      detectCSVMapping(["Amount (USD)", "Date Posted", "Bank memo"]),
    ).toMatchObject({ date: 1, description: 2, amount: 0 });
    expect(
      JSON.stringify(
        csvMappingSchema.parse({
          ...basicMapping,
          tags: null,
          merchant: null,
          notes: null,
          category: null,
          type: null,
          pending: null,
          reviewed: null,
        }),
      ),
    ).toBe(JSON.stringify(basicMapping));
    expect(
      csvMappingSchema.safeParse({ ...basicMapping, tags: -1 }).success,
    ).toBe(false);
    expect(
      csvMappingSchema.safeParse({ ...basicMapping, notes: 101 }).success,
    ).toBe(false);
  });

  it("normalizes tags and preserves JSON tags with embedded delimiters", () => {
    const text = encodeCSV([
      headers,
      [
        "2026-01-01",
        "One",
        -2.5,
        " Business ;business; Client A ",
        " Store ",
        "line one\nline two",
        "",
        "EXPENSE",
        "YES",
        "0",
      ],
      [
        "2026-01-02",
        "Two",
        12,
        JSON.stringify(["Client; A", "Client, B", "client; a"]),
        "",
        "",
        "",
        "income",
        "1",
        "true",
      ],
    ]);
    const rows = mapCSV(text, mapping);
    expect(rows[0]).toMatchObject({
      tags: ["Business", "Client A"],
      merchant: "Store",
      notes: "line one\nline two",
      type: "expense",
      pending: true,
      reviewed: false,
      error: null,
    });
    expect(rows[1]).toMatchObject({
      tags: ["Client; A", "Client, B"],
      amount: 1200,
      pending: true,
      reviewed: true,
      error: null,
    });
  });

  it("distinguishes absent or ignored tags from explicitly empty tags", () => {
    const text =
      "Date,Description,Amount,Tags\n2026-01-01,Blank,1.00,\n2026-01-02,JSON,2.00,[]";
    expect(mapCSV(text, basicMapping).every((r) => r.tags === undefined)).toBe(
      true,
    );
    expect(
      mapCSV(text, { ...basicMapping, tags: null }).every(
        (r) => r.tags === undefined,
      ),
    ).toBe(true);
    expect(
      mapCSV(text, { ...basicMapping, tags: 3 }).map((r) => r.tags),
    ).toEqual([[], []]);
    expect(
      mapCSV("Date,Description,Amount,Tags\n2026-01-01,Missing,1.00", {
        ...basicMapping,
        tags: 3,
      })[0].error,
    ).toContain("Tags: Missing cell");
  });

  it.each([
    ["Tags", "[broken"],
    ["Tags", '["ok",2]'],
    ["Tags", '[""]'],
    ["Tags", "Business;;Client"],
    ["Tags", "x".repeat(51)],
    ["Tags", Array.from({ length: 21 }, () => "same").join(";")],
    ["Pending", "maybe"],
    ["Reviewed", "2"],
    ["Type", "refund"],
  ])("reports an invalid %s field on its CSV row", (field, value) => {
    const fieldHeaders = ["Date", "Description", "Amount", field];
    const row = mapCSV(
      encodeCSV([fieldHeaders, ["2026-01-01", "Invalid", 1, value]]),
      detectCSVMapping(fieldHeaders),
    )[0];
    expect(row.row).toBe(2);
    expect(row.error).toContain(field + ":");
  });

  it("preserves date formats, exact cents and sign inversion for basic CSVs", () => {
    expect(
      mapCSV("Date,Memo,Amount\n02/03/2026,Old CSV,1.01", {
        ...basicMapping,
        dateFormat: "mdy",
        invert: true,
      })[0],
    ).toMatchObject({ posted: "2026-02-03", amount: -101, error: null });
    expect(
      mapCSV("Date,Memo,Amount\n02/03/2026,Old CSV,1.01", {
        ...basicMapping,
        dateFormat: "dmy",
      })[0].posted,
    ).toBe("2026-03-02");
    expect(
      mapCSV("Date,Memo,Amount\n2026-02-30,Bad date,1.00", basicMapping)[0]
        .error,
    ).toContain("Date:");
    expect(
      mapCSV("Date,Memo,Amount\n2026-01-01,Bad money,1.001", basicMapping)[0]
        .error,
    ).toContain("Amount:");
  });
});

describe("CSV preview, staging and commit with local D1/R2", () => {
  let mf: Miniflare, env: AppEnv, ledger: Ledger, account_id: string;
  beforeEach(async () => {
    mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: 'export default {fetch(){return new Response("ok")}}',
        d1Databases: { DB: "csv-import" },
        r2Buckets: ["FILES"],
      }),
    );
    env = await mf.getBindings<AppEnv>();
    const metrics = { backlogCount: 0, backlogBytes: 0 };
    env.JOBS = {
      send: async () => ({ metadata: { metrics } }),
      sendBatch: async () => ({ metadata: { metrics } }),
      metrics: async () => metrics,
    };
    for (const file of (await readdir("migrations")).sort())
      await env.DB.exec(
        (await readFile("migrations/" + file, "utf8")).replaceAll("\n", " "),
      );
    await env.DB.exec(categoryFixtures.replaceAll("\n", " "));
    ledger = new Ledger(env.DB);
    account_id = (await ledger.saveAccount({ name: "CSV account" })).id;
  });
  afterEach(async () => {
    await mf.dispose();
  });
  async function run(jobId: string) {
    const job = await env.DB.prepare("SELECT payload FROM jobs WHERE id=?")
      .bind(jobId)
      .first<{ payload: string }>();
    await importChunk(env, jobId, JSON.parse(job!.payload));
  }
  function input(text: string, selectedMapping = mapping) {
    return { name: "test.csv", account_id, text, mapping: selectedMapping };
  }

  it("imports the downloadable template with no category setup and explicit empty tags", async () => {
    await env.DB.exec("DELETE FROM categories");
    const text = await readFile(
      "public/phooey-transactions-template.csv",
      "utf8",
    );
    const data = input(text, detectCSVMapping(parseCSV(text)[0]));
    const preview = await previewImport(ledger, data);
    expect(preview.rows).toHaveLength(3);
    expect(preview.rows.every((r) => r.error === null)).toBe(true);
    const job = await queueImport(env, data, []);
    await run(job.jobId!);
    const rows = (await ledger.transactions()).items;
    expect(
      rows.find((r) => r.description === "Example client payment"),
    ).toMatchObject({
      tags: ["Business", "Client A"],
      amount: 150000,
      reviewed: 1,
      source: "csv",
    });
    expect(
      rows.find((r) => r.description === "Example personal purchase")?.tags,
    ).toEqual([]);
  });

  it("preserves basic defaults and uses merchant rules unless a category is supplied", async () => {
    await ledger.saveRule({
      name: "Store rule",
      pattern: "Store",
      match_field: "merchant",
      category_id: "groceries",
    });
    const basic = input(
      "Date,Description,Amount\n2026-01-01,Legacy,1.00",
      basicMapping,
    );
    await run((await queueImport(env, basic, [])).jobId!);
    expect(
      (
        await queueImport(
          env,
          { ...basic, mapping: { ...basicMapping, tags: null } },
          [],
        )
      ).alreadyImported,
    ).toBe(true);
    const text = encodeCSV([
      headers,
      [
        "2026-01-02",
        "Automatic",
        -10,
        "Personal",
        "Store",
        "",
        "",
        "expense",
        "",
        "",
      ],
      [
        "2026-01-03",
        "Explicit refund",
        2,
        "",
        "Store",
        "Return",
        "OFFICE & EQUIPMENT",
        "expense",
        "false",
        "yes",
      ],
    ]);
    const data = input(text);
    expect((await previewImport(ledger, data)).rows[1].category_id).toBe(
      "office",
    );
    await run((await queueImport(env, data, [])).jobId!);
    const rows = (await ledger.transactions()).items;
    expect(rows.find((r) => r.description === "Legacy")).toMatchObject({
      tags: ["Business"],
      reviewed: 0,
      pending: 0,
      type: "income",
      merchant: "",
      notes: "",
    });
    expect(rows.find((r) => r.description === "Automatic")).toMatchObject({
      category_id: "groceries",
      tags: ["Personal"],
      merchant: "Store",
      type: "expense",
    });
    expect(rows.find((r) => r.description === "Explicit refund")).toMatchObject(
      {
        category_id: "office",
        tags: [],
        amount: 200,
        type: "expense",
        reviewed: 1,
      },
    );
    expect((await previewImport(ledger, basic)).rows[0].duplicate).toBeTruthy();
  });

  it("rejects all staging when any included row is invalid, but permits explicitly skipped rows", async () => {
    const text = encodeCSV([
      headers,
      [
        "2026-01-01",
        "Valid",
        -1,
        "Business",
        "",
        "",
        "office",
        "expense",
        "false",
        "false",
      ],
      [
        "2026-01-02",
        "Unknown category",
        -2,
        "Business",
        "",
        "",
        "Missing",
        "expense",
        "false",
        "false",
      ],
      [
        "2026-01-03",
        "Bad tags",
        -3,
        "A;;B",
        "",
        "",
        "",
        "expense",
        "false",
        "false",
      ],
      [
        "2026-01-04",
        "Bad flag",
        -4,
        "",
        "",
        "",
        "",
        "expense",
        "sometimes",
        "false",
      ],
    ]);
    const data = input(text);
    const preview = await previewImport(ledger, data);
    expect(
      preview.rows.map((r) => [r.row, r.error?.split(":")[0] ?? null]),
    ).toEqual([
      [2, null],
      [3, "Category"],
      [4, "Tags"],
      [5, "Pending"],
    ]);
    await expect(queueImport(env, data, [])).rejects.toThrow(
      "Resolve or skip invalid rows",
    );
    expect((await ledger.transactions()).total).toBe(0);
    expect(
      await env.DB.prepare("SELECT COUNT(*) n FROM imports").first("n"),
    ).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM jobs").first("n")).toBe(
      0,
    );
    expect((await env.FILES.list()).objects).toHaveLength(0);
    await run((await queueImport(env, data, [3, 4, 5])).jobId!);
    expect((await ledger.transactions()).total).toBe(1);
  });

  it("validates transaction field limits and resolves ambiguous categories only by ID", async () => {
    const category = await ledger.saveCategory({
      name: "office & equipment",
      type: "expense",
    });
    const rows = (
      await previewImport(
        ledger,
        input(
          encodeCSV([
            headers,
            [
              "2026-01-01",
              "Ambiguous",
              1,
              "",
              "",
              "",
              "Office & equipment",
              "income",
              "",
              "",
            ],
            [
              "2026-01-02",
              "Exact ID",
              1,
              "",
              "",
              "",
              category.id,
              "income",
              "",
              "",
            ],
            [
              "2026-01-03",
              "Too long",
              1,
              "",
              "x".repeat(201),
              "x".repeat(4001),
              "",
              "income",
              "",
              "",
            ],
            ["2026-01-04", "", 1, "", "", "", "", "income", "", ""],
          ]),
        ),
      )
    ).rows;
    expect(rows[0].error).toContain("ambiguous");
    expect(rows[1]).toMatchObject({ category_id: category.id, error: null });
    expect(rows[2].error).toContain("merchant:");
    expect(rows[2].error).toContain("notes:");
    expect(rows[3].error).toContain("description:");
  });

  it("round-trips supported export columns including JSON tags, multiline notes and explicit types", async () => {
    for (const row of [
      {
        posted: "2026-02-01",
        amount: 125,
        description: "Refund",
        category_id: "office",
        type: "expense",
        tags: ["Business", "Client; A", "Client, B"],
        merchant: 'A, "Store"',
        notes: 'Line one\nLine two, "quoted"',
        pending: true,
        reviewed: true,
      },
      {
        posted: "2026-02-02",
        amount: -500,
        description: "Transfer",
        type: "transfer",
        tags: [],
        pending: false,
        reviewed: false,
      },
    ])
      await ledger.saveTransaction({ account_id, ...row });
    const original = (await ledger.transactions({ account: account_id })).items;
    const text = await new Response(
      await exportCSV(ledger, { account: account_id }),
    ).text();
    const destination = (await ledger.saveAccount({ name: "Roundtrip" })).id;
    const data = {
      ...input(text, detectCSVMapping(parseCSV(text)[0])),
      account_id: destination,
    };
    expect(
      (await previewImport(ledger, data)).rows.every((r) => r.error === null),
    ).toBe(true);
    await run((await queueImport(env, data, [])).jobId!);
    const imported = (await ledger.transactions({ account: destination }))
      .items;
    const fields = ({
      posted,
      description,
      amount,
      merchant,
      notes,
      category_id,
      type,
      tags,
      pending,
      reviewed,
    }: (typeof original)[number]) => ({
      posted,
      description,
      amount,
      merchant,
      notes,
      category_id,
      type,
      tags,
      pending,
      reviewed,
    });
    expect(imported.map(fields)).toEqual(original.map(fields));
  });

  it("replays and resumes enriched chunks without losing fields or duplicating rows", async () => {
    const data = input(
      encodeCSV([
        headers,
        ...Array.from({ length: 55 }, (_, i) => [
          "2026-03-01",
          `Retry ${i}`,
          -1.25,
          '["Business","Retry"]',
          "Store",
          "Keep me",
          "office",
          "expense",
          "true",
          "true",
        ]),
      ]),
    );
    const job = await queueImport(env, data, []);
    const staged = await env.DB.prepare("SELECT payload FROM jobs WHERE id=?")
      .bind(job.jobId)
      .first<{ payload: string }>();
    await run(job.jobId!);
    expect((await ledger.transactions()).total).toBe(50);
    await importChunk(env, job.jobId!, JSON.parse(staged!.payload));
    expect((await ledger.transactions()).total).toBe(50);
    await env.DB.prepare("UPDATE jobs SET status='failed' WHERE id=?")
      .bind(job.jobId)
      .run();
    const resumed = await queueImport(env, data, []);
    expect(resumed.resumed).toBe(true);
    await run(resumed.jobId!);
    const transactions = await ledger.transactions({ limit: 100 });
    expect(transactions.total).toBe(55);
    expect(
      transactions.items.every(
        (r) =>
          r.tags.join(",") === "Business,Retry" &&
          r.merchant === "Store" &&
          r.notes === "Keep me" &&
          r.category_id === "office" &&
          r.pending === 1 &&
          r.reviewed === 1,
      ),
    ).toBe(true);
    expect((await queueImport(env, data, [])).alreadyImported).toBe(true);
    expect((await ledger.transactions()).total).toBe(55);
  });
});
