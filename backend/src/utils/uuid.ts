import { randomBytes } from "node:crypto";

let lastMs = 0;
let lastSeq = 0;

function toHex(bytes: Uint8Array): string {
  const hex: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    hex.push(bytes[i].toString(16).padStart(2, "0"));
  }
  return hex.join("");
}

function randomSeq12(): number {
  const b = randomBytes(2);
  return ((b[0] << 8) | b[1]) & 0x0fff;
}

export function uuidv7(): string {
  const bytes = randomBytes(16);

  const ms = Date.now();
  const ts = BigInt(ms);

  // 48-bit unix timestamp in milliseconds (big-endian)
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);

  // 12-bit monotonic sequence within the same millisecond
  let seq = 0;
  if (ms === lastMs) {
    lastSeq = (lastSeq + 1) & 0x0fff;
    seq = lastSeq;
  } else {
    lastMs = ms;
    lastSeq = randomSeq12();
    seq = lastSeq;
  }

  // version (7) + seq high 4 bits
  bytes[6] = 0x70 | ((seq >> 8) & 0x0f);
  // seq low 8 bits
  bytes[7] = seq & 0xff;

  // variant (RFC 4122): 10xx
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

