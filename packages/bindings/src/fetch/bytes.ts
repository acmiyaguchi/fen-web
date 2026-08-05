// Byte <-> Lua-string conversion.
//
// wasmoon marshals JS strings into Lua strings by round-tripping through
// UTF-16/UTF-8-ish coercion. Lua strings are just byte arrays, but HTTP
// response bodies (SSE frames, JSON, occasionally binary) are arbitrary
// bytes and are NOT necessarily valid UTF-8 mid-stream (a chunk boundary
// can split a multi-byte UTF-8 sequence). Decoding chunks as UTF-8 text
// would corrupt those bytes or throw. Instead we treat each byte as one
// Lua-string byte using a latin1 (ISO-8859-1) mapping: byte value N maps
// to JS code unit N, 1:1, lossless for any byte 0-255. Node's Buffer
// supports this natively via the 'latin1'/'binary' encoding; for
// environments without Buffer (browser) we fall back to
// String.fromCharCode over the raw byte values, chunked to avoid blowing
// the call stack on large arrays.

const CHUNK_SIZE = 0x8000;

function hasBuffer(): boolean {
  return typeof Buffer !== "undefined";
}

/** Convert raw bytes to a Lua-compatible byte string (1 JS UTF-16 code
 * unit per byte, values 0-255). Do NOT use this for text you intend to
 * read as UTF-8 in JS — it is intentionally not real decoding. */
export function toLuaBytes(bytes: Uint8Array): string {
  if (hasBuffer()) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  }
  let out = "";
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const slice = bytes.subarray(i, i + CHUNK_SIZE);
    out += String.fromCharCode(...slice);
  }
  return out;
}

/** Inverse of toLuaBytes: recover the raw bytes from a Lua-style byte
 * string. */
export function fromLuaBytes(s: string): Uint8Array {
  if (hasBuffer()) {
    return new Uint8Array(Buffer.from(s, "latin1"));
  }
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    out[i] = s.charCodeAt(i) & 0xff;
  }
  return out;
}
