# Plan card

A plan card is the draft `ALIGN.md` for a task: a summary, the end-state list, and Aligning. View details opens the draft. Approve sends "Approved." Request changes sends the text you type.

## Sub-features

- `plan-open` shows the card for a draft plan.
- `plan-details` opens the draft in a dialog.
- `plan-approve` approves the plan and leaves a closed card.
- `plan-request-changes` points the composer at the card.

## How to get to it (user POV)

- A task agent saves `ALIGN.md` with `Status: draft` and ends the turn. The card appears in that chat's transcript.
- The recorded task request that does this is `Add a footer with the project name to the web app.` The card is named `Plan from web · Add a footer`.

## Driving it with pnpm verify

Preconditions:

- `pnpm verify doctor` reports `"ok": true` and `"scripted": true`.
- The transcript contains a group named `Plan from web · Add a footer`.

- **See the card.** Run `pnpm verify text --role group --name "Plan from web · Add a footer"`. The text contains `Aligning` and `Every page of the web app ends with a footer`. The list named `End state` has `Show the project name on every page` and `Place the footer below the main content`.
- **Open the draft.** Run `pnpm verify click --role button --name "View details"`. A dialog named `Add a site footer` is visible and contains `Success criteria`.
- **Close the draft.** Run `pnpm verify press --key Escape`. The dialog is hidden.
- **Approve.** Run `pnpm verify click --role button --name Approve`. The plan group is hidden. A group named `Card from web · Add a footer` contains `Approved`.
- **Request changes, on a card that is still open.** Run `pnpm verify click --role button --name "View details"`, then `pnpm verify click --role button --name "Request changes"`. The composer shows a reply target. Sending text uses the message box named `Message` and the button named `Send`.
- **Pass.** The screenshot and ARIA snapshot show either the open plan card with Aligning, or the closed card containing `Approved`, and the BusyBoy title is visible.

## Gotchas

- The Director replays do not call `create_task` with this request. Sending the sentence in the composer is a Director turn, no Director script has it, and the transcript reports `No claude script has a turn for: ...`. That is not a plan card. Do not change the sentence to force a match.
- Approve and Request changes are both inside the dialog and on the card. Approve on the card is enough for `plan-approve`.
- After approval the open plan group is gone. A later check for `Plan from web · Add a footer` fails on purpose.
- A trivial task saves `ALIGN.md` with `Status: approved` and does not open this card.
