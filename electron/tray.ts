import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron'
import type { FocusTarget } from '../src/lib/focus-target'
import type { AttentionTask } from '../src/server/attention'

/** Longest task label in the menu; the menu bar menu grows as wide as its longest item. */
const LABEL_LIMIT = 48

export type TrayState = {
  tasks: AttentionTask[]
  /** The Director replied while the window was not in front, and the user has not looked since. */
  directorReplied: boolean
}

export type TrayActions = {
  open: (target?: FocusTarget) => void
  quit: () => void
}

export function shorten(text: string, limit = LABEL_LIMIT) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1).trimEnd()}…` : flat
}

export const taskLabel = (task: AttentionTask) => shorten(`${task.project} · ${task.title}`)

export const attentionCount = (state: TrayState) => state.tasks.length + (state.directorReplied ? 1 : 0)

/**
 * The tray icon, drawn here instead of shipped as image files so packaging has
 * nothing extra to copy: a ring when nothing needs the user, and a ring with a
 * filled center when something does. Shape carries the meaning because a
 * macOS template image is drawn in the menu bar's own color.
 */
function drawIcon(attention: boolean) {
  const mac = process.platform === 'darwin'
  // macOS menu bar icons are 16 pt; draw at 2x for Retina. Windows tray icons are 16 px at 100% scaling.
  const scale = mac ? 2 : 1
  const size = 16 * scale
  const [r, g, b] = mac ? [0, 0, 0] : attention ? [245, 158, 11] : [200, 200, 200]
  const center = size / 2
  const outer = 6.5 * scale
  const inner = 5 * scale
  const dot = 3 * scale
  const pixels = Buffer.alloc(size * size * 4)
  const SAMPLES = 4
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Supersample each pixel for smooth edges.
      let covered = 0
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const d = Math.hypot(x + (sx + 0.5) / SAMPLES - center, y + (sy + 0.5) / SAMPLES - center)
          if ((d <= outer && d >= inner) || (attention && d <= dot)) covered++
        }
      }
      const offset = (y * size + x) * 4
      // createFromBitmap takes BGRA.
      pixels[offset] = b
      pixels[offset + 1] = g
      pixels[offset + 2] = r
      pixels[offset + 3] = Math.round((covered / (SAMPLES * SAMPLES)) * 255)
    }
  }
  const image = nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: scale })
  if (mac) image.setTemplateImage(true)
  return image
}

export function trayMenuTemplate(state: TrayState, actions: TrayActions): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = []
  if (attentionCount(state) === 0) items.push({ label: 'Nothing needs you', enabled: false })
  else {
    items.push({ label: 'Needs you', enabled: false })
    if (state.directorReplied) items.push({ label: 'The Director replied', click: () => actions.open({ kind: 'director' }) })
    for (const task of state.tasks) {
      items.push({ label: taskLabel(task), click: () => actions.open({ kind: 'task', project: task.project, taskId: task.taskId }) })
    }
  }
  items.push(
    { type: 'separator' },
    { label: 'Open BusyBoy', click: () => actions.open() },
    { type: 'separator' },
    { label: 'Quit BusyBoy', click: () => actions.quit() },
  )
  return items
}

/** The menu bar (macOS) or notification area (Windows) icon and its menu. */
export function createTray(actions: TrayActions) {
  const icons = { idle: drawIcon(false), attention: drawIcon(true) }
  const tray = new Tray(icons.idle)
  let state: TrayState = { tasks: [], directorReplied: false }
  let labels: string[] = []

  const render = () => {
    const count = attentionCount(state)
    tray.setImage(count > 0 ? icons.attention : icons.idle)
    tray.setToolTip(count > 0 ? `BusyBoy: ${count} need${count === 1 ? 's' : ''} you` : 'BusyBoy')
    // The count beside the icon in the macOS menu bar; Windows has no tray title.
    if (process.platform === 'darwin') tray.setTitle(count > 0 ? String(count) : '')
    const template = trayMenuTemplate(state, actions)
    labels = template.flatMap((item) => (item.label ? [item.label] : []))
    tray.setContextMenu(Menu.buildFromTemplate(template))
  }

  // On Windows a left click on a tray icon is expected to open the app; the right click shows the menu.
  if (process.platform === 'win32') tray.on('click', () => actions.open())
  render()

  return {
    update(next: Partial<TrayState>) {
      state = { ...state, ...next }
      render()
    },
    state: () => state,
    /** The menu's labels, for the self-check. */
    menuLabels: () => labels,
    destroy: () => tray.destroy(),
  }
}

export type DesktopTray = ReturnType<typeof createTray>

/** The dock badge on macOS, like T3 Code's: the count while the window is in the background, nothing while it is in front. */
export function setBadge(count: number) {
  if (process.platform === 'darwin') app.setBadgeCount(count)
}
