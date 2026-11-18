# First run

A new profile signs in to one harness and lands in the Director chat. BusyBoy links skills when a checkout is present, and starts with no projects and no director character.

## Sub-features

- `first-run-harness` shows only the sign-in step.
- `first-run-director` opens the Director after Continue, with no project and no character.

## How to get to it (user POV)

- A profile with no `app-settings.json` opens Setup. The heading is `Sign in to an agent`.
- Claude Code, Codex, and Grok show whether they are signed in. Continue stays disabled until one is signed in.
- Continue opens the Director chat. The message header says `Director`. The greeting is `BusyBoy is ready. What should we work on?`

## Driving it with the drive CLI

Preconditions:

- `pnpm drive doctor` exits 0 on the Next surface.
- Start from a fresh `pnpm drive launch`. The launch seed marks setup finished, and this journey deletes that file.

- **Open a fresh profile.** Run `pnpm drive step open-setup` on a launch that is already ready. It removes `app-settings.json` and waits for the heading `Sign in to an agent`. `pnpm drive journey first-run` does that and then clicks `Continue`.
- **Land in the Director.** The transcript `Transcript` has `data-connected="true"`. The chat shows `Director` and the greeting. `app-settings.json` has an empty `projects` array and no companion.
- **Proof.** Run `pnpm drive screenshot --name first-run` and `pnpm drive dump --name first-run` on the Director. The dump shows the transcript and the greeting. A second screenshot after `pnpm drive step open-settings` shows Settings.

## Gotchas

- The launch seed skips setup. Run `first-run` on its own launch. Later journeys on that same launch see the profile this journey finished.
- Setup does not ask for a director, skills, an always-ask list, or a project. Those headings are a failure.
- The desktop window with an empty data folder shows `Sign in to an agent`. Chat journeys still refuse the Electron surface.
- There is no chat list and no "No managers yet" sentence.
