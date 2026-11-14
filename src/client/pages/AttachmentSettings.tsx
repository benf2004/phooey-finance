import { useEffect, useState } from "react";
import { api, post } from "../api";
import { Button, ErrorNotice, Field, Panel } from "../ui";
import {
  compressionPresets,
  DEFAULT_COMPRESSION,
  type CompressionSettings,
} from "../../shared/attachments";

export function AttachmentSettings() {
  const [settings, setSettings] = useState(DEFAULT_COMPRESSION);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    api<CompressionSettings>("/settings/attachment-compression")
      .then(setSettings)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  const preset = compressionPresets[settings.preset];
  return (
    <Panel title="Receipt & invoice storage">
      <form
        className="panel-body form-stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          setSaved(false);
          try {
            setSettings(
              await post<CompressionSettings>(
                "/settings/attachment-compression",
                settings,
              ),
            );
            setSaved(true);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field
          label="Image compression"
          hint="Applies to future uploads. Existing attachments stay unchanged."
        >
          <select
            disabled={loading || busy}
            value={settings.preset}
            onChange={(e) => {
              setSettings({
                preset: e.target.value as CompressionSettings["preset"],
              });
              setSaved(false);
            }}
          >
            {Object.entries(compressionPresets).map(([key, value]) => (
              <option key={key} value={key}>
                {value.label}
              </option>
            ))}
          </select>
        </Field>
        <p className="inline-note">
          {settings.preset === "original"
            ? "Keep supported images unchanged, up to 20 MB each."
            : `Resize photos to at most ${preset.maxDimension.toLocaleString()} pixels on the longest edge, at ${Math.round(preset.quality * 100)}% JPEG quality. Keep the original if it is smaller.`}{" "}
          Review small text after uploading.
        </p>
        <p className="inline-note">
          PDFs stay unchanged to preserve every page. Up to 20 files per
          transaction, 20 MB per stored file. JSON backups do not include
          attachment files; download important receipts separately.
        </p>
        <ErrorNotice error={error} />
        {saved && <p role="status">Image compression saved.</p>}
        <div>
          <Button disabled={loading} busy={busy}>
            Save compression
          </Button>
        </div>
      </form>
    </Panel>
  );
}
