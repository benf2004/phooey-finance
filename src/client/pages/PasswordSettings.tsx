import { useState } from "react";
import { KeyRound } from "lucide-react";
import { post } from "../api";
import { Button, ErrorNotice, Field, Panel } from "../ui";
import { passwordChangeSchema } from "../../shared/password";

export function PasswordSettings() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  return (
    <Panel title="Password" action={<KeyRound size={19} className="muted" />}>
      <form
        className="panel-body form-stack"
        onChange={() => {
          setError(null);
          setSuccess(false);
        }}
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          const form = event.currentTarget;
          const data = new FormData(form);
          setError(null);
          setSuccess(false);
          const parsed = passwordChangeSchema.safeParse({
            currentPassword: data.get("currentPassword"),
            newPassword: data.get("newPassword"),
            confirmPassword: data.get("confirmPassword"),
          });
          if (!parsed.success) {
            setError(parsed.error.issues[0].message);
            return;
          }
          setBusy(true);
          try {
            await post("/settings/password", parsed.data);
            form.reset();
            setSuccess(true);
          } catch (error) {
            setError((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>
          Change your sign-in password. Other browser sessions will be signed
          out.
        </p>
        <Field label="Current password">
          <input
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            required
            maxLength={500}
            disabled={busy}
          />
        </Field>
        <Field
          label="New password"
          hint="Use at least 12 characters, up to 72 UTF-8 bytes. Spaces are allowed."
        >
          <input
            name="newPassword"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={72}
            disabled={busy}
          />
        </Field>
        <Field label="Confirm new password">
          <input
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            required
            maxLength={72}
            disabled={busy}
          />
        </Field>
        <ErrorNotice error={error} />
        {success && (
          <div className="notice" role="status">
            Password changed. Other browser sessions have been signed out.
          </div>
        )}
        <div className="actions">
          <Button type="submit" busy={busy}>
            Change password
          </Button>
        </div>
      </form>
    </Panel>
  );
}
