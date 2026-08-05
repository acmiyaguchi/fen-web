import { fromLuaBytes, toLuaBytes } from "./bytes.js";
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
      const response = await fetch(opts.url, {
        method: opts.method,
        headers: opts.headers,
        // Lua strings are byte arrays; opts.body was encoded 1-byte-per-
        // code-unit by the Fennel/runtime side (see bytes.ts). Passing it
        // straight through as a JS string would let fetch() re-encode it
        // as UTF-8, double-encoding any non-ASCII byte. Decode back to
        // raw bytes first.
        body: opts.body !== undefined ? (fromLuaBytes(opts.body) as BodyInit) : undefined,
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
      const bodyParts: string[] = [];

      if (response.body) {
        reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          resetIdle();
          const bytes = toLuaBytes(value);
          opts.onChunk?.(bytes);
          if (accumulateBody) {
            bodyParts.push(bytes);
          } else if (bodyLen < ACCUMULATE_BODY_CAP) {
            // Bounded head only, matching fen's native FEN_ERROR_BODY_CAP
            // contract for accumulate-body? false — enough for error
            // diagnostics, not a full buffered response.
            const room = ACCUMULATE_BODY_CAP - bodyLen;
            const head = bytes.length > room ? bytes.slice(0, room) : bytes;
            bodyParts.push(head);
            bodyLen += head.length;
          }
        }
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
