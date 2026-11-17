# Approval cards

An approval card asks before an always-ask action. A question card asks you to pick. One single-choice question is answered by the click. Otherwise you pick, then Answer. Reply sends your own text. Stop task ends the task. A closed card stays in the transcript with its outcome.

## Sub-features

- `approval-choose` answers an allow or deny card by the option click.
- `approval-stop` ends the task from the card.
- `question-choose` answers one recommended option by the click.
- `question-multi` selects one option on each of two questions and then Answer. The two questions reuse option labels, so a page-level click is ambiguous.

## How to get to it (user POV)

- The task agent hits an always-ask rule or asks a question. The card is in the transcript.
- The recorded request `Add a license file to the project.` opens `Question from web · Add a license`.
- The recorded request `Clean up the old build output.` opens `Approval from web · Clean up dist`.
- The recorded request `Force push the branch to origin.` opens `Approval from web · Force push`.

## Driving it with pnpm verify

Preconditions:

- `pnpm verify doctor` reports `"ok": true` and `"scripted": true`.
- The transcript contains the group named in the step you are driving.

- **Answer a question.** On `Question from web · Add a license`, run `pnpm verify click --role button --name "A. MIT (Recommended)"`. The click answers it. The open question group is replaced by a closed card.
- **Answer several.** The card `Question from web · Pick colors` has two questions that both contain `A. Red`. `pnpm verify click --role button --name "A. Red"` matches two buttons and fails. That entry point is not drivable with a single role and name. Do not report it as verified through the license question.
- **Deny an approval.** On `Approval from web · Force push`, run `pnpm verify click --role button --name "C. Deny"`. The options include `A. Allow`, `B. Always allow this exact command`, and `C. Deny`.
- **Stop the task.** On `Approval from web · Clean up dist`, run `pnpm verify click --role button --name "Stop task"`.
- **Reply in your own words.** Run `pnpm verify click --role button --name Reply`. The composer shows the reply target. Send with the message box named `Message` and the button named `Send`.
- **Pass.** The screenshot shows the chosen option or the closed card's outcome, and the BusyBoy title is visible. The open card group for that question or approval is hidden after a successful answer.

## Gotchas

- These requests are task-agent turns. Sending them in the Director composer does not open the card.
- A single-choice question answers on the option click. There is no Answer button. A multi-select card does not send until Answer, and Answer stays disabled until each question has a choice.
- Option names include the letter: `A. MIT (Recommended)`, not `MIT`.
- `B. Allow for this session` is the second option on `Approval from web · Clean up dist`. It is not the same label as `B. Always allow this exact command` on the force-push card.
- An approval that comes from a Director connector does not show Stop task.
