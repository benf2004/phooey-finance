export const exampleLanguages = ['curl', 'javascript', 'python'] as const;
export type ExampleLanguage = typeof exampleLanguages[number];
export type ExampleAction = 'render' | 'save';
export const exampleLabels = { curl: 'cURL', javascript: 'JavaScript', python: 'Python' };
export const exampleInstructions = {
  curl: 'Run in your terminal.',
  javascript: 'Save as example.mjs and run with Node.js 22 or later: node example.mjs. No dependencies required.',
  python: 'Install requests with python3 -m pip install requests, then save as example.py and run python3 example.py.',
};

export function apiExample(language: ExampleLanguage, action: ExampleAction): string {
  const save = action === 'save';
  const endpoint = save ? 'invoices' : 'render';
  if (language === 'curl') return `curl --fail-with-body "$INVOICER_URL/api/v1/${endpoint}" \\
  -H "Authorization: Bearer $INVOICER_API_KEY" \\
  -H 'Content-Type: application/json' \\
${save ? "  -H \"Idempotency-Key: $INVOICER_IDEMPOTENCY_KEY\" \\\n" : ''}  --data '{"billTo":{"name":"Acme Ltd"},"items":[{"description":"Design services","quantity":"2.5","rate":"120"}]}'${save ? '' : ' \\\n  --output invoice.pdf'}`;

  if (language === 'javascript') return `${save ? '' : 'import { writeFile } from "node:fs/promises";\n\n'}const url = process.env.INVOICER_URL?.replace(/\\/+$/, "");
const apiKey = process.env.INVOICER_API_KEY;
if (!url || !apiKey) throw new Error("Set INVOICER_URL and INVOICER_API_KEY");
${save ? `const idempotencyKey = process.env.INVOICER_IDEMPOTENCY_KEY;
if (!idempotencyKey) throw new Error("Set INVOICER_IDEMPOTENCY_KEY");
` : ''}
const response = await fetch(url + "/api/v1/${endpoint}", {
  method: "POST",
  headers: {
    Authorization: "Bearer " + apiKey,
    "Content-Type": "application/json",${save ? '\n    "Idempotency-Key": idempotencyKey,' : ''}
  },
  body: JSON.stringify({
    billTo: { name: "Acme Ltd" },
    items: [{ description: "Design services", quantity: "2.5", rate: "120" }],
  }),
});

if (!response.ok) {
  throw new Error("HTTP " + response.status + ": " + await response.text());
}
${save ? `const invoice = await response.json();
console.log(invoice.id, invoice.revision);` : `await writeFile("invoice.pdf", Buffer.from(await response.arrayBuffer()));
console.log("Saved invoice.pdf");`}`;

  return `import os
${save ? '' : 'from pathlib import Path\n'}import requests

url = os.environ["INVOICER_URL"].rstrip("/")
api_key = os.environ["INVOICER_API_KEY"]
${save ? 'idempotency_key = os.environ["INVOICER_IDEMPOTENCY_KEY"]\n' : ''}
response = requests.post(
    f"{url}/api/v1/${endpoint}",
    headers={
        "Authorization": f"Bearer {api_key}",${save ? '\n        "Idempotency-Key": idempotency_key,' : ''}
    },
    json={
        "billTo": {"name": "Acme Ltd"},
        "items": [{"description": "Design services", "quantity": "2.5", "rate": "120"}],
    },
    timeout=60,
)
if not response.ok:
    raise RuntimeError(f"HTTP {response.status_code}: {response.text}")
${save ? `invoice = response.json()
print(invoice["id"], invoice["revision"])` : `Path("invoice.pdf").write_bytes(response.content)
print("Saved invoice.pdf")`}`;
}

export function apiExamplesHtml(action: ExampleAction): string {
  const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return exampleLanguages.map(language => `<details${language === 'javascript' ? ' open' : ''}><summary>${exampleLabels[language]}</summary><p>${exampleInstructions[language]}</p><pre><code>${escapeHtml(apiExample(language, action))}</code></pre></details>`).join('');
}
