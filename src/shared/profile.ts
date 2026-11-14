import { z } from "zod";

export const displayNameSchema = z
  .string()
  .trim()
  .max(80, "Use at most 80 characters for your display name.")
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/.test(value),
    "Use a single line without control characters for your display name.",
  );

export const profileSchema = z
  .object({ displayName: displayNameSchema })
  .strict();
export type Profile = z.infer<typeof profileSchema>;
