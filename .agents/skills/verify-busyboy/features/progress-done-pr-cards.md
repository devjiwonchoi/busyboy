# Progress, done, and PR cards

`STATUS.md` is the progress card while the task is running, the done card when `State` is done, and the PR card for the pull-request table. Merge in order is the only merge action, and nothing merges until that click.

## Sub-features

- `progress-open` shows the todo steps and their marks.
- `progress-details` spells each step out.
- `done-open` replaces the progress card when the task is done.
- `pr-open` lists the pull requests in stack order.
- `pr-merge` merges them from the bottom of the stack through the scripted `gh`.

## How to get to it (user POV)

- The progress card appears when the task's `STATUS.md` has a todo table and `State` is not done.
- The recorded request `Build the site footer and report each step.` opens `Progress from web · Add a footer`.
- Message that task and send `Ship the footer.` The done card and the PR card replace the progress card.

## Driving it with pnpm verify

Preconditions:

- `pnpm verify doctor` reports `"ok": true` and `"scripted": true`.
- A group named `Progress from web · Add a footer` is in the transcript.

- **Read the steps.** Run `pnpm verify text --role group --name "Progress from web · Add a footer"`. The text contains `Done: Footer component`, `Running: Wire the pages`, and `Not started: Deliver`.
- **Open the steps.** Run `pnpm verify click --role button --name "View details"`. A dialog named `Add a footer` shows `Running`. Run `pnpm verify press --key Escape`.
- **Ship.** Run `pnpm verify click --role button --name "Message web · Add a footer"`, `pnpm verify fill --role textbox --name Message --value "Ship the footer."`, and `pnpm verify click --role button --name Send`.
- **Done and pull requests.** Run `pnpm verify wait --role group --name "Done from web · Add a footer"`. The group contains `PR` and has `data-variant="line"`. Run `pnpm verify wait --role group --name "Pull requests from web · Add a footer"`. The progress group is hidden.
- **Merge.** Run `pnpm verify click --role button --name "Merge in order"`. The scripted `gh` is `tests/fake-gh/gh`. It appends the invocation to `.gh-merge.log` in the server's working directory, which is the repository root, the same place `pnpm start` uses.
- **Pass.** The screenshot shows the done line and the pull-request rows, with the BusyBoy title visible. The progress card is gone.

## Gotchas

- No Director replay creates this task. Sending `Build the site footer and report each step.` in the composer does not open the card. The unmet precondition stays unmet; do not substitute another prompt.
- The progress card has View details and no Reply or Stop task.
- The done card's action is `View plan`, not `View details`. The dialog is named `Add a site footer`.
- Open on the PR card is a link. Merge in order is the button. The card does not merge on its own.
- `.gh-merge.log` is the scripted `gh` log, not the proof. Do not commit it. The proof is the card after the click and that log's new line.
