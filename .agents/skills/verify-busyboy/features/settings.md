# Settings

Settings lets a person change the Director, the theme, the harness, connectors, and the project list after setup. Choosing a Director saves immediately. The always-ask list is not edited here.

## Sub-features

- `settings-open` opens Settings from the title bar.
- `settings-director` chooses a companion and saves it.
- `settings-sections` opens Appearance, Agents, Connectors, and Projects from the section list.
- `settings-version` shows the running app version in the settings header, beside the update control. A desktop bridge reports Electron's app version. A plain browser says `BusyBoy dev`.

## How to get to it (user POV)

- From the Director chat, choose Settings in the title bar. The control is a link named `Settings`.
- The page heading is Director. On this Next surface the settings header says `BusyBoy dev`. A desktop app says `BusyBoy` and the version Electron was stamped with, such as `BusyBoy 0.0.30`. The section list is the navigation `Settings sections`.
- Choose a companion. Ming the seal is the radio `Ming the seal`.
- Choose Appearance, Agents, Connectors, or Projects in that list. The command palette can also open Settings; the journey uses the title-bar link. There is no Approvals section.

## Driving it with the drive CLI

Preconditions:

- `pnpm drive doctor` exits 0 on the Next surface.
- Setup is already finished in the launch seed, so `/settings` does not redirect to `/setup`.

- **Open settings.** Run `pnpm drive journey settings`. The journey opens the chat, clicks the link `Settings`, and waits for the main region `Settings` and the heading `Director`.
- **Choose Ming.** The journey clicks the radio `Ming the seal`. The radio is checked.
- **Confirm the side effect.** `app-settings.json` in the data directory has `"companion": "ming"`. The command output names that file. There is no Continue button and no step counter; the page stays on Settings. The header says `BusyBoy dev` and does not say `BusyBoy 0.0.0`. The Director chat does not show that line.
- **Open another section.** After the journey, run `pnpm drive click --role link --name Appearance` and `pnpm drive wait --role heading --name Appearance`. The same click and wait work for `Agents`, `Connectors`, and `Projects`. The link lives in the navigation `Settings sections`.
- **Proof.** Run `pnpm drive dump --name settings` and `pnpm drive screenshot --name settings` while Ming is selected. The dump shows the heading `Director`, the checked radio `Ming the seal`, and BusyBoy in the title. The screenshot shows the same page.

## Gotchas

- Opening Settings before setup is finished redirects to Setup. The launch seed marks setup finished so this page is the one that opens.
- The title-bar control is a link named `Settings`, not a button. On the settings page itself the way back is the link `Back to chat`. The version line sits in that header, next to the update button when one is ready. The chat title bar stays `BusyBoy` with no version. The Next bundle is built before a release version exists, so this surface does not read `package.json`.
- Choosing Ming changes the Director row's accessible name on the next visit to the chat. A later `director-send` on this same launch no longer sees the original greeting.
- Appearance, Agents, Connectors, and Projects are separate headings. The companion save does not by itself prove those sections. Approvals is not a section.
- The desktop tray is not on the Next surface. Do not treat this journey as proof of the tray menu.
