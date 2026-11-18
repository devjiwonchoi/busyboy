# BusyBoy verification map

This directory is the maintained source for verifying what a person can do in BusyBoy. Read this index, then follow the feature file. The information architecture is the setup flow, the main window (title bar, chat sidebar, Director and manager chats, task group, cards, composer, terminal, command palette), settings, and the desktop tray.

## Baseline preconditions

- Run `pnpm drive launch` so BusyBoy is usable on the Next surface with a new `busyboy-verify-*` data directory.
- Run `pnpm drive doctor` and require exit code 0, `surface: next`, `transcript: connected`, and `scripted providers: active`.
- Drive only the instance this launch started.
- Start `approve-plan`, `progress-and-done`, and `pr-card` from that fresh launch. They each create a task titled `Add a footer`.

## Driving conventions

- Start every recipe from the baseline unless its preconditions say otherwise.
- Prefer ARIA roles and accessible names. The middle dot in card names is `·`.
- Treat every command as literal. Keep quoted names and flags unchanged.
- Run browser actions through `pnpm drive`.
- Restore nothing in the data directory during cleanup. `pnpm drive cleanup` deletes that directory and leaves `.verify/evidence` in place.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof is an ARIA dump and a screenshot that show BusyBoy.
- Mutation proof includes the file the feature names: the transcript, `ALIGN.md`, `app-settings.json`, or `.gh-merge.log`.
- Record the feature and the entry point with the artifact name.
- Report an unreachable path with the command that failed and the unmet precondition.
- A journey that refuses the Electron surface is not verified by the Next journey.

## Feature entry contract

Each feature file starts with an H1 and one paragraph. It then uses these four H2 sections, in order:

1. `Sub-features`
2. `How to get to it (user POV)`
3. `Driving it with the drive CLI`
4. `Gotchas`

## Features

- [Director chat send](./director-chat-send.md) sends a question from the composer and checks the reply in the transcript file.
- [Plan card approve](./plan-card-approve.md) opens a plan from a Director message and approves it.
- [Progress and done cards](./progress-and-done-cards.md) shows the todo steps, then the done card after the task is told to ship.
- [PR card](./pr-card.md) lists the stack and merges it in order.
- [Settings](./settings.md) opens settings and saves a new Director.
- [First run](./first-run.md) signs in to a harness and opens the Director with no project.
