# Progress and done cards

Progress and done cards show a task's todo steps from `STATUS.md`, then replace that card with a done line once the task ships. The person does not edit the card. View details and View plan open the notes.

## Sub-features

- `progress-open` shows the todo steps while one step is still running.
- `progress-details` offers View details and no Reply or Stop task on the card.
- `done-open` replaces the progress card after the task is told to ship.
- `done-plan` offers View plan on the done line.

## How to get to it (user POV)

- From the Director chat, send `In @web, build the site footer and report each step.`
- Read the progress card `Progress from web · Add a footer`. The steps say which are done, running, and not started.
- Choose View details to read the steps in a dialog.
- On the task line `web · Add a footer`, choose Message, then send `Ship the footer.`
- Read the done card `Done from web · Add a footer`. Choose View plan to read the plan.

## Driving it with the drive CLI

Preconditions:

- `pnpm drive doctor` exits 0 on a fresh Next launch.
- This launch has not already created a task titled `Add a footer`.

- **Start the task.** Run `pnpm drive journey progress-and-done`. The journey sends `In @web, build the site footer and report each step.`
- **Read the progress card.** Before the ship message, the group `Progress from web · Add a footer` contains `Done: Footer component` and `Running: Wire the pages`, and the button `View details` is visible.
- **Ship.** The journey clicks `Message web · Add a footer`, fills `Message` with `Ship the footer.`, and clicks Send.
- **Read the done card.** The group `Done from web · Add a footer` is visible and its button `View plan` is visible. The group `Pull requests from web · Add a footer` is also visible. This journey does not click Merge in order.
- **Proof.** Run `pnpm drive dump --name progress-and-done` and `pnpm drive screenshot --name progress-and-done`. The dump shows the done card and the pull request card, and the screenshot shows BusyBoy with both.

## Gotchas

- The progress card has no Approve, Reply, or Stop task. Those controls belong to other cards.
- `Ship the footer.` only matches the script when the task's first request was `Build the site footer and report each step.`
- The done card and the pull request card appear together. Merging is the PR card journey, on its own launch.
- View details and View plan open dialogs. The journey proves the buttons are present and leaves them closed so the cards stay in the dump.
- Two tasks titled `Add a footer` make the Message button ambiguous. Use a fresh launch.
