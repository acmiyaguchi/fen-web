import { toLuaBytes } from "./bytes.js";
import { ACCUMULATE_BODY_CAP } from "./types.js";
import type { FetchRequestOptions, FetchResult, HostFetch } from "./types.js";

/** A scripted response for ScriptedFetch. Chunks may be strings (already
 * Lua-byte-string encoded) or raw Uint8Arrays (converted with
 * toLuaBytes), letting tests exercise binary round-trips. */
export interface ScriptedResponse {
  status: number;
  headers?: Record<string, string>;
  chunks: (string | Uint8Array)[];
  /** Delay before each chunk is delivered, ms. */
  delayMs?: number;
  /** If true, this response never completes on its own — it only
   * resolves via the request's timeoutMs (simulating a stalled
   * transport) so callers can test timeout handling deterministically. */
  hang?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** In-memory/scripted stub implementation of HostFetch for tests. Queue
 * responses with enqueue(), then drive code that calls fetch(); each call
 * consumes the next queued response in FIFO order. */
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
    for (const chunk of response.chunks) {
      if (response.delayMs) await sleep(response.delayMs);
      const bytes = typeof chunk === "string" ? chunk : toLuaBytes(chunk);
      opts.onChunk?.(bytes);
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
