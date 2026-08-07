import { toLuaBytes } from "./bytes.js";
import { ACCUMULATE_BODY_CAP } from "./types.js";
import type { FetchRequestOptions, FetchResult, HostFetch } from "./types.js";

/** A scripted response for ScriptedFetch. Chunks may be strings (already
 * Lua-byte-string encoded) or raw Uint8Arrays (converted with toLuaBytes),
 * letting tests exercise binary round-trips. */
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

/** In-memory/scripted stub implementation of HostFetch. Queue responses with
 * enqueue(), then drive code that calls fetch(); each call consumes the next
 * queued response in FIFO order. Its delay and abort controls intentionally
 * mirror WebHostFetch's observable stream failures, including an idle timer
 * that can expire while an onChunk backpressure promise is outstanding. */
export class ScriptedFetch implements HostFetch {
  private queue: ScriptedResponse[] = [];

  enqueue(response: ScriptedResponse): void {
    this.queue.push(response);
  }

  async fetch(opts: FetchRequestOptions): Promise<FetchResult> {
    const response = this.queue.shift();
    if (!response) {
      throw new Error("ScriptedFetch: no scripted response queued");
    }

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
    let deliveredChunks = 0;
    const idleTimeoutMs = opts.idleTimeoutMs && opts.idleTimeoutMs > 0 ? opts.idleTimeoutMs : 0;

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

      const bytes = typeof chunk === "string" ? chunk : toLuaBytes(chunk);
      try {
        // Match WebHostFetch: a poll-based sink can hold this delivery until
        // the next poll drains its bounded pending queue. Parity note: the
        // idle watchdog measures scripted SERVER delay only (delayMs above);
        // time parked on the consumer never counts, and a dispose() while
        // parked surfaces as a clean error result, mirroring WebHostFetch's
        // catch-all.
        await opts.onChunk?.(bytes);
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

      if (accumulateBody) {
        bodyParts.push(bytes);
      } else if (bodyLen < ACCUMULATE_BODY_CAP) {
        const room = ACCUMULATE_BODY_CAP - bodyLen;
        const head = bytes.length > room ? bytes.slice(0, room) : bytes;
        bodyParts.push(head);
        bodyLen += head.length;
      }
    }

    return {
      status: response.status,
      headers: response.headers ?? {},
      body: bodyParts.join(""),
    };
  }
}
