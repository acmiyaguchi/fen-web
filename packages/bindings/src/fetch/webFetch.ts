import {
  assertAsciiHeaders,
  fromLuaBytes,
  takeUtf8BytePrefix,
  utf8ByteLength,
} from "./bytes.js";
import { ACCUMULATE_BODY_CAP } from "./types.js";
import type { FetchRequestOptions, FetchResult, HostFetch } from "./types.js";

/** host.fetch implemented over the global (browser/Node) fetch API.
 *
 * Timeouts:
 *   - `connectTimeoutMs` bounds only the pre-response phase (DNS/TCP/TLS
 *     plus waiting on the first byte of headers) — its timer is cleared
 *     as soon as `fetch()` resolves with a Response, since fetch() does
 *     not expose a distinct connect callback to hook. A slow-but-healthy
 *     stream past that point must NOT be killed by it.
 *   - `timeoutMs` bounds the entire request, connect phase through the
 *     last streamed byte, and stays armed for the whole call.
 *   - `idleTimeoutMs` is a separate watchdog that resets on every
 *     received chunk (including the initial response) and aborts if no
 *     bytes arrive within the window.
 * All three share one AbortController; whichever fires first aborts the
 * fetch.
 */
export class WebHostFetch implements HostFetch {
  async fetch(opts: FetchRequestOptions): Promise<FetchResult> {
    const controller = new AbortController();
    let abortReason: string | undefined;

    let overallTimer: ReturnType<typeof setTimeout> | undefined;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      overallTimer = setTimeout(() => {
        abortReason = "timeout";
        controller.abort();
      }, opts.timeoutMs);
    }

    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    if (opts.connectTimeoutMs && opts.connectTimeoutMs > 0) {
      connectTimer = setTimeout(() => {
        abortReason = "connect timeout";
        controller.abort();
      }, opts.connectTimeoutMs);
    }

    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const clearIdle = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };
    const resetIdle = () => {
      if (!opts.idleTimeoutMs) return;
      clearIdle();
      idleTimer = setTimeout(() => {
        abortReason = "idle timeout";
        controller.abort();
      }, opts.idleTimeoutMs);
    };
    resetIdle();

    const accumulateBody = opts.accumulateBody !== false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    try {
      assertAsciiHeaders(opts.headers);
      // Wasmoon has already UTF-8-decoded the Lua request string into JS
      // text. Encode that text once as UTF-8 for the wire; the Fennel layer
      // never supplied a latin1-coded byte string here.
      const requestBody = opts.body !== undefined ? fromLuaBytes(opts.body) : undefined;
      const response = await fetch(opts.url, {
        method: opts.method,
        headers: opts.headers,
        body: requestBody as BodyInit | undefined,
        signal: controller.signal,
      });

      // Connect phase is over: headers arrived. From here only the
      // overall and idle timers may abort a healthy stream.
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = undefined;
      }
      resetIdle();

      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      let bodyLen = 0;
      let bodyCapReached = false;
      const bodyParts: string[] = [];
      // Response bodies are text. Keep the decoder alive across reads because
      // ReadableStream chunks may split a UTF-8 sequence; wasmoon's UTF-8
      // marshalling then reproduces the original wire bytes in Lua.
      const decoder = new TextDecoder("utf-8");

      const deliverText = async (text: string): Promise<void> => {
        // An empty decode (a wire chunk carrying only a partial multi-byte
        // prefix) has nothing to deliver — skip it so it doesn't spend a
        // poller chunk slot or re-arm the idle watchdog for no payload.
        if (text.length === 0) return;
        // Poll-based consumers may return a promise when their pending
        // queue is full. Awaiting it keeps the reader from pulling the
        // entire response ahead of Lua's next poll. The idle watchdog
        // measures SERVER silence only: pause it while parked on the
        // consumer (a hidden tab pauses rAF polling for arbitrarily long;
        // that must buffer, not kill the turn) and re-arm before the next
        // read.
        clearIdle();
        await opts.onChunk?.(text);
        resetIdle();
        if (accumulateBody) {
          bodyParts.push(text);
        } else if (!bodyCapReached) {
          // ACCUMULATE_BODY_CAP is a UTF-8 byte cap. Keep only complete
          // Unicode characters when the boundary falls mid-encoding, and
          // STOP there: once a chunk is boundary-blocked the head is closed,
          // so a later chunk can't splice bytes past the omitted character
          // (the retained head stays a contiguous prefix, as the docs say).
          const room = ACCUMULATE_BODY_CAP - bodyLen;
          const head = takeUtf8BytePrefix(text, room);
          bodyParts.push(head);
          bodyLen += utf8ByteLength(head);
          if (head.length < text.length) bodyCapReached = true;
        }
      };

      if (response.body) {
        reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          await deliverText(text);
        }
        // Flush a carried sequence (or the decoder's replacement character
        // for malformed/incomplete UTF-8) after the final wire chunk.
        const tail = decoder.decode();
        if (tail.length > 0) await deliverText(tail);
      }

      return {
        status: response.status,
        headers,
        body: bodyParts.join(""),
      };
    } catch (err) {
      if (controller.signal.aborted) {
        return { error: abortReason ?? "aborted" };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { error: message };
    } finally {
      if (overallTimer) clearTimeout(overallTimer);
      if (connectTimer) clearTimeout(connectTimer);
      clearIdle();
      if (reader) {
        // Release the stream on any exit path (success already drained
        // it to `done`; abort/throw exit mid-read) so the underlying
        // response doesn't keep the connection/reader locked open.
        try {
          await reader.cancel();
        } catch {
          // Already closed/errored — nothing further to release.
        }
        try {
          reader.releaseLock();
        } catch {
          // cancel() above already released the lock in most engines.
        }
      }
    }
  }
}
