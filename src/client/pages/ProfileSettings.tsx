import { useEffect, useState } from "react";
import { UserRound } from "lucide-react";
import { post } from "../api";
import { useWorkspace } from "../context";
import { Button, ErrorNotice, Field, Panel } from "../ui";
import { profileSchema, type Profile } from "../../shared/profile";

export function ProfileSettings() {
  const { username, displayName, updateProfile } = useWorkspace();
  const [name, setName] = useState(displayName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setName(displayName);
  }, [displayName]);
  return (
    <Panel title="Profile" action={<UserRound size={19} className="muted" />}>
      <form
        className="panel-body form-stack"
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setError(null);
          setSaved(false);
          const parsed = profileSchema.safeParse({ displayName: name });
          if (!parsed.success) {
            setError(parsed.error.issues[0].message);
            return;
          }
          setBusy(true);
          try {
            const profile = await post<Profile>(
              "/settings/profile",
              parsed.data,
            );
            updateProfile(profile);
            setName(profile.displayName);
            setSaved(true);
          } catch (error) {
            setError((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>
          Choose the name shown on your account. Your sign-in username stays{" "}
          {username}.
        </p>
        <Field label="Display name">
          <input
            name="displayName"
            autoComplete="nickname"
            value={name}
            placeholder={username}
            maxLength={80}
            disabled={busy}
            aria-describedby="display-name-help"
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
              setSaved(false);
            }}
          />
        </Field>
        <p id="display-name-help" className="inline-note">
          Up to 80 characters. Leave blank to use your sign-in username.
        </p>
        <ErrorNotice error={error} />
        {saved && (
          <div className="notice" role="status">
            Display name saved.
          </div>
        )}
        <div className="actions">
          <Button type="submit" busy={busy}>
            Save display name
          </Button>
        </div>
      </form>
    </Panel>
  );
}
