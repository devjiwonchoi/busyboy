# PR card

The PR card lists a task's pull requests in stack order. Open follows the first URL. Merge in order merges from the bottom of the stack, and nothing merges until that click.

## Sub-features

- `pr-open` shows one row per pull request, with its check text.
- `pr-open-link` exposes a single Open link to the first pull request.
- `pr-merge` merges in order when the person clicks Merge in order.
- `pr-record` writes the `gh` invocations into the task worktree and closes the card.

## How to get to it (user POV)

- Follow the progress and done path: send `In @web, build the site footer and report each step.`, then message the task `Ship the footer.`
- Read the card `Pull requests from web · Add a footer`. The rows are `#12 Add a footer` and `#13 Show the year`.
- Choose Open to follow the first URL, or choose Merge in order to merge the stack. The journey proves Merge in order.

## Driving it with the drive CLI

Preconditions:

- `pnpm drive doctor` exits 0 on a fresh Next launch.
- This launch has not already created a task titled `Add a footer`.
- `pnpm drive doctor` reports `gh:` pointing at `tests/fake-gh/gh` and that the file is executable.

- **Reach the card.** Run `pnpm drive journey pr-card`. The journey sends the footer request, waits for the progress card, messages the task `Ship the footer.`, and waits for the pull request card.
- **Read the stack.** The group `Pull requests from web · Add a footer` is visible, with the link `Open`, before Merge in order is clicked.
- **Merge.** The journey clicks the button `Merge in order`. The group `Card from web · Add a footer` contains `Merged in order`. The done card's text includes `Done`.
- **Confirm the side effect.** The journey reads `.gh-merge.log` in the task worktree from `task-list.json`. The file contains `pr merge 12 --merge` and `pr merge 13 --merge`. The command output names the log. `tests/fake-gh/gh` appends every invocation to that file and does not contact GitHub.
- **Proof.** Run `pnpm drive dump --name pr-card` and `pnpm drive screenshot --name pr-card` after the journey. The dump shows `Merged in order` and `Done`, and the screenshot shows BusyBoy with that result.

## Gotchas

- Merge in order is the only merge control. BusyBoy does not merge while the card is only being displayed.
- The Open link points at `https://github.com/acme/web/pull/12` and leaves BusyBoy. The journey does not click it. Clicking it is not proof of a merge.
- The log is the proof of what `gh` ran. A closed card without the log is incomplete.
- Run this on a fresh launch. `progress-and-done` leaves the pull request card unmerged; starting `pr-card` afterward creates a second `Add a footer` task and the Message button matches both.
- The recorded commands are `pr merge 12 --merge` and `pr merge 13 --merge`, in that order.
