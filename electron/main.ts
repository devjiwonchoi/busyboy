import { dirname, join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron'
import { FOCUS_CHANNEL, PICK_FOLDERS_CHANNEL } from '../src/lib/desktop-bridge'
import { FOCUS_PARAM, formatFocusTarget, type FocusTarget } from '../src/lib/focus-target'
import { SERVER_TOKEN_COOKIE } from '../src/lib/server-token'
import {
  createSelfCheck,
  createSelfCheckDataFolder,
  isolateSelfCheckProfile,
  SELF_CHECK_TIMEOUT_MS,
  selfCheckOutputPath,
} from './self-check'
import { startBackground, type Background } from './background'
import { serverEntry, startServer, type ServerHandle } from './server-process'
import { installLoginShellPath } from './shell-env'

const selfCheckPath = selfCheckOutputPath(process.argv)
if (selfCheckPath) isolateSelfCheckProfile()
let server: ServerHandle | null = null
let mainWindow: BrowserWindow | null = null
let background: Background | null = null
/** Set once a quit starts; until then closing the window only hides it. */
let quitting = false

// Permissions the app's own pages may use; everything else is denied.
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write'])

function isAppOrigin(url: string | undefined) {
  if (!server || !url) return false
  try {
    return new URL(url).origin === new URL(server.url).origin
  } catch {
    return false
  }
}

function openExternally(target: string) {
  if (/^https?:/.test(target)) void shell.openExternal(target)
}

function createWindow(url: string, show: boolean) {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    // The shadcn sidebar turns into a mobile sheet below 768px; stay above it.
    minWidth: 800,
    minHeight: 480,
    show: false,
    title: 'BusyBoy',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, 'preload.cjs'),
    },
  })

  // Leave room for the macOS traffic lights in the custom title bar.
  if (process.platform === 'darwin') {
    window.webContents.on('dom-ready', () => {
      void window.webContents.insertCSS(':root { --title-bar-inset: 80px; }')
    })
  }

  // Keep the window and its frames on the app; open other links in the default browser.
  // will-frame-navigate also fires for the main frame, which will-navigate
  // already handles, so it only guards subframes; this opens a link once.
  const guard = (event: Electron.Event<{ url: string; isMainFrame: boolean }>) => {
    if (isAppOrigin(event.url)) return
    event.preventDefault()
    if (event.isMainFrame) openExternally(event.url)
  }
  window.webContents.on('will-navigate', guard)
  window.webContents.on('will-redirect', guard)
  window.webContents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame) guard(event)
  })
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    openExternally(target)
    return { action: 'deny' }
  })

  // Closing the window leaves BusyBoy and its agents working in the tray; only Quit ends them.
  window.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    window.hide()
  })
  // Windows ends the session (log off, shut down) without \`before-quit\`, so
  // the hidden-window rule above would keep agents from being stopped.
  window.on('session-end', () => {
    quitting = true
    app.quit()
  })

  if (show) window.once('ready-to-show', () => window.show())
  void window.loadURL(url)
  return window
}

/** The main screen URL, opened on `target` when given. */
function screenUrl(base: string, target?: FocusTarget) {
  if (!target) return base
  const url = new URL(base)
  url.searchParams.set(FOCUS_PARAM, formatFocusTarget(target))
  return url.toString()
}

/** Brings the one window to the front (making it again if it is gone) and shows `target` in it. */
function openWindow(target?: FocusTarget) {
  if (!server || quitting) return
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow(screenUrl(server.url, target), true)
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  // The open page shows it in place, so a draft in the composer is kept.
  if (target) mainWindow.webContents.send(FOCUS_CHANNEL, formatFocusTarget(target))
}

function windowInFront() {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && mainWindow.isFocused())
}

async function authorizeWindowSession(handle: ServerHandle) {
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission) && isAppOrigin(contents.getURL()))
  })
  session.defaultSession.setPermissionCheckHandler(
    (_contents, permission, requestingOrigin) => ALLOWED_PERMISSIONS.has(permission) && isAppOrigin(requestingOrigin),
  )
  await session.defaultSession.cookies.set({
    url: handle.url,
    name: SERVER_TOKEN_COOKIE,
    value: handle.token,
    httpOnly: true,
    sameSite: 'strict',
  })
}

async function runSelfCheck(outputPath: string) {
  const check = createSelfCheck()
  const removeDataFolder = createSelfCheckDataFolder()
  let finished = false
  // Write the result and exit exactly once, whether the check ends, fails, or hangs.
  const finish = () => {
    if (finished) return
    finished = true
    clearTimeout(watchdog)
    try {
      removeDataFolder()
    } catch (error) {
      console.error(error)
    }
    app.exit(check.write(outputPath) ? 0 : 1)
  }
  const watchdog = setTimeout(() => {
    check.fail(new Error(`The self-check did not finish within ${SELF_CHECK_TIMEOUT_MS} ms.`))
    finish()
  }, SELF_CHECK_TIMEOUT_MS)
  try {
    check.recordShellPath(await installLoginShellPath())
    check.snapshotServerFolder(dirname(serverEntry()))
    server = await startServer()
    await check.recordServer(server)
    await authorizeWindowSession(server)
    const window = (mainWindow = createWindow(server.url, false))
    await check.recordPage(window)
    // No notifications: the check may run on the user's own machine.
    background = startBackground(server, { open: openWindow, quit: () => {}, windowInFront, notify: false })
    await check.recordBackground(background, window, server)
    await check.recordTerminal(server)
    background.stop()
    background = null
    window.destroy()
    await check.recordServerStop(server)
    check.recordServerFolderUnchanged()
  } catch (error) {
    check.fail(error)
    background?.stop()
    await server?.stop()
  } finally {
    finish()
  }
}

async function launch() {
  const shellPath = await installLoginShellPath()
  if (shellPath.error) console.warn(`Using the inherited PATH: ${shellPath.error}`)
  server = await startServer()
  await authorizeWindowSession(server)
  mainWindow = createWindow(server.url, true)
  background = startBackground(server, { open: openWindow, quit: () => app.quit(), windowInFront })
  // Clicking the dock icon brings back a window that was closed to the tray.
  app.on('activate', () => openWindow())
}

/** The native folder picker behind the preload bridge. Only app pages may open it. */
function registerFolderPicker() {
  ipcMain.handle(PICK_FOLDERS_CHANNEL, async (event) => {
    if (!isAppOrigin(event.senderFrame?.url)) return []
    const window = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Add projects',
      buttonLabel: 'Add',
      properties: ['openDirectory', 'multiSelections', 'createDirectory'],
    }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return result.canceled ? [] : result.filePaths
  })
}

/** When the server stop began, or 0 before a quit. */
let stopping = 0
/** Longer than the server's own stop budget (shutdown message, then kill), so one slow stop is not cut short. */
const STALLED_SHUTDOWN_MS = 12_000

function registerAppEvents() {
  app.on('second-instance', () => openWindow())

  // BusyBoy stays in the tray with no window open. Registering the listener
  // keeps Electron from quitting when the last window closes.
  app.on('window-all-closed', () => {})

  app.on('browser-window-focus', () => background?.windowFocused())
  app.on('browser-window-blur', () => background?.windowBlurred())

  app.on('before-quit', () => {
    quitting = true
  })

  // Stop the server, which stops every agent and terminal, before the app exits.
  app.on('will-quit', (event) => {
    if (!server?.isRunning()) return
    event.preventDefault()
    // Like T3 Code: a quit asked for again after a stalled shutdown is the
    // user's only way out short of force quitting, so it exits at once.
    if (stopping) {
      if (Date.now() - stopping >= STALLED_SHUTDOWN_MS) app.exit(0)
      return
    }
    stopping = Date.now()
    background?.stop()
    background = null
    // Exit rather than quit again: a server that did not stop in time must
    // not leave a hidden app with no tray icon and no window.
    void server.stop().finally(() => app.exit(0))
  })

  // `kill` or Ctrl+C in the terminal that started the app quits it the same way as the menu.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => app.quit())

  void app.whenReady().then(async () => {
    registerFolderPicker()
    if (selfCheckPath) {
      await runSelfCheck(selfCheckPath)
      return
    }
    try {
      await launch()
    } catch (error) {
      // Apps opened from Finder have no visible output, so say why on screen.
      console.error(error)
      dialog.showErrorBox('BusyBoy could not start', error instanceof Error ? error.message : String(error))
      await server?.stop()
      app.exit(1)
    }
  })
}

// A second copy hands focus to the first one and exits without starting anything.
if (selfCheckPath || app.requestSingleInstanceLock()) {
  registerAppEvents()
} else {
  app.quit()
}
