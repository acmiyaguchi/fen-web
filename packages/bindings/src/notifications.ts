// Browser notification host seam. Permission is intentionally read-only here:
// Notification.requestPermission() must be called by the shell from a user
// gesture, never from an agent tool call.

export type NotificationPermissionState = "default" | "denied" | "granted";

export interface NotificationConstructor {
  readonly permission: NotificationPermissionState;
  new (title: string, options?: { body?: string }): unknown;
  requestPermission?: () => Promise<NotificationPermissionState>;
}

export interface BrowserNotificationResult {
  ok: boolean;
  status: "sent" | "fallback" | "rate-limited";
  /** True when the caller should surface an in-app transcript notice. */
  fallback: boolean;
  error?: string;
}

export interface HostNotify {
  notify(title: string, body?: string): BrowserNotificationResult;
}

export interface WebHostNotifyOptions {
  /** Injectable in Node tests; production uses globalThis.Notification. */
  notification?: NotificationConstructor;
  /** Injectable clock for deterministic rate-limit tests. */
  now?: () => number;
  /** Minimum spacing between host attempts, in milliseconds. */
  minIntervalMs?: number;
}

export const NOTIFY_MIN_INTERVAL_MS = 3000;
export const NOTIFY_TITLE_MAX_LENGTH = 120;
export const NOTIFY_BODY_MAX_LENGTH = 500;

/** Remove ASCII controls and bound notification text before it reaches either
 * the browser API or the transcript. Array.from counts Unicode code points,
 * so the limit does not split a surrogate pair. */
export function sanitizeNotificationText(value: unknown, maxLength: number): string {
  return Array.from(String(value).replace(/[\u0000-\u001f]/g, ""))
    .slice(0, maxLength)
    .join("");
}

function globalNotification(): NotificationConstructor | undefined {
  const value = (globalThis as typeof globalThis & { Notification?: unknown }).Notification;
  return typeof value === "function" ? (value as NotificationConstructor) : undefined;
}

/** Return the current browser permission without prompting. */
export function browserNotificationPermission(
  notification: NotificationConstructor | undefined = globalNotification(),
): NotificationPermissionState | "unavailable" {
  if (!notification) return "unavailable";
  try {
    const permission = notification.permission;
    return permission === "granted" || permission === "denied" || permission === "default"
      ? permission
      : "unavailable";
  } catch {
    return "unavailable";
  }
}

/** Request permission for the settings panel's user-gesture handler only. */
export async function requestBrowserNotificationPermission(
  notification: NotificationConstructor | undefined = globalNotification(),
): Promise<NotificationPermissionState | "unavailable"> {
  const permission = browserNotificationPermission(notification);
  if (permission !== "default") return permission;
  if (!notification?.requestPermission) return "unavailable";
  try {
    const requested = await notification.requestPermission();
    return requested === "granted" || requested === "denied" || requested === "default"
      ? requested
      : "unavailable";
  } catch {
    return "unavailable";
  }
}

/**
 * Browser implementation of host.notify. It never requests permission and
 * never throws for a normal Notification API failure: the Fennel tool can
 * turn `fallback: true` into an in-app transcript notice instead.
 */
export class WebHostNotify implements HostNotify {
  private readonly notification: NotificationConstructor | undefined;
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private lastAttempt = Number.NEGATIVE_INFINITY;

  constructor(options: WebHostNotifyOptions = {}) {
    this.notification = options.notification ?? globalNotification();
    this.now = options.now ?? (() => performance.now());
    this.minIntervalMs = Math.max(
      0,
      Math.floor(options.minIntervalMs ?? NOTIFY_MIN_INTERVAL_MS),
    );
  }

  notify(title: string, body?: string): BrowserNotificationResult {
    const safeTitle = sanitizeNotificationText(title, NOTIFY_TITLE_MAX_LENGTH);
    const safeBody =
      body === undefined ? undefined : sanitizeNotificationText(body, NOTIFY_BODY_MAX_LENGTH);
    const now = this.now();
    if (now < this.lastAttempt + this.minIntervalMs) {
      return {
        ok: false,
        status: "rate-limited",
        fallback: false,
        error: "notification rate limited",
      };
    }
    // This limiter is intentionally per WebHostNotify instance: it resets on
    // shell restart, which is not agent-exploitable because the agent cannot
    // create or restart the shell-owned host instance.
    // Rate-limit attempts, including permission-gated fallbacks, so a looping
    // agent cannot spam either the OS or the in-app notice path.
    this.lastAttempt = now;

    if (browserNotificationPermission(this.notification) !== "granted") {
      return {
        ok: false,
        status: "fallback",
        fallback: true,
        error: "permission not granted",
      };
    }

    try {
      new this.notification!(safeTitle, safeBody === undefined ? undefined : { body: safeBody });
      return { ok: true, status: "sent", fallback: false };
    } catch {
      return {
        ok: false,
        status: "fallback",
        fallback: true,
        error: "notification unavailable",
      };
    }
  }
}
