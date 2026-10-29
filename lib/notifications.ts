/**
 * Desktop notifications for replies that land while the user is looking elsewhere.
 *
 * Shown only when the tab is hidden, or the reply belongs to a conversation that is not open.
 * One notification per conversation (`tag`), so a multi-part reply updates it rather than
 * stacking a pile of them.
 */

export type NotificationState = NotificationPermission | "unsupported";

export function notificationState(): NotificationState {
  return typeof window !== "undefined" && "Notification" in window ? Notification.permission : "unsupported";
}

export async function requestNotifications(): Promise<NotificationState> {
  if (notificationState() === "unsupported") return "unsupported";
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/** Plain text for a notification body: markdown and code fences removed, clipped. */
export function notificationPreview(text: string, limit = 140) {
  const plain = text
    .replace(/```(?:file:([^\n]+)|svg)?[\s\S]*?(```|$)/g, (_match, name?: string) => name ? `[file: ${name.trim()}]` : "[attachment]")
    .replace(/[#*_>`~|]/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > limit ? `${plain.slice(0, limit - 1).trimEnd()}…` : plain;
}

export function showNotification(title: string, body: string, tag: string, onClick: () => void) {
  if (notificationState() !== "granted") return;
  try {
    const notification = new Notification(title, { body, tag, silent: false });
    notification.onclick = () => {
      window.focus();
      onClick();
      notification.close();
    };
  } catch {
    // Some platforms only allow notifications from a service worker; the in-page badge remains.
  }
}
