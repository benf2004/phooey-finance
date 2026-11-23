import { describe, expect, it } from "vitest";
import {
  accountFromGrid,
  categoryFromGrid,
  createRowRequest,
  missingRowFields,
  ruleFromGrid,
  transactionFromGrid,
} from "../src/client/grid-row-creation";

const transaction = {
  account: "account-1",
  posted: "2026-11-22",
  description: "Office supplies",
  amount: "-12.34",
  category: "",
  tags: '["Business"]',
  reviewed: "1",
};
describe("spreadsheet row creation", () => {
  it("requires meaningful fields while accepting an explicit zero", () => {
    expect(
      missingRowFields({ description: "  ", amount: "" }, [
        "description",
        "account",
        "amount",
      ]),
    ).toEqual(["description", "account", "amount"]);
    expect(
      missingRowFields({ description: "Test", amount: "0" }, [
        "description",
        "amount",
      ]),
    ).toEqual([]);
  });
  it("retains retry keys but distinguishes changed and identical new rows", () => {
    const first = createRowRequest();
    const key = first(transaction);
    expect(first({ ...transaction })).toBe(key);
    expect(first({ ...transaction, amount: "-13.00" })).not.toBe(key);
    expect(createRowRequest()(transaction)).not.toBe(key);
  });
  it("converts transaction amounts to cents and selects a sensible type", () => {
    expect(transactionFromGrid(transaction, [])).toMatchObject({
      amount: -1234,
      type: "expense",
      account_id: "account-1",
      tags: ["Business"],
      reviewed: true,
      category_id: null,
    });
    expect(
      transactionFromGrid({ ...transaction, amount: "1,000.50" }, []),
    ).toMatchObject({ amount: 100050, type: "income" });
    const category = {
      id: "transfer",
      ...categoryFromGrid({ name: "Transfers", type: "transfer" }),
    };
    expect(
      transactionFromGrid({ ...transaction, category: "transfer" }, [category])
        .type,
    ).toBe("transfer");
  });
  it("rejects invalid input before making a create request", () => {
    expect(() =>
      transactionFromGrid({ ...transaction, amount: "oops" }, []),
    ).toThrow();
    expect(() =>
      transactionFromGrid({ ...transaction, posted: "2026-02-30" }, []),
    ).toThrow();
    expect(() =>
      ruleFromGrid({
        name: "Match",
        pattern: "hello",
        category_id: "category",
        priority: "-1",
        enabled: "1",
      }),
    ).toThrow();
  });
  it("parses catalog defaults and boolean flags", () => {
    expect(accountFromGrid({ name: "Cash", balance: "12.34" })).toMatchObject({
      name: "Cash",
      balance: 1234,
      currency: "USD",
      kind: "checking",
    });
    expect(categoryFromGrid({ name: "Office", type: "expense" })).toMatchObject(
      { tax_treatment: "personal", color: "#28634a" },
    );
    expect(
      ruleFromGrid({
        name: "Match",
        pattern: "hello",
        category_id: "category",
        priority: "100",
        enabled: "0",
      }),
    ).toMatchObject({ priority: 100, enabled: false });
  });
});
