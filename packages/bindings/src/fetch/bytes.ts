// Request/response byte conversion at the wasmoon boundary.
//
// Wasmoon owns Lua <-> JS string encoding: it UTF-8-transcodes strings in
// both directions. The Fennel layer never hands latin1-coded bytes to JS
// through wasmoon. Therefore request bodies arrive here as ordinary JS text
// and must be encoded as UTF-8 before fetch().
//
// Response bodies are different: fetch() gives us arbitrary Uint8Array
// chunks, including chunks that split a UTF-8 sequence. `toLuaBytes` keeps
// those chunks in a one-code-unit-per-byte intermediate representation, but
// the response direction's wasmoon marshalling is not byte-safe; that larger
// response-side issue is intentionally left for a follow-up.

const CHUNK_SIZE = 0x8000;

function hasBuffer(): boolean {
  return typeof Buffer !== "undefined";
}

/** Convert response bytes to the intermediate string representation used by
 * the Lua-facing stream protocol. This is not UTF-8 decoding: each byte is
 * represented by one JS code unit so arbitrary response chunks can be held
 * without interpreting split multi-byte sequences. */
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

/** Encode a request body string as UTF-8.
 *
 * The string has already crossed wasmoon, which decoded the Lua string's
 * UTF-8 bytes into a normal JS Unicode string. Always use TextEncoder here:
 * treating JS code units <= 0xff as latin1 would corrupt text such as
 * "café" by emitting E9 instead of C3 A9. A genuinely binary request body
 * is outside this string contract. */
export function fromLuaBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** HTTP headers use the separate ASCII-only contract. Do not apply the
 * latin1 byte-string conversion to them: a non-ASCII header value is invalid
 * for this transport and must be rejected rather than silently re-encoded. */
export function assertAsciiHeaders(headers?: Record<string, string>): void {
  if (!headers) return;

  for (const [name, value] of Object.entries(headers)) {
    if (!isAscii(name)) {
      throw new TypeError(`HTTP header name ${JSON.stringify(name)} must contain ASCII characters only`);
    }
    if (!isAscii(value)) {
      throw new TypeError(
        `HTTP header value for ${JSON.stringify(name)} must contain ASCII characters only`,
      );
    }
  }
}

function isAscii(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}
