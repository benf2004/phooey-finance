import { type Party } from "./model";

export const partyText = (party: Party) =>
  [party.name, party.address, party.email, party.phone, party.taxId]
    .filter(Boolean)
    .join("\n");

// Keep existing structured contact fields when editing the printable address block.
// New free-form contact lines are valid address content; email is recognized separately.
export function parsePartyText(text: string, previous: Party): Party {
  const [name = "", ...lines] = text.split("\n");
  const contact = { email: "", phone: "", taxId: "" };
  for (const key of ["email", "phone", "taxId"] as const) {
    const index = previous[key] ? lines.lastIndexOf(previous[key]) : -1;
    if (index !== -1) contact[key] = lines.splice(index, 1)[0];
  }
  if (!contact.email) {
    const index = lines.findIndex((line) =>
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(line),
    );
    if (index !== -1) contact.email = lines.splice(index, 1)[0];
  }
  return { name, address: lines.join("\n"), ...contact };
}
