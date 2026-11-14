import {
  compressionPresets,
  MAX_ATTACHMENT_BYTES,
  MAX_PHOTO_BYTES,
  type CompressionSettings,
} from "../shared/attachments";

export async function prepareAttachment(
  file: File,
  settings: CompressionSettings,
): Promise<File> {
  if (!file.size) throw new Error("This file is empty.");
  if (file.size > MAX_PHOTO_BYTES)
    throw new Error("Choose a photo smaller than 40 MB (PDFs: 20 MB maximum).");
  const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const text = new TextDecoder().decode(header);
  const pdf = text.startsWith("%PDF-");
  if (pdf) {
    if (file.size > MAX_ATTACHMENT_BYTES)
      throw new Error(
        "This PDF exceeds 20 MB. Optimize it in your PDF app before uploading; all pages must be preserved.",
      );
    return new File([file], file.name, { type: "application/pdf" });
  }
  const nativeType =
    header[0] === 255 && header[1] === 216
      ? "image/jpeg"
      : header[0] === 137 && text.slice(1, 4) === "PNG"
        ? "image/png"
        : text.startsWith("RIFF") && text.slice(8, 12) === "WEBP"
          ? "image/webp"
          : null;
  const phoneFormat =
    text.slice(4, 8) === "ftyp" &&
    /heic|heix|hevc|hevx|mif1|avif/.test(text.slice(8, 16));
  if (!nativeType && !phoneFormat)
    throw new Error(
      "Use JPEG, PNG, WebP or PDF. HEIC/AVIF photos work when your browser can decode them; otherwise export as JPEG.",
    );
  const original = new File([file], file.name, {
    type: nativeType ?? file.type,
  });
  if (settings.preset === "original") {
    if (!nativeType)
      throw new Error(
        "Keep original supports JPEG, PNG, WebP and PDF. Export this HEIC/AVIF photo as JPEG, or choose a compression preset.",
      );
    if (file.size > MAX_ATTACHMENT_BYTES)
      throw new Error(
        "This file exceeds 20 MB. Choose a compression preset or a smaller file.",
      );
    return original;
  }
  // Preserve animated images as-is rather than silently discarding their frames.
  if (nativeType === "image/png" || nativeType === "image/webp") {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const view = new DataView(bytes.buffer);
    let animated = false;
    for (
      let offset = nativeType === "image/png" ? 8 : 12;
      offset + 8 <= bytes.length;
    ) {
      const png = nativeType === "image/png";
      const tag = new TextDecoder().decode(
        bytes.subarray(offset + (png ? 4 : 0), offset + (png ? 8 : 4)),
      );
      if (tag === "acTL" || tag === "ANIM") {
        animated = true;
        break;
      }
      const length = view.getUint32(offset + (png ? 0 : 4), !png);
      offset += length + (png ? 12 : 8 + (length % 2));
    }
    if (animated) {
      if (file.size > MAX_ATTACHMENT_BYTES)
        throw new Error(
          "Animated images are kept unchanged and must be 20 MB or smaller.",
        );
      return original;
    }
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(original, {
      imageOrientation: "from-image",
    });
  } catch {
    throw new Error(
      phoneFormat
        ? "Your browser cannot read this HEIC/AVIF photo. Export or share it as JPEG, then try again."
        : "This image could not be read. Export it again as JPEG or PNG.",
    );
  }
  try {
    if (bitmap.width * bitmap.height > 60_000_000)
      throw new Error(
        "This photo exceeds 60 megapixels. Resize it before uploading.",
      );
    const preset = compressionPresets[settings.preset];
    const scale = Math.min(
      1,
      preset.maxDimension / Math.max(bitmap.width, bitmap.height),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context)
      throw new Error("Image compression is unavailable in this browser.");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", preset.quality),
    );
    canvas.width = canvas.height = 0;
    if (!blob)
      throw new Error(
        "The browser could not compress this image. Try another file.",
      );
    // Never store a larger transcoded image or imply savings that did not occur.
    if (blob.size >= file.size && nativeType) {
      if (file.size > MAX_ATTACHMENT_BYTES)
        throw new Error(
          "Compression did not bring this photo below 20 MB. Resize it before uploading.",
        );
      return original;
    }
    if (blob.size >= file.size)
      throw new Error(
        "Converting this HEIC/AVIF photo would increase its size. Export it as JPEG before uploading.",
      );
    if (blob.size > MAX_ATTACHMENT_BYTES)
      throw new Error(
        "The compressed image still exceeds 20 MB. Choose a smaller image.",
      );
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", {
      type: "image/jpeg",
    });
  } finally {
    bitmap.close();
  }
}
