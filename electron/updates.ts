import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { autoUpdater } from 'electron-updater'

// Updates come from the repository's GitHub releases (.github/workflows/release.yml).
// A newer release is downloaded in the background as soon as it is found, and
// nothing else happens until the user asks: the window and the tray then offer
// one "Restart to update" action. An update is never installed mid-work by itself;
// one that was downloaded is also installed when the user quits.

const FIRST_CHECK_MS = 10_000
// Often enough that a release shows up while the user is still at the desk, as it did in
// 0.0.22 and earlier. Each check is one small request to GitHub's release feed.
const CHECK_EVERY_MS = 5 * 60_000

/** How long an install may take to close the app before it counts as not having happened. */
const INSTALL_TIMEOUT_MS = 60_000

export type UpdateOptions = {
  /** Called once a newer version has been downloaded and is ready to install. */
  onReady: (version: string) => void
  /**
   * Called before the app closes to install. It stops the server, so agents and terminals end
   * cleanly first: the Windows installer ends whatever still runs from the app's folder about
   * a second after it starts, which is less time than the server takes to stop its agents.
   */
  beforeInstall: () => Promise<void>
  /**
   * Called when the install did not close the app (the installer could not start, or macOS
   * could not prepare the update). The server is stopped by then, so the app has to start over.
   */
  installFailed: () => void
}

/**
 * Starts looking for updates. Does nothing in a build that has no update feed:
 * `pnpm dev:desktop`, and the unsigned folder that CI and `pnpm build:desktop`
 * make. electron-builder writes app-update.yml only into a release build.
 */
export function startUpdates(options: UpdateOptions) {
  let ready: string | null = null
  let installing = false
  const none = { readyVersion: () => ready, install: async () => {}, stop: () => {} }
  if (!app.isPackaged || !existsSync(join(process.resourcesPath, 'app-update.yml'))) return none

  autoUpdater.autoDownload = true
  // A downloaded update goes in on the next quit as well, without asking again.
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-downloaded', (info) => {
    ready = info.version
    options.onReady(info.version)
  })
  // Offline, rate limited, or a release still uploading: try again at the next check.
  autoUpdater.on('error', (error) => console.warn(`Could not check for updates: ${error.message}`))

  const check = () => void autoUpdater.checkForUpdates().catch(() => {})
  // After the window is up, so the check does not compete with starting the server.
  const first = setTimeout(check, FIRST_CHECK_MS)
  const every = setInterval(check, CHECK_EVERY_MS)

  return {
    readyVersion: () => ready,
    /** Closes the app, installs the downloaded update, and opens the new version. */
    async install() {
      // Once only: every call would add another listener for the same install.
      if (!ready || installing) return
      installing = true
      await options.beforeInstall()
      // Still here after this long means the app was never closed.
      setTimeout(options.installFailed, INSTALL_TIMEOUT_MS)
      autoUpdater.quitAndInstall()
    },
    stop() {
      clearTimeout(first)
      clearInterval(every)
    },
  }
}

export type Updates = ReturnType<typeof startUpdates>
