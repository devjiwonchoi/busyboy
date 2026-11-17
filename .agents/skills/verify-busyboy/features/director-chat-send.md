# Director chat send

Director chat send lets a person open the Director chat, type a message, and read the reply in the transcript. A question that does not ask for file changes stays in the chat and does not start a task.

## Sub-features

- `director-open` shows the greeting, the composer, and the Director row.
- `director-send` puts the person's message in the transcript and sends it.
- `director-reply` shows the Director's answer and returns the transcript to idle.
- `director-persist` writes that answer into the Director transcript file.

## How to get to it (user POV)

- Open BusyBoy. The main window is the Director chat.
- Choose the Director row in the chat sidebar. Its accessible name is `BusyBoy, director`.
- Use the composer at the bottom of the chat. The field's accessible name is `Message`.

## Driving it with the drive CLI

Preconditions:

- `pnpm drive doctor` exits 0 on the Next surface and reports `transcript: connected`.
- The data directory is the one launch just created.
- No earlier journey in this launch has changed the companion.

- **Open the chat.** The launch already waited for the greeting. Run `pnpm drive step open-chat`. The log `Transcript` is connected, the textbox `Message` is visible, and the link `Settings` is visible.
- **Send the question.** Type the question and choose Send. Run `pnpm drive journey director-send`. The group `Your message` reads `What does git worktree do? Answer in one sentence.` The group `Reply` contains `check out more than one branch`. The transcript's `data-status` is `idle`.
- **Confirm the side effect.** The journey checks `director/transcript.jsonl` inside the data directory. The command's output names that file and says it contains `check out more than one branch`. The tasks group is absent.
- **Proof.** Capture the reply on screen. Run `pnpm drive dump --name director-send` and `pnpm drive screenshot --name director-send`. Both show BusyBoy, the question, and the reply. The dump's group `Reply` contains `check out more than one branch`.

## Gotchas

- The textbox name stays `Message` while its placeholder says who will receive it. Fill `Message`, not the placeholder.
- Send stays disabled until the field has text. The journey fills the field, then clicks Send.
- The reply is scripted. The prompt must be exactly `What does git worktree do? Answer in one sentence.` A different sentence has no script, and the transcript shows that error.
- The greeting `BusyBoy is ready. What should we work on?` is the fresh-launch greeting. After the settings journey chooses Ming, the sidebar name changes and this greeting is gone.
- This journey refuses the Electron surface. The desktop server sets a launch token and ignores provider scripts.
