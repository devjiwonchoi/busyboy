import { Notification } from "electron";

import type { FocusTarget } from "../src/lib/focus-target";
import type { AttentionEvent } from "../src/server/attention";
import { shorten } from "./tray";

export type NotificationContent = { title: string; body: string; target: FocusTarget };

// why: A notification never includes a reply or tool output; that text can hold a secret on the lock screen.
export function notificationFor(event: AttentionEvent): NotificationContent {
  if (event.kind === "director-replied")
    return { title: "The Director replied", body: "", target: { kind: "director" } };
  const target: FocusTarget = { kind: "task", project: event.project, taskId: event.taskId };
  return {
    title: shorten(`${event.project} · ${event.title}`, 64),
    body: event.kind === "task-done" ? "Finished" : "Needs you",
    target,
  };
}

// why: Electron drops a Notification's click handler once the object is garbage collected.
const shown = new Set<Notification>();

export function showNotification(
  content: NotificationContent,
  open: (target: FocusTarget) => void,
) {
  if (!Notification.isSupported()) return false;
  const notification = new Notification({ title: content.title, body: content.body });
  shown.add(notification);
  notification.on("click", () => {
    shown.delete(notification);
    open(content.target);
  });
  notification.on("close", () => shown.delete(notification));
  notification.show();
  return true;
}
