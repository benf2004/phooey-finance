import { now } from "../server/util";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function newTotpSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let bits = 0,
    buffer = 0,
    result = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += alphabet[(buffer >>> bits) & 31];
    }
  }
  return result;
}
export async function verifyTotp(secret: string, code: string, at = now()) {
  if (!/^[0-9]{6}$/.test(code) || !/^[A-Z2-7]{32}$/.test(secret)) return null;
  let bits = 0,
    buffer = 0;
  const bytes = [];
  for (const char of secret) {
    buffer = (buffer << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 255);
    }
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(bytes),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const current = Math.floor(at / 30);
  for (const step of [current, current - 1, current + 1]) {
    const counter = new ArrayBuffer(8);
    new DataView(counter).setBigUint64(0, BigInt(step));
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
    const value = new DataView(mac.buffer).getUint32(mac[19] & 15) & 0x7fffffff;
    if (String(value % 1_000_000).padStart(6, "0") === code) return step;
  }
  return null;
}
