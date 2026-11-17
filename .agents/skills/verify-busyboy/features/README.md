# BusyBoy verification map

This directory is the maintained source for verifying BusyBoy's user-facing behavior. Read this index, then follow the feature file. The information architecture in the README is the list of screens. The files here are the ones with a drive recipe.

## Baseline preconditions

- The web surface is running and `pnpm verify doctor` reports `"ok": true`, `"scripted": true`, and the expected `dataDir`, `buildId`, and `gitSha`.
- Launch seeded git repositories named `web` and `api` and finished setup, so `/` opens the Director chat instead of `/setup`.
- `defaultProvider` is `claude`. The replays are the top-level files in `tests/provider-scripts`.
- The viewport is 1280 by 720, so the chat sidebar is on screen.
- Never drive an instance this run did not launch. Never point `--out` at a directory inside the git worktree.

## Driving conventions

- Start every recipe from the Director chat unless its preconditions say otherwise.
- Prefer ARIA roles and accessible names. Pass `--exact` when the name is a prefix of another control.
- Treat every command as literal. Keep quoted prompts and flags unchanged.
- A prompt has to match a recorded turn exactly. Anything else surfaces `No claude script has a turn for: ...` and that is a failed journey, not a reason to change the prompt.
- Restore nothing in the user's real home. Cleanup deletes the temporary data folder and keeps the output folder.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof is an ARIA snapshot plus a screenshot that shows the BusyBoy title.
- When the feature writes a file, a card, or a task, record that side effect too.
- Record the feature id and the entry point with the artifacts.
- An unreachable entry point is reported with the command that failed and the unmet precondition. Do not report it as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 and one paragraph, then exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with pnpm verify`, and `Gotchas`. The driving section states the observable pass condition.

## Features

- [Director chat](./director-chat.md) covers the transcript, the composer, a scripted answer, and starting one task.
- [Plan card](./plan-card.md) covers the draft plan, its details, approve, and request changes.
- [Progress, done, and PR cards](./progress-done-pr-cards.md) covers the status cards and Merge in order.
- [Approval cards](./approval-cards.md) covers an always-ask approval and a question card.
- [Settings](./settings.md) covers the settings sections, the companion, the theme, and the harness.
- [Terminal](./terminal.md) covers the bottom panel and a shell in the seeded repository.

## Not mapped yet

Setup, the chat sidebar beyond opening the Director, manager chat, rooms, the task group's archive and restore actions, the command palette, and the desktop tray menu are in the information architecture and do not have feature files yet. Do not report them as verified.
