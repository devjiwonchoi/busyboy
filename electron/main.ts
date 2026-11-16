import { dirname, join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron'
import { PICK_FOLDERS_CHANNEL } from '../src/lib/desktop-bridge'
import { SERVER_TOKEN_COOKIE } from '../src/lib/server-token'
import {
  createSelfCheck,
  createSelfCheckDataFolder,
  isolateSelfCheckProfile,
  SELF_CHECK_TIMEOUT_MS,
  selfCheckOutputPath,
} from './self-check'
import { serverEntry, startServer, type ServerHandle } from './server-process'
import { installLoginShellPath } from './shell-env'

const selfCheckPath = selfCheckOutputPath(process.argv)
if (selfCheckPath) isolateSelfCheckProfile()
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
    const window = createWindow(server.url, false)
    await check.recordPage(window)
    await check.recordTerminal(server)
    window.destroy()
    await check.recordServerStop(server)
    check.recordServerFolderUnchanged()
  } catch (error) {
    check.fail(error)
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
  const url = server.url
  createWindow(url, true)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(url, true)
  })
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
