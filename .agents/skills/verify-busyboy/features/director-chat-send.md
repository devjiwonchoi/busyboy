# Director chat send

Director chat send lets a person type a message. The signed-in harness writes the reply. BusyBoy does not replay a script.

## Sub-features

- `director-open` shows the greeting, the message field, Send, and Stop.
- `director-send` puts the person's message in the transcript and sends it to the harness.
- `director-persist` writes that message into the Director transcript file.

## How to get to it (user POV)

- Open BusyBoy after a harness is signed in. The main window is the Director chat.
- Use the message field. Its accessible name is `Message`.

## Driving it with the drive CLI

Preconditions:

- `pnpm drive doctor` exits 0 on the Next surface and reports `transcript: connected`.
- A harness CLI is signed in on this machine. There is no scripted reply.

- **Open the chat.** Run `pnpm drive step open-chat`. The log `Transcript` is connected, and the textbox `Message` is visible.
- **Send the question.** Run `pnpm drive journey director-send`. The article `Your message` reads `What does git worktree do? Answer in one sentence.` The file `director/transcript.jsonl` contains that sentence.
- **Proof.** Run `pnpm drive dump --name director-send` and `pnpm drive screenshot --name director-send`.

## Gotchas

- Fill `Message`, not the placeholder.
- Send stays disabled until the field has text.
- The reply text comes from the real harness. This journey does not wait for a particular sentence.
- This journey refuses the Electron surface.
