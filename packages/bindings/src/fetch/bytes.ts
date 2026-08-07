// Text encoding helpers at the wasmoon boundary.
//
// Wasmoon owns Lua <-> JS string encoding: it UTF-8-transcodes strings in
// both directions. The Fennel layer never hands latin1-coded bytes to JS
// through wasmoon. Therefore request bodies arrive here as ordinary JS text
// and must be encoded as UTF-8 before fetch(). Response bodies follow the
// same text contract: the transport decodes wire bytes as UTF-8 before they
// cross back into Lua, so wasmoon's UTF-8 re-encoding reproduces the wire
// bytes rather than double-encoding a latin1 intermediate string.

const UTF8_ENCODER = new TextEncoder();

/** Encode a request body string as UTF-8.
 *
 * The string has already crossed wasmoon, which decoded the Lua string's
 * UTF-8 bytes into a normal JS Unicode string. Always use TextEncoder here:
 * treating JS code units <= 0xff as latin1 would corrupt text such as
 * "café" by emitting E9 instead of C3 A9. A genuinely binary request body
 * is outside this string contract. */
export function fromLuaBytes(s: string): Uint8Array {
  return UTF8_ENCODER.encode(s);
}

/** Return the number of bytes used by a JS text string in UTF-8. */
export function utf8ByteLength(s: string): number {
  return UTF8_ENCODER.encode(s).byteLength;
}

/**
 * Keep the largest prefix of `text` that fits in `maxBytes` UTF-8 bytes.
 * Iterating code points (rather than UTF-16 code units) means a surrogate
 * pair is kept or omitted as a unit. The response body cap is a byte cap,
 * but it must never manufacture a partial Unicode character.
 */
export function takeUtf8BytePrefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0 || text.length === 0) return "";

  let used = 0;
  let end = 0;
  for (const codePoint of text) {
    const size = utf8ByteLength(codePoint);
    if (used + size > maxBytes) break;
    used += size;
    end += codePoint.length;
  }
  return text.slice(0, end);
}

/** HTTP header names and values use a separate ASCII-only contract. Do not
 * apply a byte-string conversion to them: a non-ASCII header value is
 * invalid for this transport and must be rejected rather than silently
 * re-encoded. */
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
