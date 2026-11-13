import { app, BrowserWindow, dialog, session, shell } from 'electron'
import { SERVER_TOKEN_COOKIE } from '../lib/server-token'
import { createSelfCheck, selfCheckOutputPath } from './self-check'
import { startServer, type ServerHandle } from './server-process'
import { installLoginShellPath } from './shell-env'

const selfCheckPath = selfCheckOutputPath(process.argv)
let server: ServerHandle | null = null

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
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'Busyboy',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  // Leave room for the macOS traffic lights in the custom title bar.
  if (process.platform === 'darwin') {
    window.webContents.on('dom-ready', () => {
      void window.webContents.insertCSS(':root { --title-bar-inset: 80px; }')
    })
  }

  // Keep the window and its frames on the app; open other links in the default browser.
  const guard = (event: Electron.Event<{ url: string; isMainFrame: boolean }>) => {
    if (isAppOrigin(event.url)) return
    event.preventDefault()
    if (event.isMainFrame) openExternally(event.url)
  }
  window.webContents.on('will-navigate', guard)
  window.webContents.on('will-frame-navigate', guard)
  window.webContents.on('will-redirect', guard)
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    openExternally(target)
    return { action: 'deny' }
  })

  if (show) window.once('ready-to-show', () => window.show())
  void window.loadURL(url)
  return window
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
  try {
    check.recordShellPath(await installLoginShellPath())
    server = await startServer()
    await check.recordServer(server)
    await authorizeWindowSession(server)
    const window = createWindow(server.url, false)
    await check.recordPage(window)
    await check.recordTerminal(server)
    window.destroy()
    await check.recordServerStop(server)
  } catch (error) {
    check.fail(error)
    await server?.stop()
  }
  const ok = check.write(outputPath)
  app.exit(ok ? 0 : 1)
}

async function launch() {
  await installLoginShellPath()
  server = await startServer()
  await authorizeWindowSession(server)
  const url = server.url
  createWindow(url, true)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(url, true)
  })
}

let stopping = false

function registerAppEvents() {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.focus()
  })

  app.on('window-all-closed', () => {
    if (!selfCheckPath) app.quit()
  })

  // Stop the server before the app exits.
  app.on('will-quit', (event) => {
    if (!server?.isRunning() || stopping) return
    event.preventDefault()
    stopping = true
    void server.stop().finally(() => app.quit())
  })

  void app.whenReady().then(async () => {
    if (selfCheckPath) {
      await runSelfCheck(selfCheckPath)
      return
    }
    try {
      await launch()
    } catch (error) {
      // Apps opened from Finder have no visible output, so say why on screen.
      console.error(error)
      dialog.showErrorBox('Busyboy could not start', error instanceof Error ? error.message : String(error))
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
