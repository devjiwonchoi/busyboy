import type { FocusTarget } from "../src/lib/focus-target";
import type { AttentionUpdate } from "../src/server/attention";
import { followAttention } from "./attention-stream";
import { notificationFor, showNotification } from "./notifications";
import type { ServerHandle } from "./server-process";
import { attentionCount, createTray, setBadge } from "./tray";

export type BackgroundOptions = {
  open: (target?: FocusTarget) => void;
  quit: () => void;
  installUpdate: () => void;
  windowInFront: () => boolean;
  notify?: boolean;
};

export function startBackground(server: ServerHandle, options: BackgroundOptions) {
  const tray = createTray({
    open: options.open,
    quit: options.quit,
    installUpdate: options.installUpdate,
  });
  let updates = 0;

  const refreshBadge = () => setBadge(options.windowInFront() ? 0 : attentionCount(tray.state()));

  const onUpdate = (update: AttentionUpdate) => {
    updates++;
    if (update.type === "state") {
      tray.update({ tasks: update.tasks });
      refreshBadge();
      return;
    }
    const inFront = options.windowInFront();
    if (update.event.kind === "director-replied" && !inFront) {
      tray.update({ directorReplied: true });
      refreshBadge();
    }
    if (!inFront && options.notify !== false)
      showNotification(notificationFor(update.event), options.open);
  };

  const stopFollowing = followAttention(server, onUpdate);

  return {
    tray,
    updates: () => updates,
    windowFocused() {
      if (tray.state().directorReplied) tray.update({ directorReplied: false });
      setBadge(0);
    },
    // why: Electron may still report the window as focused while it emits the blur.
    windowBlurred: () => void setImmediate(refreshBadge),
    updateReady: (version: string) => tray.update({ updateVersion: version }),
    stop() {
      stopFollowing();
      setBadge(0);
      tray.destroy();
    },
  };
}

export type Background = ReturnType<typeof startBackground>;
