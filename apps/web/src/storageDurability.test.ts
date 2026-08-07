import { test } from "node:test";
import assert from "node:assert/strict";
import { DiagnosticsBuffer } from "./diagnostics.js";
import { requestStorageDurability } from "./storageDurability.js";

test("storage durability records persistence result and quota estimate", async () => {
  const diagnostics = new DiagnosticsBuffer();
  let persistCalls = 0;
  let estimateCalls = 0;
  await requestStorageDurability(
    {
      persist: async () => {
        persistCalls += 1;
        return true;
      },
      estimate: async () => {
        estimateCalls += 1;
        return { usage: 12, quota: 100 };
      },
    },
    diagnostics,
  );

  assert.equal(persistCalls, 1);
  assert.equal(estimateCalls, 1);
  assert.deepEqual(
    diagnostics.recentEvents.map((event) => event.kind),
    ["storage:persist", "storage:estimate"],
  );
  assert.match(diagnostics.recentEvents[0].summary, /true/);
  assert.match(diagnostics.recentEvents[1].summary, /12/);
  assert.match(diagnostics.recentEvents[1].summary, /100/);
  const report = diagnostics.snapshot();
  assert.match(report, /Storage persisted: true/);
  assert.match(report, /Storage usage: 12/);
  assert.match(report, /Storage quota: 100/);
});

test("diagnostics collapse repeated write-back failures without ring flooding", () => {
  const diagnostics = new DiagnosticsBuffer({ limit: 3 });
  for (let i = 0; i < 25; i += 1) {
    diagnostics.recordCollapsed("kv:write-back-failed", new Error("storage unavailable"));
  }
  assert.equal(diagnostics.recentEvents.length, 1);
  assert.match(diagnostics.recentEvents[0].summary, /repeated 20 times/);

  diagnostics.recordCollapsed("kv:write-back-failed", new Error("quota changed"));
  assert.equal(diagnostics.recentEvents.length, 2);
});

test("storage durability degrades gracefully when APIs are absent or denied", async () => {
  const absent = new DiagnosticsBuffer();
  await assert.doesNotReject(() => requestStorageDurability(undefined, absent));
  assert.equal(absent.recentEvents[0].kind, "storage:durability-unavailable");

  const denied = new DiagnosticsBuffer();
  await assert.doesNotReject(() =>
    requestStorageDurability(
      {
        persist: async () => {
          throw new Error("not allowed");
        },
      },
      denied,
    ),
  );
  assert.deepEqual(
    denied.recentEvents.map((event) => event.kind),
    ["storage:persist-failed", "storage:estimate-unavailable"],
  );
});
