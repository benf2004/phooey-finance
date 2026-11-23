import { describe, expect, it } from "vitest";
import { emptyParty } from "../src/shared/model";
import { parsePartyText, partyText } from "../src/shared/party-text";

describe("invoice party text editing", () => {
  const party = {
    name: "Studio",
    address: "12 Main Street\nDenver, CO",
    email: "hello@example.com",
    phone: "+1 555 0100",
    taxId: "US-1234",
  };
  it("round-trips saved structured contacts through a single text area", () => {
    expect(parsePartyText(partyText(party), party)).toEqual(party);
  });
  it("retains contacts while changing the address", () => {
    expect(
      parsePartyText(partyText(party).replace("12 Main", "14 Main"), party),
    ).toEqual({ ...party, address: "14 Main Street\nDenver, CO" });
  });
  it("removes a deleted contact and recognizes a changed email", () => {
    const text = partyText(party)
      .replace("hello@example.com", "new@example.com")
      .replace("\nUS-1234", "");
    expect(parsePartyText(text, party)).toEqual({
      ...party,
      email: "new@example.com",
      taxId: "",
    });
  });
  it("preserves blank address lines and free-form contact information", () => {
    const text = "Studio\n12 Main Street\n\nCall our accounts team";
    expect(partyText(parsePartyText(text, emptyParty))).toBe(text);
  });
});
