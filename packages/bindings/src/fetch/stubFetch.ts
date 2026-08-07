import {
  assertAsciiHeaders,
  fromLuaBytes,
  takeUtf8BytePrefix,
  utf8ByteLength,
} from "./bytes.js";
import { ACCUMULATE_BODY_CAP } from "./types.js";
import type { FetchRequestOptions, FetchResult, HostFetch } from "./types.js";

/** A scripted response for ScriptedFetch. Chunks model wire response
 * chunks: authored JS strings are UTF-8 encoded, while Uint8Arrays are used
 * for raw wire bytes (including tests that split a multi-byte sequence).
 * Both forms pass through the same streaming UTF-8 decoder as WebHostFetch. */
export interface ScriptedResponse {
  status: number;
  headers?: Record<string, string>;
  chunks: (string | Uint8Array)[];
  /** Delay before each chunk is delivered, ms. */
  delayMs?: number;
  /** If true, this response never completes on its own — it only
   * resolves via the request's timeoutMs (simulating a stalled transport)
   * so callers can test timeout handling deterministically. */
  hang?: boolean;
  /** Return a mid-stream failure after this many chunks have been delivered.
   * This mirrors a response body aborting after data has already arrived. */
  abortAfterChunks?: number;
  /** Error text for abortAfterChunks (defaults to "aborted"). */
  abortMessage?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ScriptedRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  /** Raw wire bytes recovered from the Lua byte string. */
  body?: Uint8Array;
}

/** In-memory/scripted stub implementation of HostFetch. Queue responses with
 * enqueue(), then drive code that calls fetch(); each call consumes the next
 * queued response in FIFO order. Its delay and abort controls intentionally
 * mirror WebHostFetch's observable stream failures, including an idle timer
 * that can expire while an onChunk backpressure promise is outstanding. */
export class ScriptedFetch implements HostFetch {
  private queue: ScriptedResponse[] = [];
  private _lastRequest: ScriptedRequest | undefined;

  /** The most recent request after transport-side byte normalization. */
  get lastRequest(): ScriptedRequest | undefined {
    return this._lastRequest;
  }

  enqueue(response: ScriptedResponse): void {
    this.queue.push(response);
  }

  async fetch(opts: FetchRequestOptions): Promise<FetchResult> {
    try {
      assertAsciiHeaders(opts.headers);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }

    const response = this.queue.shift();
    if (!response) {
      throw new Error("ScriptedFetch: no scripted response queued");
    }

    // Record only requests that reached a scripted transport response. A
    // failed queue lookup must not make lastRequest look like it was sent.
    this._lastRequest = {
      method: opts.method,
      url: opts.url,
      headers: opts.headers ? { ...opts.headers } : undefined,
      body: opts.body !== undefined ? fromLuaBytes(opts.body) : undefined,
    };

    if (response.hang) {
      if (!opts.timeoutMs) {
        throw new Error("ScriptedFetch: hanging response requires opts.timeoutMs");
      }
      await sleep(opts.timeoutMs);
      return { error: "timeout" };
    }

    const accumulateBody = opts.accumulateBody !== false;
    const bodyParts: string[] = [];
    let bodyLen = 0;
    let bodyCapReached = false;
    let deliveredChunks = 0;
    const decoder = new TextDecoder("utf-8");
    const idleTimeoutMs = opts.idleTimeoutMs && opts.idleTimeoutMs > 0 ? opts.idleTimeoutMs : 0;

    const deliverText = async (text: string): Promise<void> => {
      // Skip an empty decode (partial multi-byte prefix only) — parity with
      // WebHostFetch: no wasted poller slot, no idle re-arm for no payload.
      if (text.length === 0) return;
      try {
        // Match WebHostFetch: a poll-based sink can hold this delivery until
        // the next poll drains its bounded pending queue. Parity note: the
        // idle watchdog measures scripted SERVER delay only (delayMs above);
        // time parked on the consumer never counts, and a dispose() while
        // parked surfaces as a clean error result, mirroring WebHostFetch's
        // catch-all.
        await opts.onChunk?.(text);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(message);
      }

      if (accumulateBody) {
        bodyParts.push(text);
      } else if (!bodyCapReached) {
        // ACCUMULATE_BODY_CAP is a UTF-8 byte cap. Keep only complete Unicode
        // characters when the boundary falls mid-encoding, and STOP there so
        // the retained head stays a contiguous prefix (parity with
        // WebHostFetch — no post-cap splice from a later chunk).
        const room = ACCUMULATE_BODY_CAP - bodyLen;
        const head = takeUtf8BytePrefix(text, room);
        bodyParts.push(head);
        bodyLen += utf8ByteLength(head);
        if (head.length < text.length) bodyCapReached = true;
      }
    };

    for (const chunk of response.chunks) {
      const delayMs = response.delayMs ?? 0;
      // The scripted delay stands in for waiting on the next body byte. If it
      // exceeds the idle deadline, WebHostFetch would abort before a chunk is
      // available and return this failure without invoking onChunk.
      if (delayMs > 0) {
        if (idleTimeoutMs > 0 && delayMs >= idleTimeoutMs) {
          await sleep(idleTimeoutMs);
          return { error: "idle timeout" };
        }
        await sleep(delayMs);
      }

      const wireBytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
      const text = decoder.decode(wireBytes, { stream: true });
      try {
        await deliverText(text);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { error: message };
      }

      deliveredChunks++;
      if (
        response.abortAfterChunks !== undefined &&
        deliveredChunks >= response.abortAfterChunks
      ) {
        return { error: response.abortMessage ?? "aborted" };
      }
    }

    const tail = decoder.decode();
    if (tail.length > 0) {
      try {
        await deliverText(tail);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { error: message };
      }
    }

    return {
      status: response.status,
      headers: response.headers ?? {},
      body: bodyParts.join(""),
    };
  }
}
