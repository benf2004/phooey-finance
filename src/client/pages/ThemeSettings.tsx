import { useWorkspace } from "../context";
import { Field, Panel } from "../ui";

export function ThemeSettings() {
  const { theme, setTheme } = useWorkspace();
  return (
    <Panel title="Theme">
      <div className="panel-body form-stack">
        <Field label="Color theme">
          <select
            value={theme}
            onChange={(event) =>
              setTheme(event.target.value === "dark" ? "dark" : "light")
            }
          >
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </Field>
        <p className="inline-note">
          Applies immediately and is remembered on this browser. You can also
          switch themes from the top bar.
        </p>
      </div>
    </Panel>
  );
}
