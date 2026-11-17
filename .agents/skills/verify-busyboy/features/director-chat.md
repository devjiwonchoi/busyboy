# Director chat

The Director chat is the home screen. The companion greets you, the composer sends a message, and the transcript keeps your message and the reply. The same composer is on a manager chat; this file drives the Director.

## Sub-features

- `director-open` shows the connected transcript and the message box.
- `director-send` sends a prompt and shows it as your message.
- `director-reply` shows the scripted reply and returns the transcript to idle.
- `director-task` starts one task in `@web` and lists it in the transcript.
- `composer-stop` shows Stop while a reply is running.
- `composer-attach` exposes Add attachment and Choose a file.

## How to get to it (user POV)

- Open BusyBoy. After setup, `/` is the Director chat.
- Choose the Director row in the chat sidebar.
- From settings, choose Back to chat.

## Driving it with pnpm verify

Preconditions:

- `pnpm verify doctor` reports `"ok": true` and `"scripted": true`.
- The page is `/`.
- No earlier turn in this chat used the prompts below. A second send of the same sentence has no new recorded turn.

- **Open the chat.** Launch leaves you here. Run `pnpm verify wait --role log --name Transcript --attr data-connected --value true` and `pnpm verify wait --role textbox --name Message`. The title bar reads BusyBoy and the textbox is visible.
- **Send a question.** Run `pnpm verify fill --role textbox --name Message --value "What does git worktree do? Answer in one sentence."` and `pnpm verify click --role button --name Send`. A group named `Your message` shows that sentence.
- **Read the reply.** Run `pnpm verify wait --role log --name Transcript --attr data-status --value idle` and `pnpm verify text --role group --name Reply --exact`. The text contains `check out more than one branch`.
- **Confirm no task.** Run `pnpm verify wait --role group --name Tasks --state hidden`. The question does not start work.
- **Start one task.** In a fresh chat, run `pnpm verify fill --role textbox --name Message --value "In @web, add a CONTRIBUTING.md that explains how to run the project."` and `pnpm verify click --role button --name Send`. The group named `Tasks` contains a listitem named `web · Add CONTRIBUTING.md`, and the reply contains `I've started a task in @web`.
- **Pass.** `pnpm verify snapshot --path director-chat.aria.txt` and `pnpm verify screenshot --path director-chat.png` show BusyBoy, the sent sentence, and either the reply or the task line for the entry point you drove. `data-status` is `idle`.

## Gotchas

- `Reply` without `--exact` also matches `Reply in progress`.
- The recorded question is one exact sentence. A paraphrase produces `No claude script has a turn for: ...`.
- `@web` only resolves because launch seeded a repository named `web`.
- Stop is the button named `Stop` and only appears while a reply is running. The in-progress group is named `Reply in progress`.
- A message sent while a reply is running is a status named `Queued message`, not a second immediate reply.
- Add attachment is the button named `Add attachment`. Choose a file is the file input named `Choose a file`.
- The task agent replay for the CONTRIBUTING request does not write `ALIGN.md`, so this entry point does not open a plan card.
