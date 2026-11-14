import {
  displayNameSchema,
  profileSchema,
  type Profile,
} from "../shared/profile";
import {
  storedTransactionAppearanceSchema,
  transactionAppearanceSchema,
} from "../shared/transaction-appearance";

export async function readAccountPreferences(db: D1Database) {
  const row = await db
    .prepare("SELECT value FROM settings WHERE key='preferences'")
    .first<{ value: string }>();
  // Older/imported preferences may have no profile or an unrelated JSON shape.
  let preferences: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(row?.value ?? "{}");
    if (value && typeof value === "object" && !Array.isArray(value))
      preferences = value as Record<string, unknown>;
  } catch {
    /* Use defaults for malformed imported preferences. */
  }
  const name = displayNameSchema.safeParse(preferences.displayName ?? "");
  return {
    displayName: name.success ? name.data : "",
    transactionAppearance: storedTransactionAppearanceSchema.parse(
      preferences.transactionAppearance,
    ),
  };
}

export async function saveProfile(
  db: D1Database,
  input: unknown,
): Promise<Profile> {
  const profile = profileSchema.parse(input);
  await mergePreferences(db, profile);
  return profile;
}

export async function saveTransactionAppearance(
  db: D1Database,
  input: unknown,
) {
  const appearance = transactionAppearanceSchema.parse(input);
  await mergePreferences(db, { transactionAppearance: appearance });
  return appearance;
}

async function mergePreferences(
  db: D1Database,
  fields: Record<string, unknown>,
) {
  // Merge only the requested fields atomically; preserve unrelated preferences.
  await db
    .prepare(
      "INSERT INTO settings(key,value) VALUES('preferences',?) ON CONFLICT(key) DO UPDATE SET value=json_patch(CASE WHEN json_valid(settings.value) THEN settings.value ELSE '{}' END,excluded.value),revision=settings.revision+1",
    )
    .bind(JSON.stringify(fields))
    .run();
}
