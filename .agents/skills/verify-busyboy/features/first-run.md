# First run

A new profile signs in to one harness and lands in the Director chat.

## Sub-features

- `first-run-harness` shows only the sign-in step.
- `first-run-director` opens the chat after Continue.

## How to get to it (user POV)

- A profile with no `app-settings.json` opens Setup. The heading is `Sign in to an agent`.
- Claude Code, Codex, and Grok show whether they are signed in. Continue stays disabled until one is signed in.
- Continue opens the Director chat.

## Driving it with the drive CLI

Preconditions:

- `pnpm drive doctor` exits 0 on the Next surface.
- Start from a fresh `pnpm drive launch`. The launch seed marks setup finished, and this journey deletes that file.

- **Open a fresh profile.** Run `pnpm drive journey first-run`. The journey removes `app-settings.json`, waits for the heading `Sign in to an agent`, and clicks `Continue`.
- **Land in the Director.** The transcript `Transcript` has `data-connected="true"`. The chat shows `BusyBoy is ready. What should we work on?`. `app-settings.json` has `setupCompletedAt`.
- **Proof.** Run `pnpm drive screenshot --name first-run` and `pnpm drive dump --name first-run`.

## Gotchas

- The launch seed skips setup. Run `first-run` on its own launch.
- Setup does not ask for a director, skills, an always-ask list, or a project. Those headings are a failure.
- The desktop window with an empty data folder shows `Sign in to an agent`. Chat journeys still refuse the Electron surface.
