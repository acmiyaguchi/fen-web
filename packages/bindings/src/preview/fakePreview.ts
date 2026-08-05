import type {
  HostPreview,
  PreviewPollResult,
  PreviewRpcRequest,
  PreviewRpcResult,
} from "./types.js";

/** A synchronous, in-memory host.preview double for Node/off-DOM tests (the
 * way ScriptedFetch/FakeDom stand in for their real bindings). It records the
 * last rendered HTML and every RPC request, and resolves each RPC immediately
 * via a caller-supplied responder — so a poll always reports `done: true` on
 * the first call and no cooperative yield is needed. */
export class FakePreview implements HostPreview {
  html: string | null = null;
  readonly requests: PreviewRpcRequest[] = [];
  private readonly results = new Map<number, PreviewRpcResult>();
  private nextId = 1;

  constructor(
    private readonly responder: (req: PreviewRpcRequest) => PreviewRpcResult = () => ({
      ok: true,
    }),
  ) {}

  setHtml(html: string): void {
    this.html = html;
  }

  rpcStart(req: PreviewRpcRequest): number {
    this.requests.push(req);
    const id = this.nextId++;
    this.results.set(id, this.responder(req));
    return id;
  }

  rpcPoll(id: number): PreviewPollResult {
    return { done: true, result: this.results.get(id) };
  }

  rpcDispose(id: number): void {
    this.results.delete(id);
  }
}
