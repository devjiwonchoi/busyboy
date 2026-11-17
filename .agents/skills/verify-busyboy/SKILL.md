---
name: verify-busyboy
description: Drive the real BusyBoy app from an empty data folder with the scripted provider replays, on the web surface and, when a display is available, the Electron window over CDP. Use when a UI change needs proof, or when checking that a running BusyBoy is the instance this verification run started.
---

# Verify BusyBoy

Drive the real BusyBoy UI the way a person does, then keep the screenshot, video, and logs. The commands below are the ones this repo ships. `pnpm verify` runs `node scripts/verify.mts`, which starts `scripts/verify-supervisor.mts` and talks to that process. Do not start the supervisor yourself.

Two output folders are two instances. They do not share a port or a data folder. Never drive an instance that this run did not launch.

A name passed to `--name` is a case-insensitive substring of the accessible name, which is how Playwright matches roles. Pass `--exact` when the name is a prefix of another control. `Reply` without `--exact` also matches `Reply in progress`.

## Launch

Build once, from the repository root, so the standalone server exists:

```
pnpm build
```

The Electron surface also needs `pnpm build:electron`.

Launch the web surface. This is the surface that replays `tests/provider-scripts` and records video:

```
pnpm verify launch --surface web --out <dir>
```

`--surface` defaults to `web`. `--out` can be omitted when `BUSYBOY_VERIFY_OUT` is set. The directory must be outside the git worktree so the evidence is not committed.

Launch prints JSON with `url`, `dataDir`, `outDir`, `buildId`, `gitSha`, `scripted: true`, and `logDir`. It returns only after the Director chat is usable: the log named `Transcript` has `data-connected="true"` and the textbox named `Message` is visible. A process that merely accepts HTTP is not ready.

The data folder is a new empty temporary directory. Launch then writes the verification seed into it: `verify.json` naming this process, `app-settings.json` with setup already finished, `defaultProvider` set to `claude`, and two git repositories named `web` and `api`. The real `~/.busyboy` is not used. Claude, Codex, and Grok config directories point inside the data folder. `BUSYBOY_GH_PATH` is `tests/fake-gh/gh`. There is no `BUSYBOY_TOKEN`, so the scripted provider runs. Only the top-level JSON files in `tests/provider-scripts` are replays, and those replays are Claude. Codex and Grok scripts live in subfolders the runner does not load.

The Electron surface:

```
pnpm build:electron
pnpm verify launch --surface electron --out <dir>
```

Electron is covered when this command reaches a usable chat. The supervisor starts `electron` with `--remote-debugging-port` and a throwaway `--user-data-dir`, then Playwright connects over CDP. If `DISPLAY` is unset it starts Xvfb on display `:99` and stops that Xvfb on cleanup. The desktop app sets a launch token, which turns test mode off, so provider scripts do not run. `scripted` is `false`. Do not send a chat message on this surface unless you mean to reach a real CLI. Video recording is not available. Screenshots and the drive commands are.

## Doctor

Run this before driving whenever something looks wrong:

```
pnpm verify doctor --out <dir>
```

Exit `0` and `"ok": true` mean this instance is worth driving. Exit `1` prints the reasons. Doctor is read-only. It checks all of the following:

- The session file `<out>/session.json` belongs to a live `verify-supervisor.mts` process.
- The app process is still the recorded pid, and its command line still contains the mark stored at launch (`start-standalone.mts` on the web, the remote-debugging port on Electron).
- The app port is bound to loopback and the listening pid is that app process or a descendant of the supervisor.
- The control port belongs to the supervisor.
- `.next/BUILD_ID` and `git rev-parse HEAD` still match the build that was launched. A mismatch means relaunch.
- On the web, the app process has `BUSYBOY_HOME` set to this run's data folder, `BUSYBOY_TEST_MODE=1`, and no `BUSYBOY_TOKEN`.
- The open page title contains `BusyBoy`, and the current screen is usable. On `/` that means the transcript is connected and the message box is visible. On `/settings` the main region named `Settings` is visible. On `/setup` the main region named `Setup` is visible.

## Drive

Prefer these handles. The viewport is 1280 by 720, so the chat sidebar is visible.

Open a route on this instance:

```
pnpm verify open --out <dir> --path /
pnpm verify open --out <dir> --path /settings
pnpm verify open --out <dir> --path "/settings?section=appearance"
```

The path must start with `/` and stay on this origin.

Click, fill, and wait:

```
pnpm verify fill --out <dir> --role textbox --name Message --value "What does git worktree do? Answer in one sentence."
pnpm verify click --out <dir> --role button --name Send
pnpm verify wait --out <dir> --role log --name Transcript --attr data-status --value idle
pnpm verify wait --out <dir> --role group --name Reply --exact
pnpm verify text --out <dir> --role group --name Reply --exact
```

`text` prints the visible text of that role. `wait` defaults to visible. `--state` is `visible`, `hidden`, or `attached`. With `--attr`, it waits until that attribute equals `--value`.

Keyboard, for the terminal after it has focus:

```
pnpm verify press --out <dir> --key Enter
pnpm verify type --out <dir> --text "echo busyboy-ok"
```

`--force` is only for a control whose hit target is the surrounding label, such as the theme radios. The accessible name still has to match.

A prompt that is not an exact turn in `tests/provider-scripts/*.json` does not call a model. The transcript shows `No claude script has a turn for: ...`. Copy the prompt from the feature file, including spaces.

## Evidence

Proof shows the action and the state it produced, plus a side effect when the feature writes one. The scripted providers are the production boundary the app already uses in its journeys. Do not drive through a test-only setter.

Capture both an ARIA snapshot and a screenshot while the app identity is on screen. The title bar text is `BusyBoy`.

```
pnpm verify snapshot --out <dir> --path director-reply.aria.txt
pnpm verify screenshot --out <dir> --path director-reply.png
pnpm verify video save --out <dir> --path director-reply.webm
```

Relative paths resolve inside `--out`. A path that escapes that directory is rejected. `video save` exists on the web surface. It closes the page to finish the WebM, writes the file, then opens the same URL again and waits until that screen is usable. Chat state that was saved in the data folder is still there. Electron has no video; use a screenshot.

Logs, which cleanup does not delete:

- `<out>/logs/server.log`
- `<out>/logs/browser.log`
- `<out>/logs/supervisor.log`

A launch that opened a window and then failed leaves `<out>/launch-failure.png`.

Cleanup also writes `<out>/video/session.webm` for the web surface, covering the time since the last `video save` (or since launch, if you did not save one).

## Cleanup

```
pnpm verify cleanup --out <dir>
```

Cleanup asks the supervisor to close the browser, save the session video on the web surface, and exit. It then signals only the pids recorded in `session.json` whose executable and command line still match. It deletes the data folder only when that folder's `verify.json` names this supervisor pid. The output folder, including screenshots, video, logs, and `session.json`, stays.

After cleanup, `pnpm verify doctor --out <dir>` reports that the instance has been cleaned up. The evidence files are still in `--out`.

If the supervisor is already gone, cleanup still signals leftover recorded processes and removes the data folder when the marker matches.

## Helpers

`pnpm verify` with no command prints the command list. `pnpm verify doctor` is the check to run first. `pnpm verify launch` refuses to start a second instance into an output folder whose supervisor is still alive.

Feature recipes live in [features/README.md](features/README.md). Read the index, then the feature file, and drive that file's entry points. A proof of one entry point does not cover the others.

When the app changes, update the feature file in the same change. `/maintain-verification-skill` is the loop for keeping this map honest.
