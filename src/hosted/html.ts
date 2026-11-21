export const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export const form = (action: string, label: string) =>
  `<form method="post" action="${escape(action)}"><button>${escape(label)}</button></form>`;
export function page(title: string, content: string, status = 200) {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · phooey! finance</title><link rel="stylesheet" href="/business/brand.css"><header><a href="/business/"><img src="/business/assets/wordmark.svg" alt="phooey! finance"></a></header><main class="intro"><h1>${escape(title)}</h1>${content}</main></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html;charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
          "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://checkout.stripe.com https://billing.stripe.com",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
