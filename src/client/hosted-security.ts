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
  const result = (await res.json()) as T & { error?: string };
  if (!res.ok) throw Error(result.error || "Request failed. Try again.");
  return result;
}
const input = (name: string) =>
  document
    .querySelector<HTMLInputElement>(`input[name="${name}"]`)
    ?.value.trim();
document.addEventListener("click", async (event) => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>(
    "button[data-action]",
  );
  if (!target || target.disabled) return;
  const action = target.dataset.action!;
  const status = document.querySelector<HTMLElement>("#auth-status")!;
  target.disabled = true;
  status.textContent = "";
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
    } else {
      if (
        action.startsWith("remove-") &&
        !confirm("Remove this method and sign in again?")
      )
        return;
      result = await post(action, {
        code: input("code"),
        id: target.dataset.value,
      });
    }
    if (result?.next) location.assign(result.next);
  } catch (error) {
    status.textContent =
      error instanceof Error ? error.message : "Authentication did not finish.";
  } finally {
    target.disabled = false;
  }
});
