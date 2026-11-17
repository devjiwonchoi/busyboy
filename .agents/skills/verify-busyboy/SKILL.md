---
name: verify-busyboy
description: Drive BusyBoy's chat, cards, and settings the way a person does, and capture screenshots and video as proof. Use after a UI change, before opening a pull request, and whenever a running BusyBoy instance needs a health check.
---

# Verify BusyBoy

BusyBoy's primary surface is the Next.js app in a browser. The desktop app is an Electron window around that app. This skill launches one isolated instance, drives it with `pnpm drive`, and stores proof under `.verify/evidence`. Read `features/README.md` before choosing a journey. Drive the feature that changed, and also the other entry points that feature file lists when the change can affect them.

The Next surface was executed end to end: launch, doctor, the Director chat send journey, screenshot, ARIA dump, video, and cleanup. The Electron surface is implemented and stops with a clear error until `pnpm build` and `pnpm build:electron` have produced the desktop bundle. A successful Electron window was not part of that execution.

## Launch

From the repository root:

```sh
pnpm drive launch
```

That starts the Next dev server and a headless Chromium window at 1280×820. Launch creates an empty temporary directory named `busyboy-verify-*` under the system temp directory and uses it as `BUSYBOY_HOME`. Before the server starts, launch writes the seed that makes that empty folder usable:

- `app-settings.json` with setup already finished, `defaultProvider` `claude`, theme `dark`, and one project named `web`
- a git repository at `projects/web` with a single commit on `main`
- `provider-scripts/`, a directory of symlinks to `tests/provider-scripts/*.json` and `scripts/drive-providers/*.json`

The server runs with `BUSYBOY_TEST_MODE=1` and without `BUSYBOY_TOKEN`, so those scripts are the Claude provider. `BUSYBOY_CODEX_PATH` and `BUSYBOY_GROK_PATH` point at missing files, so only Claude is signed in. `BUSYBOY_GH_PATH` is `tests/fake-gh/gh`. `CLAUDE_CONFIG_DIR` and `CODEX_HOME` sit inside the temporary directory, so the run does not read `~/.claude`, `~/.codex`, or `~/.busyboy`.

Launch is finished only when the app is usable. Usable means the page title contains BusyBoy, the log named `Transcript` has `data-connected="true"`, the text says `BusyBoy is ready. What should we work on?`, the link `BusyBoy, director` is visible, and the link `Settings` is visible. A process that merely accepts HTTP is not ready.

Launch prints the URL, the surface `next`, the data directory, `.verify/evidence`, and the Chrome DevTools Protocol websocket URL. A second `pnpm drive launch` while that keeper is alive exits with an error. Run `pnpm drive cleanup` first. One checkout drives one instance; the state file is `.verify/run.json`.

The desktop window:

```sh
pnpm drive launch --surface electron
```

This needs `dist-electron/main.cjs`, `dist-electron/preload.cjs`, and `.next/standalone/server.js`. Without them the command exits and names the missing files. `pnpm build` then `pnpm build:electron` produces them. Playwright launches Electron and attaches over the Chrome DevTools Protocol. The data directory is empty: no settings file and no provider-script seed. Ready means the heading `Pick a Director` is visible. The desktop server sets `BUSYBOY_TOKEN`, and BusyBoy ignores `BUSYBOY_PROVIDER_SCRIPTS` when that token is set, so the chat journeys below refuse this surface.

## Doctor

```sh
pnpm drive doctor
```

Doctor is read-only. It checks that the keeper is the process this run started, that the server process has this run's `BUSYBOY_HOME`, that the listening port is owned by a process in that tree, and that the page still identifies BusyBoy. On the Next surface it requires `BUSYBOY_PROVIDER_SCRIPTS` on the server, no `BUSYBOY_TOKEN`, and `data-connected="true"` on `Transcript`. On the Electron surface it requires the launch token and the heading `Pick a Director`. It also reports whether the desktop bundle is present and whether `tests/fake-gh/gh` is executable. Any line that starts with `problem:` means the instance is not worth driving. Exit code 0 means it is. Doctor does not click, type, or send.

## Drive

Prefer roles and accessible names. The handles below are the ones the journeys use.

| Handle            | Role         | Name                                    |
| ----------------- | ------------ | --------------------------------------- |
| Transcript        | `log`        | `Transcript`                            |
| Your message      | `group`      | `Your message`                          |
| Director reply    | `group`      | `Reply`                                 |
| Message field     | `textbox`    | `Message`                               |
| Send              | `button`     | `Send`                                  |
| Settings          | `link`       | `Settings`                              |
| Director row      | `link`       | `BusyBoy, director`                     |
| Settings page     | `main`       | `Settings`                              |
| Settings sections | `navigation` | `Settings sections`                     |
| Plan card         | `group`      | `Plan from web · Add a footer`          |
| Approve           | `button`     | `Approve`                               |
| Progress card     | `group`      | `Progress from web · Add a footer`      |
| Done card         | `group`      | `Done from web · Add a footer`          |
| Pull requests     | `group`      | `Pull requests from web · Add a footer` |
| Closed card       | `group`      | `Card from web · Add a footer`          |
| Task line         | `listitem`   | `web · Add a footer`                    |
| Message the task  | `button`     | `Message web · Add a footer`            |
| Companion         | `radio`      | `Ming the seal`                         |

The middle dot in those names is `·` (U+00B7).

Named steps:

```sh
pnpm drive step open-chat
pnpm drive step send-message --text "What does git worktree do? Answer in one sentence."
pnpm drive step open-settings
pnpm drive step approve-plan
pnpm drive step show-progress
pnpm drive step ship-footer
pnpm drive step merge-pulls
```

`send-message` needs `--text`. `approve-plan`, `show-progress`, `ship-footer`, and `merge-pulls` act on cards that an earlier step has already opened.

Journeys, each from a fresh `pnpm drive launch`:

```sh
pnpm drive journey director-send
pnpm drive journey approve-plan
pnpm drive journey progress-and-done
pnpm drive journey pr-card
pnpm drive journey settings
```

Smaller actions, when a feature file calls for them:

```sh
pnpm drive click --role button --name "Approve"
pnpm drive fill --role textbox --name "Message" --value "Ship the footer."
pnpm drive press --key Enter
pnpm drive wait --role log --name "Transcript" --attribute data-connected --value true
```

Chat and settings journeys exit with an error on the Electron surface. Do not reach for `/api/mcp` or any other test-only endpoint. The person path is the composer, the cards, and the settings links.

## Evidence

Proof is a screenshot and an ARIA dump of the action and the resulting state, plus the side effect the feature file names. One final screen is not enough. Mocks stay on boundaries the app already has: `BUSYBOY_PROVIDER_SCRIPTS` for Claude, Codex, and Grok, and `BUSYBOY_GH_PATH` for `gh`. The fake `gh` writes `.gh-merge.log` in the task worktree and does not contact GitHub. Read that log; do not treat the command name as proof that a merge happened or that the network was left untouched.

```sh
pnpm drive record start --name director-send
pnpm drive journey director-send
pnpm drive screenshot --name director-send
pnpm drive dump --name director-send
pnpm drive record stop
```

`--name` is lowercase letters, digits, and hyphens. Files land in `.verify/evidence/`:

- `director-send.png`
- `director-send.aria.txt`
- `director-send.webm`

`.verify/` is gitignored. The screenshot and the dump must show BusyBoy (the title, the transcript, or the settings heading) and the result of the action. Attach the screenshot to the pull request. The video is the same session, encoded by `ffmpeg` from the frames `record start` captured.

## Cleanup

```sh
pnpm drive cleanup
```

Cleanup stops the keeper, the Next server or Electron process this run started, and the Chromium window. It deletes the temporary data directory, `.verify/run.json`, the socket, the logs, and any leftover frames. It identifies processes by the pid and the data directory recorded at launch. It does not kill by process name. It does not delete `.verify/evidence`. After cleanup, `pnpm drive doctor` reports that nothing is running, and the screenshot, dump, and video are still in `.verify/evidence`. Running cleanup when nothing is running still leaves that folder in place.

## Helpers

`pnpm drive` runs `node --experimental-strip-types scripts/drive.mts`. The keeper listens on `.verify/drive.sock` and is the only process that holds the browser. Later commands send one JSON request to that socket.

```sh
pnpm drive help
```

`.claude/skills` is a symlink to `../.agents/skills`, so a loader that reads `.claude/skills` finds this skill. BusyBoy's composer reads both directories and keeps one entry per skill name. The feature map under `features/` is the source for what to drive when the product changes. Update the map in the same change as the feature.
