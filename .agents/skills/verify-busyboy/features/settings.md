# Settings

Settings changes the companion, the theme, the harness, connectors, the always-ask list, and the project list. Setup is finished on a verification instance, so settings opens directly.

## Sub-features

- `settings-open` opens settings from the title bar.
- `settings-section` switches section from the section nav.
- `settings-theme` applies System, Dark, or Light.
- `settings-companion` selects a companion.
- `settings-harness` shows the harness every chat uses.

## How to get to it (user POV)

- Choose Settings in the title bar.
- Open `/settings`. A section other than Director is `/settings?section=` with `appearance`, `agents`, `connectors`, `approvals`, or `projects`.
- Choose Back to chat to return.

## Driving it with pnpm verify

Preconditions:

- `pnpm verify doctor` reports `"ok": true`.
- The seed theme is dark and the seed harness is Claude.

- **Open settings.** Run `pnpm verify click --role link --name Settings`. The main region named `Settings` is visible and the heading is `Director`.
- **Appearance.** Run `pnpm verify click --role link --name Appearance`. The link is inside the navigation named `Settings sections`. The heading is `Appearance`. Run `pnpm verify wait --role radio --name Dark --attr aria-checked --value true`.
- **Choose light.** Run `pnpm verify click --role radio --name Light --force`. Run `pnpm verify wait --role radio --name Light --attr aria-checked --value true`.
- **Companion.** Run `pnpm verify open --path /settings` and `pnpm verify click --role radio --name "Ming the seal" --force`. The radio named `Ming the seal` is checked.
- **Harness.** Run `pnpm verify open --path "/settings?section=agents"`. The group named `Harness` includes `Use Claude Code by default`.
- **Back.** Run `pnpm verify click --role link --name "Back to chat"`. The transcript is visible again.
- **Pass.** A screenshot taken on Appearance after the Light radio is checked shows the light page and the Settings title. `app-settings.json` in the doctor `dataDir` has `"theme": "light"`.

## Gotchas

- The theme and companion radios need `--force`. Their accessible names are on the control, and the hit target is the surrounding label. The theme names are substrings: `System`, `Dark`, and `Light`. Do not pass `--exact`.
- Companion radios are named `Jota the cat`, `Rippu the hamster`, `Ming the seal`, `Yam the elephant`, and `Jjeromming the squirrel`.
- Choosing Codex or Grok leaves the scripted Claude replays. Those CLIs are not replayed from the top-level provider scripts. Leave the harness on Claude Code during verification.
- Approvals is a textbox named `Always-ask list`, with buttons `Save` and `Restore defaults`. A saved list stays on `/settings?section=approvals`.
- Projects lists the seeded `web` and `api` repositories. Remove is `Remove web` or `Remove api`. Removing a project does not delete its folder. Do not remove them if a later recipe still needs `@web` or `@api`.
