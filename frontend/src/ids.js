// getRandomValues is also available on LAN HTTP origins where randomUUID is not.
export function newId(cryptoSource = globalThis.crypto) {
  if (typeof cryptoSource?.randomUUID === "function")
    return cryptoSource.randomUUID();
  const bytes = new Uint8Array(16);
  cryptoSource.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return [hex.slice(0, 4), hex.slice(4, 6), hex.slice(6, 8), hex.slice(8, 10), hex.slice(10)]
    .map((part) => part.join("")).join("-");
}
