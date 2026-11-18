import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from "electron";

export type TrayState = {
  directorReplied: boolean;
  updateVersion?: string | null;
};

export type TrayActions = {
  open: () => void;
  quit: () => void;
  installUpdate: () => void;
};

export const attentionCount = (state: TrayState) => (state.directorReplied ? 1 : 0);

function drawIcon(attention: boolean) {
  const mac = process.platform === "darwin";
  const scale = mac ? 2 : 1;
  const size = 16 * scale;
  const [r, g, b] = mac ? [0, 0, 0] : attention ? [245, 158, 11] : [200, 200, 200];
  const center = size / 2;
  const outer = 6.5 * scale;
  const inner = 5 * scale;
  const dot = 3 * scale;
  const pixels = Buffer.alloc(size * size * 4);
  const SAMPLES = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let covered = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const d = Math.hypot(
            x + (sx + 0.5) / SAMPLES - center,
            y + (sy + 0.5) / SAMPLES - center,
          );
          if ((d <= outer && d >= inner) || (attention && d <= dot)) covered++;
        }
      }
      const offset = (y * size + x) * 4;
      pixels[offset] = b;
      pixels[offset + 1] = g;
      pixels[offset + 2] = r;
      pixels[offset + 3] = Math.round((covered / (SAMPLES * SAMPLES)) * 255);
    }
  }
  const image = nativeImage.createFromBitmap(pixels, {
    width: size,
    height: size,
    scaleFactor: scale,
  });
  if (mac) image.setTemplateImage(true);
  return image;
}

function trayMenuTemplate(state: TrayState, actions: TrayActions): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [];
  if (attentionCount(state) === 0) items.push({ label: "Nothing needs you", enabled: false });
  else {
    items.push({ label: "Needs you", enabled: false });
    if (state.directorReplied)
      items.push({
        label: "The Director replied",
        click: () => actions.open(),
      });
  }
  items.push({ type: "separator" });
  if (state.updateVersion)
    items.push({
      label: `Restart to update to ${state.updateVersion}`,
      click: () => actions.installUpdate(),
    });
  items.push(
    { label: "Open BusyBoy", click: () => actions.open() },
    { type: "separator" },
    { label: "Quit BusyBoy", click: () => actions.quit() },
  );
  return items;
}

export function createTray(actions: TrayActions) {
  const icons = { idle: drawIcon(false), attention: drawIcon(true) };
  const tray = new Tray(icons.idle);
  let state: TrayState = { directorReplied: false };
  let labels: string[] = [];

  const render = () => {
    const count = attentionCount(state);
    tray.setImage(count > 0 ? icons.attention : icons.idle);
    tray.setToolTip(count > 0 ? `BusyBoy: ${count} need${count === 1 ? "s" : ""} you` : "BusyBoy");
    if (process.platform === "darwin") tray.setTitle(count > 0 ? String(count) : "");
    const template = trayMenuTemplate(state, actions);
    labels = template.flatMap((item) => (item.label ? [item.label] : []));
    tray.setContextMenu(Menu.buildFromTemplate(template));
  };

  if (process.platform === "win32") tray.on("click", () => actions.open());
  render();

  return {
    update(next: Partial<TrayState>) {
      state = { ...state, ...next };
      render();
    },
    state: () => state,
    menuLabels: () => labels,
    destroy: () => tray.destroy(),
  };
}

export function setBadge(count: number) {
  if (process.platform === "darwin") app.setBadgeCount(count);
}
