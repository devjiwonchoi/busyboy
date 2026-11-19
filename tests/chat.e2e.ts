import { afterEach, beforeEach, describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

import { finishSetupWithClaude } from "./utils/app-settings";
import { releaseClaude, releaseClaudeAt, waitForClaudeAt } from "./utils/claude-gates";

const LONG_PROMPT = "Count from one to forty in English words, separated by spaces.";
const SHORT_PROMPT = "Reply with one word: ready.";

describe("chat", () => {
  beforeEach(async ({ app, screen }) => {
    finishSetupWithClaude();
    await app.open("/");
    await screen.getByRole("button", "Send").waitFor();
  });

  afterEach(() => {
    releaseClaude();
  });

  test("shows the reply while the turn is still running", async ({ screen }) => {
    await screen.getByRole("textbox", "Message").fill(LONG_PROMPT);
    await screen.getByRole("button", "Send").tap();
    await waitForClaudeAt(LONG_PROMPT, "first-text");
    releaseClaudeAt(LONG_PROMPT, "first-text");
    await waitForClaudeAt(LONG_PROMPT, "turn-end");

    await expect(screen.getByRole("article", "Reply").last()).toContainText("forty", {
      ignoreCase: true,
    });
    await expect(screen.getByRole("button", "Stop")).toBeVisible();
  });

  test("shows thinking until the reply starts", async ({ screen }) => {
    await screen.getByRole("textbox", "Message").fill(SHORT_PROMPT);
    await screen.getByRole("button", "Send").tap();
    await waitForClaudeAt(SHORT_PROMPT, "first-text");

    await expect(screen.getByText("Thinking…")).toBeVisible();
  });
});
