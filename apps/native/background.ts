import type { ServerHandle } from "./server-process";
import { attentionCount, createTray, setBadge } from "./tray";

export type BackgroundOptions = {
  open: () => void;
  quit: () => void;
  installUpdate: () => void;
  windowInFront: () => boolean;
  notify?: boolean;
};

export function startBackground(_server: ServerHandle, options: BackgroundOptions) {
  const tray = createTray({
    open: options.open,
    quit: options.quit,
    installUpdate: options.installUpdate,
  });

  const refreshBadge = () => setBadge(options.windowInFront() ? 0 : attentionCount(tray.state()));

  return {
    tray,
    updates: () => 0,
    windowFocused() {
      if (tray.state().directorReplied) tray.update({ directorReplied: false });
      setBadge(0);
    },
    windowBlurred: () => void setImmediate(refreshBadge),
    updateReady: (version: string) => tray.update({ updateVersion: version }),
    stop() {
      setBadge(0);
      tray.destroy();
    },
  };
}

export type Background = ReturnType<typeof startBackground>;
