import { app, BrowserWindow, session, shell } from 'electron'
import { SERVER_TOKEN_COOKIE } from '../lib/server-token'
import { createSelfCheck, selfCheckOutputPath } from './self-check'
import { startServer, type ServerHandle } from './server-process'
import { installLoginShellPath } from './shell-env'

const selfCheckPath = selfCheckOutputPath(process.argv)
let server: ServerHandle | null = null

if (!selfCheckPath && !app.requestSingleInstanceLock()) {
  app.quit()
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

  // Keep the window on the app; open other links in the default browser.
  const origin = new URL(url).origin
  window.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin === origin) return
    event.preventDefault()
    if (/^https?:/.test(target)) void shell.openExternal(target)
  })
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/.test(target)) void shell.openExternal(target)
    return { action: 'deny' }
  })

  if (show) window.once('ready-to-show', () => window.show())
  void window.loadURL(url)
  return window
}

async function authorizeWindowSession(handle: ServerHandle) {
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
let stopping = false
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
    console.error(error)
    app.exit(1)
  }
})
