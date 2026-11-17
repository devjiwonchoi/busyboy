# Plan card approve

Plan card approve lets a person ask the Director for work, read the plan card, and approve it. Approve records the decision on the card and in `ALIGN.md`.

## Sub-features

- `plan-open` asks for a footer in `@web` and shows the plan card.
- `plan-approve` chooses Approve on that card.
- `plan-record` writes `Status: approved` into `ALIGN.md` and shows the task as Idle.

## How to get to it (user POV)

- Open the Director chat.
- Send `In @web, add a footer with the project name to the web app.`
- Read the plan card in the transcript. Its accessible name is `Plan from web · Add a footer`.
- Choose Approve on the card. View details opens the draft, which also has Approve; the journey uses the button on the card.

## Driving it with the drive CLI

Preconditions:

- `pnpm drive doctor` exits 0 on a fresh Next launch.
- The seeded project `web` is the only project.
- This launch has not already created a task titled `Add a footer`.

- **Ask for the work.** Send the request from the Director composer. Run `pnpm drive journey approve-plan`. The journey sends `In @web, add a footer with the project name to the web app.`
- **Read the card.** The group `Plan from web · Add a footer` is visible before Approve is clicked. The task line `web · Add a footer` is in the tasks group.
- **Approve.** The journey clicks the button `Approve` on that card. The group `Card from web · Add a footer` contains `Approved`. The task line shows `Idle`.
- **Confirm the side effect.** The journey finds `ALIGN.md` under the data directory and requires `Status: approved`. The command output names that file.
- **Proof.** Run `pnpm drive dump --name plan-card` and `pnpm drive screenshot --name plan-card` after the journey, before cleanup. The dump shows `Approved` and `Idle`, and the screenshot shows BusyBoy with that card.

## Gotchas

- The card name uses `·`, not a hyphen or a bullet.
- `progress-and-done` and `pr-card` also create a task titled `Add a footer`. Run this journey on its own launch. A second task with the same title makes `Message web · Add a footer` match two buttons.
- Approve on the details dialog is a different button. The journey clicks Approve on the card group, with the dialog closed.
- The task agent writes `ALIGN.md` from the scripted turn for `Add a footer with the project name to the web app.` Changing the Director message without that request text does not open this card.
- A closed card that says Approved is the result. The draft plan card is gone after the click.
