# Terminal

The bottom panel is a shell. With no task selected it starts in the operating-system home directory. With a task selected it starts in that task's worktree. New terminal starts another shell in the current selection. Close kills the shell. A shell that is already running stays where it was when the selection changes.

## Sub-features

- `terminal-open` opens the bottom panel.
- `terminal-cwd` shows the working directory for the shell that started.
- `terminal-command` runs a command and shows its output.
- `terminal-close` hides the panel and kills the shell.

## How to get to it (user POV)

- Choose Toggle bottom panel in the title bar.
- Press the platform shortcut for Toggle bottom panel. On Linux that is Ctrl+J, and only when focus is not swallowing the shortcut.
- In the desktop app, with a task shell, Open in editor and Reveal in folder use that shell's folder. Those actions are not on the web surface.

## Driving it with pnpm verify

Preconditions:

- `pnpm verify doctor` reports `"ok": true` and `"surface": "web"`.
- Doctor's `dataDir` is the seeded folder. Call it `<dataDir>` below.

- **Open in the seeded repository.** Run `pnpm verify open --path "/?cwd=<dataDir>/projects/web"`. The `cwd` query is honored only in test mode, which the web surface is. Then run `pnpm verify click --role button --name "Toggle bottom panel"`.
- **See the directory.** Run `pnpm verify wait --role region --name Terminal` and `pnpm verify text --role region --name "Working directory"`. The text is `<dataDir>/projects/web`. The bottom panel region is visible.
- **Run a command.** Run `pnpm verify click --role region --name Terminal`, `pnpm verify type --text "echo busyboy-ok"`, and `pnpm verify press --key Enter`. Run `pnpm verify text --role region --name Terminal`. The text contains `busyboy-ok`.
- **Close.** Run `pnpm verify click --role button --name "Close terminal"`. The bottom panel is hidden.
- **Pass.** The screenshot shows the terminal output `busyboy-ok` and the working directory inside the temporary data folder. The BusyBoy title is visible. Cleanup removes that repository with the data folder.

## Gotchas

- Skip the `cwd` query and the shell starts in the operating-system home, not the data folder. Do not type commands there.
- On Electron the launch token turns test mode off, so the `cwd` query is ignored. Drive this recipe on the web surface.
- Changing the selected task does not move a shell that is already running. New terminal is the button that starts one in the current selection.
- The panel starts closed. A screenshot taken before Toggle bottom panel does not show a shell.
- Open in editor and Reveal in folder are desktop-only. Their absence on the web surface is expected.
