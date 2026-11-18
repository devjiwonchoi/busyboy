# Settings

Settings lets a person change the theme, the harness, connectors, and the project list after setup. The always-ask list is not edited here.

## Sub-features

- `settings-open` opens Settings from the title bar.
- `settings-sections` opens Appearance, Agents, Connectors, and Projects from the section list.
- `settings-harness` shows the signed-in harnesses on Agents.
- `settings-version` shows the running app version in the settings header, beside the update control. A desktop bridge reports Electron's app version. A plain browser says `BusyBoy dev`.

## How to get to it (user POV)

- From the Director chat, choose Settings in the title bar. The control is a link named `Settings`.
- The page opens on Appearance. On this Next surface the settings header says `BusyBoy dev`. A desktop app says `BusyBoy` and the version Electron was stamped with, such as `BusyBoy 0.0.30`. The section list is the navigation `Settings sections`.
- Choose Appearance, Agents, Connectors, or Projects in that list. There is no Approvals section and no director character.

## Driving it with the drive CLI

Preconditions:

- `pnpm drive doctor` exits 0 on the Next surface.
- Setup is already finished in the launch seed, so `/settings` does not redirect to `/setup`.

- **Open settings.** Run `pnpm drive journey settings`. The journey opens the chat, clicks the link `Settings`, and waits for the main region `Settings` and the heading `Appearance`.
- **Open Agents.** The journey clicks the link `Agents` and waits for the radio `Use Claude Code by default`.
- **Confirm the side effect.** The header says `BusyBoy dev` and does not say `BusyBoy 0.0.0`. There is no Continue button, no Approvals link, and no `Ming the seal` radio.
- **Open another section.** After the journey, run `pnpm drive click --role link --name Projects` and `pnpm drive wait --role heading --name Projects`. The same click and wait work for `Connectors`. The link lives in the navigation `Settings sections`.
- **Proof.** Run `pnpm drive dump --name settings` and `pnpm drive screenshot --name settings` on Agents. The dump shows the heading `Agents`, the harness radios, and BusyBoy in the title. The screenshot shows the same page.

## Gotchas

- Opening Settings before setup is finished redirects to Setup. The launch seed marks setup finished so this page is the one that opens.
- The title-bar control is a link named `Settings`, not a button. On the settings page itself the way back is the link `Back to chat`. The version line sits in that header, next to the update button when one is ready. The chat title bar stays `BusyBoy` with no version. The Next bundle is built before a release version exists, so this surface does not read `package.json`.
- Appearance, Agents, Connectors, and Projects are separate headings. Approvals is not a section.
- The desktop tray is not on the Next surface. Do not treat this journey as proof of the tray.
