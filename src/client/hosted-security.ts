import {
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";

async function post<T = { next: string }>(path: string, body: unknown = {}) {
  const res = await fetch("/cloud/security/" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const result = (await res.json().catch(() => {
    throw Error("Could not reach sign-in services. Please try again.");
  })) as T & { error?: string };
  if (!res.ok) throw Error(result.error || "Request failed. Try again.");
  return result;
}
const input = (name: string) =>
  document
    .querySelector<HTMLInputElement>(`input[name="${name}"]`)
    ?.value.trim();
let busy = false;
async function performAction(target: HTMLButtonElement, action: string) {
  const status = document.querySelector<HTMLElement>("#auth-status");
  if (busy || target.disabled || !status) return;
  busy = true;
  target.disabled = true;
  status.textContent = "Working…";
  try {
    let result;
    if (action === "register") {
      const label = input("key-label") || "My key";
      const optionsJSON = await post<
        Parameters<typeof startRegistration>[0]["optionsJSON"]
      >("register/options", { role: target.dataset.value, label });
      result = await post(
        "register/finish",
        await startRegistration({ optionsJSON }),
      );
    } else if (action === "login" || action === "second") {
      const optionsJSON = await post<
        Parameters<typeof startAuthentication>[0]["optionsJSON"]
      >(action + "/options");
      result = await post(
        action + "/finish",
        await startAuthentication({ optionsJSON }),
      );
    } else if (action === "setup-code") {
      const { secret } = await post<{ secret: string }>(action);
      document.querySelector("#setup-secret")!.textContent = secret;
      document.querySelector<HTMLElement>("#setup")!.hidden = false;
      document.querySelector<HTMLInputElement>('input[name="code"]')?.focus();
      status.textContent = "Setup key ready. Enter a code to finish.";
    } else {
      if (
        action.startsWith("remove-") &&
        !confirm("Remove this method? Your other sessions will be signed out.")
      ) {
        status.textContent = "";
        return;
      }
      result = await post(action, {
        code: input("code"),
        id: target.dataset.value,
        next:
          location.pathname === "/cloud/security/setup"
            ? "/cloud/account"
            : "/cloud/security",
      });
    }
    if (result?.next) {
      status.textContent = "Success. Continuing…";
      location.assign(result.next);
    } else if (action !== "setup-code") status.textContent = "";
  } catch (error) {
    status.textContent =
      error instanceof Error && error.name === "NotAllowedError"
        ? "Passkey sign-in was cancelled or unavailable. Try again or use another sign-in method."
        : error instanceof Error
          ? error.message
          : "Authentication did not finish.";
  } finally {
    busy = false;
    target.disabled = false;
  }
}
document.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>(
    "button[data-action]",
  );
  if (!target) return;
  event.preventDefault();
  void performAction(target, target.dataset.action!);
});
document.addEventListener("submit", (event) => {
  const form = event.target as HTMLFormElement;
  if (!form.dataset.securityAction) return;
  event.preventDefault();
  const target = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (target && form.reportValidity())
    void performAction(target, form.dataset.securityAction);
});
