# Director chat send

Director chat send lets a person type a message and read the harness reply in the transcript.

## Sub-features

- `director-open` shows the greeting, the message field, Send, and Stop.
- `director-send` puts the person's message in the transcript and sends it.
- `director-reply` shows the Director's answer.
- `director-persist` writes that answer into the Director transcript file.

## How to get to it (user POV)

- Open BusyBoy. The main window is the Director chat.
- Use the message field. Its accessible name is `Message`.

## Driving it with the drive CLI

Preconditions:

- `pnpm drive doctor` exits 0 on the Next surface and reports `transcript: connected`.
- The data directory is the one launch just created.

- **Open the chat.** The launch already waited for the greeting. Run `pnpm drive step open-chat`. The log `Transcript` is connected, and the textbox `Message` is visible.
- **Send the question.** Type the question and choose Send. Run `pnpm drive journey director-send`. The article `Your message` reads `What does git worktree do? Answer in one sentence.` The article `Reply` contains `check out more than one branch`.
- **Confirm the side effect.** The journey checks `director/transcript.jsonl` inside the data directory. The command's output names that file and says it contains `check out more than one branch`.
- **Proof.** Capture the reply on screen. Run `pnpm drive dump --name director-send` and `pnpm drive screenshot --name director-send`.

## Gotchas

- Fill `Message`, not the placeholder.
- Send stays disabled until the field has text.
- The reply is scripted. The prompt must be exactly `What does git worktree do? Answer in one sentence.`
- The greeting `BusyBoy is ready. What should we work on?` is the fresh-launch greeting.
- This journey refuses the Electron surface. The desktop server sets a launch token and ignores provider scripts.
