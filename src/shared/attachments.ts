import { z } from "zod";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_PHOTO_BYTES = 40 * 1024 * 1024;
export const MAX_ATTACHMENTS = 20;
export const compressionSchema = z.object({
  preset: z.enum(["balanced", "smaller", "detailed", "original"]),
});
export type CompressionSettings = z.infer<typeof compressionSchema>;
export const DEFAULT_COMPRESSION: CompressionSettings = { preset: "balanced" };
export const compressionPresets = {
  balanced: {
    label: "Balanced (recommended)",
    maxDimension: 2800,
    quality: 0.86,
  },
  smaller: { label: "Smaller files", maxDimension: 2000, quality: 0.78 },
  detailed: { label: "More detail", maxDimension: 4000, quality: 0.93 },
  original: { label: "Keep original", maxDimension: 0, quality: 1 },
} as const;
export type Attachment = {
  id: string;
  transaction_id: string;
  filename: string;
  content_type: string;
  size: number;
  original_size: number;
  created_at: number;
};
export function fileSize(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
