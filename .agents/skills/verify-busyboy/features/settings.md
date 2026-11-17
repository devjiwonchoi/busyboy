# Settings

Settings lets a person change the Director, the theme, the harness, connectors, the always-ask list, and the project list after setup. Choosing a Director saves immediately.

## Sub-features

- `settings-open` opens Settings from the title bar.
- `settings-director` chooses a companion and saves it.
- `settings-sections` opens Appearance, Agents, Connectors, Approvals, and Projects from the section list.

## How to get to it (user POV)

- From the Director chat, choose Settings in the title bar. The control is a link named `Settings`.
- The page heading is Director. The section list is the navigation `Settings sections`.
- Choose a companion. Ming the seal is the radio `Ming the seal`.
- Choose Appearance, Agents, Connectors, Approvals, or Projects in that list. The command palette can also open Settings; the journey uses the title-bar link.

## Driving it with the drive CLI

Preconditions:

- `pnpm drive doctor` exits 0 on the Next surface.
- Setup is already finished in the launch seed, so `/settings` does not redirect to `/setup`.

- **Open settings.** Run `pnpm drive journey settings`. The journey opens the chat, clicks the link `Settings`, and waits for the main region `Settings` and the heading `Director`.
- **Choose Ming.** The journey clicks the radio `Ming the seal`. The radio is checked.
- **Confirm the side effect.** `app-settings.json` in the data directory has `"companion": "ming"`. The command output names that file. There is no Continue button and no step counter; the page stays on Settings.
- **Open another section.** After the journey, run `pnpm drive click --role link --name Appearance` and `pnpm drive wait --role heading --name Appearance`. The same click and wait work for `Agents`, `Connectors`, `Approvals`, and `Projects`. The link lives in the navigation `Settings sections`.
- **Proof.** Run `pnpm drive dump --name settings` and `pnpm drive screenshot --name settings` while Ming is selected. The dump shows the heading `Director`, the checked radio `Ming the seal`, and BusyBoy in the title. The screenshot shows the same page.

## Gotchas

- Opening Settings before setup is finished redirects to Setup. The launch seed marks setup finished so this page is the one that opens.
- The title-bar control is a link named `Settings`, not a button. On the settings page itself the way back is the link `Back to chat`.
- Choosing Ming changes the Director row's accessible name on the next visit to the chat. A later `director-send` on this same launch no longer sees the original greeting.
- Appearance, Agents, Connectors, Approvals, and Projects are separate headings. The companion save does not by itself prove those sections.
- The desktop tray is not on the Next surface. Do not treat this journey as proof of the tray menu.
