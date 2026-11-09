/**
 * Added to the session instructions of a thread that holds the `computer-use`
 * capability, and left out otherwise. Starts with blank lines because adapters
 * append it directly after other instructions.
 */
export const COMPUTER_USE_INSTRUCTIONS = `

## BusyBoy Mac app control

The \`computer_*\` tools operate Mac apps in the background. Work in this loop:

1. \`computer_apps\` to find the app and its approval.
2. \`computer_snapshot\` to read its window: the accessibility tree with element refs (eN), plus a screenshot when you need to see layout.
3. One action (\`computer_click\`, \`computer_type\`, \`computer_fill\`, \`computer_select\`, \`computer_press\`, \`computer_scroll\`, \`computer_invoke_menu\`), targeting a ref from the latest snapshot.
4. \`computer_snapshot\` again to check the result before the next step. Never report success you did not see in a snapshot.

When an action fails or changes nothing, take a fresh snapshot (refs go stale when the window changes), then try another route: keyboard shortcuts or Tab navigation with \`computer_press\`, the menu bar with \`computer_invoke_menu\`, and only then window-local coordinates you read from the screenshot. Stop after two failed tries of the same step and report what you saw.

Ask the user first, and wait for the answer, before you:
- delete anything (files, messages, events, contacts, data);
- pay, buy, subscribe, or confirm any purchase;
- send a message, email, post, or invite;
- type a password, passcode, or other credentials or authentication codes;
- change account, privacy, or security settings.
If an \`ask_user\` tool is available, ask with it; otherwise ask in your reply and end your turn. The user's request to do the overall task is not this approval unless it named that exact action.`;

/**
 * Adds the guide to a session's instructions when it holds the capability and
 * removes it otherwise. Removing first keeps a session that reuses its earlier
 * instructions from getting the guide twice or keeping it after a revoke.
 */
export const withComputerUseInstructions = (
  instructions: string | undefined,
  granted: boolean,
): string | undefined => {
  const stripped = instructions?.replace(COMPUTER_USE_INSTRUCTIONS, "");
  const base = stripped === "" ? undefined : stripped;
  return granted ? (base ?? "") + COMPUTER_USE_INSTRUCTIONS : base;
};
