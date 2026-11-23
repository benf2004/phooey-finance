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
export function page(
  title: string,
  content: string,
  status = 200,
  layout: "account" | "security" = "account",
) {
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · phooey! finance</title><link rel="stylesheet" href="/business/brand.css"><body class="account-page${layout === "security" ? " security-page" : ""}"><header><a class="finance-wordmark" href="/business/"><img src="/business/assets/phooey.svg" alt="phooey!"> finance</a>${layout === "security" ? '<a class="account-back" href="/cloud/account">Back to account <span aria-hidden="true">↗</span></a>' : ""}</header><main class="account-main"><h1>${escape(title)}</h1>${content}</main></body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html;charset=utf-8",
        "Cache-Control": "no-store",
        // Native POST forms must retain a same-origin Origin header. A
        // no-referrer document policy can make that header opaque ("null").
        "Referrer-Policy": "same-origin",
        "Content-Security-Policy":
          "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://checkout.stripe.com https://billing.stripe.com",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
