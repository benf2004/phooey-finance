import { z } from "zod";

export const passwordChangeSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password.").max(500),
    newPassword: z
      .string()
      .min(12, "Use at least 12 characters for your new password.")
      .max(72, "Use at most 72 UTF-8 bytes for your new password.")
      .refine(
        (value) => new TextEncoder().encode(value).length <= 72,
        "Use at most 72 UTF-8 bytes for your new password.",
      ),
    confirmPassword: z.string().max(72),
  })
  .refine((value) => value.newPassword === value.confirmPassword, {
    message: "New passwords do not match.",
    path: ["confirmPassword"],
  });
