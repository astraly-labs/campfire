/**
 * Desktop / OS notifications for inbox activity.
 *
 * Uses the Web Notifications API, which Electron maps to a native OS
 * notification in the renderer (and which works directly in a browser). No IPC
 * bridge is needed — the same code path lights up the desktop app and a
 * regular tab.
 *
 * Side effects live here (not in the Zustand reducer) so the store stays pure
 * and unit-testable; the inbox live-sync hook calls into this module.
 *
 * @module notifications/desktopNotifications
 */
import type { InboxItem } from "@t3tools/contracts";

/** Guard so we only ever fire one permission prompt per page load. */
let permissionRequestInFlight: Promise<NotificationPermission> | null = null;

function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

/**
 * Ask for notification permission at most once. Safe to call eagerly on mount;
 * resolves to the current permission without prompting if the user already
 * decided. In a browser without a user gesture the prompt may be suppressed
 * (resolves "default") — that's a graceful no-op, the in-app badge still works.
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  if (!permissionRequestInFlight) {
    permissionRequestInFlight = Notification.requestPermission().catch(
      () => "denied" as NotificationPermission,
    );
  }
  return (await permissionRequestInFlight) === "granted";
}

/**
 * True when the app is backgrounded — we only raise an OS notification if the
 * user isn't already looking at the window, to avoid doubling up with the
 * in-app inbox they can already see.
 */
function appIsBackgrounded(): boolean {
  if (typeof document === "undefined") return false;
  if (document.hidden) return true;
  return typeof document.hasFocus === "function" ? !document.hasFocus() : false;
}

function titleFor(item: InboxItem): string {
  const author = item.lastAuthor.displayName;
  return item.kind === "mention" ? `${author} vous a mentionné` : `Nouveau message de ${author}`;
}

/**
 * Raise an OS notification for a freshly-arrived inbox item, if the app is
 * backgrounded and permission allows. The `tag` collapses repeated
 * notifications for the same side-thread so they replace rather than stack.
 * Clicking focuses the app window.
 */
export function notifyInboxItem(item: InboxItem): void {
  if (!notificationsSupported()) return;
  if (!appIsBackgrounded()) return;
  void ensureNotificationPermission().then((granted) => {
    if (!granted) return;
    try {
      const notification = new Notification(titleFor(item), {
        body: item.lastPreview,
        tag: `inbox:${item.kind}:${item.sideThreadId}`,
      });
      notification.addEventListener(
        "click",
        () => {
          try {
            window.focus();
          } catch {
            // best-effort focus; ignore environments that disallow it
          }
          notification.close();
        },
        { once: true },
      );
    } catch {
      // Notification construction can throw on some platforms — never let a
      // notification failure break the live-sync pipeline.
    }
  });
}
