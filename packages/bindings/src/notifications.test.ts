import { test } from "node:test";
import assert from "node:assert/strict";
import {
  browserNotificationPermission,
  NOTIFY_BODY_MAX_LENGTH,
  NOTIFY_MIN_INTERVAL_MS,
  NOTIFY_TITLE_MAX_LENGTH,
  requestBrowserNotificationPermission,
  WebHostNotify,
  type NotificationConstructor,
} from "./notifications.js";

const globalWithNotification = globalThis as unknown as {
  Notification?: unknown;
};

function withNotification<T>(
  notification: NotificationConstructor | undefined,
  run: () => T,
): T {
  const previous = globalWithNotification.Notification;
  if (notification) globalWithNotification.Notification = notification;
  else delete globalWithNotification.Notification;
  try {
    return run();
  } finally {
    if (previous === undefined) delete globalWithNotification.Notification;
    else globalWithNotification.Notification = previous;
  }
}

test("notify never prompts from the tool host seam when permission is default", () => {
  let requested = 0;
  let constructed = 0;
  class StubNotification {
    static permission = "default" as const;
    static requestPermission = async () => {
      requested += 1;
      return "granted" as const;
    };

    constructor(_title: string, _options?: { body?: string }) {
      constructed += 1;
    }
  }

  const result = withNotification(StubNotification, () => new WebHostNotify().notify("Attention"));
  assert.deepEqual(result, {
    ok: false,
    status: "fallback",
    fallback: true,
    error: "permission not granted",
  });
  assert.equal(requested, 0, "the agent tool must not request permission");
  assert.equal(constructed, 0, "a default-permission notification must not be constructed");
});

test("notify sends title and optional body after shell permission is granted", () => {
  const calls: Array<{ title: string; options?: { body?: string } }> = [];
  class StubNotification {
    static permission = "granted" as const;

    constructor(title: string, options?: { body?: string }) {
      calls.push({ title, options });
    }
  }

  const result = withNotification(StubNotification, () => {
    const host = new WebHostNotify({ minIntervalMs: 0 });
    return [host.notify("Finished"), host.notify("Needs input", "Please choose a file.")];
  });
  assert.deepEqual(result, [
    { ok: true, status: "sent", fallback: false },
    { ok: true, status: "sent", fallback: false },
  ]);
  assert.deepEqual(calls, [
    { title: "Finished", options: undefined },
    { title: "Needs input", options: { body: "Please choose a file." } },
  ]);
});

test("denied and unavailable Notification APIs use the fallback result", () => {
  class DeniedNotification {
    static permission = "denied" as const;

    constructor(_title: string) {}
  }
  const denied = withNotification(DeniedNotification, () => new WebHostNotify().notify("Denied"));
  assert.equal(denied.fallback, true);
  assert.equal(denied.error, "permission not granted");
  assert.equal(browserNotificationPermission(DeniedNotification), "denied");

  const unavailable = withNotification(undefined, () => new WebHostNotify().notify("Unavailable"));
  assert.deepEqual(unavailable, {
    ok: false,
    status: "fallback",
    fallback: true,
    error: "permission not granted",
  });
  assert.equal(browserNotificationPermission(undefined), "unavailable");
});

test("settings permission helper is the only path that calls requestPermission", async () => {
  let requested = 0;
  class StubNotification {
    static permission = "default" as const;
    static requestPermission = async () => {
      requested += 1;
      return "granted" as const;
    };

    constructor(_title: string) {}
  }

  const permission = await requestBrowserNotificationPermission(StubNotification);
  assert.equal(permission, "granted");
  assert.equal(requested, 1);
});

test("notify strips controls and caps title/body before constructing a notification", () => {
  const calls: Array<{ title: string; options?: { body?: string } }> = [];
  class StubNotification {
    static permission = "granted" as const;

    constructor(title: string, options?: { body?: string }) {
      calls.push({ title, options });
    }
  }

  const title = `a\n\u0000${"b".repeat(NOTIFY_TITLE_MAX_LENGTH + 20)}`;
  const body = `c\r\n\u0001${"d".repeat(NOTIFY_BODY_MAX_LENGTH + 20)}`;
  const result = withNotification(StubNotification, () =>
    new WebHostNotify({ minIntervalMs: 0 }).notify(title, body),
  );

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].title.length, NOTIFY_TITLE_MAX_LENGTH);
  assert.equal(calls[0].options?.body?.length, NOTIFY_BODY_MAX_LENGTH);
  assert.equal(calls[0].title.includes("\n"), false);
  assert.equal(calls[0].title.includes("\0"), false);
  assert.equal(calls[0].options?.body?.includes("\r"), false);
  assert.equal(calls[0].options?.body?.includes("\x01"), false);
});

test("notify rate-limits attempts at the host seam", () => {
  let now = 1000;
  let constructed = 0;
  class StubNotification {
    static permission = "granted" as const;

    constructor(_title: string) {
      constructed += 1;
    }
  }

  const result = withNotification(StubNotification, () => {
    const host = new WebHostNotify({ now: () => now });
    const first = host.notify("one");
    const limited = host.notify("two");
    now += NOTIFY_MIN_INTERVAL_MS;
    const third = host.notify("three");
    return [first, limited, third];
  });
  assert.equal(result[0].ok, true);
  assert.deepEqual(result[1], {
    ok: false,
    status: "rate-limited",
    fallback: false,
    error: "notification rate limited",
  });
  assert.equal(result[2].ok, true);
  assert.equal(constructed, 2);
});
