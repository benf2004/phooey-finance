import { compressionSchema, DEFAULT_COMPRESSION } from "../shared/attachments";

export async function readCompression(db: D1Database) {
  const row = await db
    .prepare("SELECT value FROM settings WHERE key='preferences'")
    .first<{ value: string }>();
  try {
    const parsed = compressionSchema.safeParse(
      JSON.parse(row?.value ?? "{}").attachmentCompression,
    );
    return parsed.success ? parsed.data : DEFAULT_COMPRESSION;
  } catch {
    return DEFAULT_COMPRESSION;
  }
}

export async function saveCompression(db: D1Database, input: unknown) {
  const settings = compressionSchema.parse(input);
  await db
    .prepare(
      "INSERT INTO settings(key,value) VALUES('preferences',?) ON CONFLICT(key) DO UPDATE SET value=json_patch(CASE WHEN json_valid(settings.value) THEN settings.value ELSE '{}' END,excluded.value),revision=settings.revision+1",
    )
    .bind(JSON.stringify({ attachmentCompression: settings }))
    .run();
  return settings;
}
