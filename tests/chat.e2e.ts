import { beforeEach, describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

import { finishSetupWithClaude } from "./utils/app-settings";

describe("chat", () => {
  beforeEach(async ({ app, screen }) => {
    finishSetupWithClaude();
    await app.open("/");
    await expect(screen.getByRole("button", "Send")).toBeVisible();
  });

  test("streams a reply in before it finishes", async ({ agent, screen }) => {
    await agent.act("send the message {message}", {
      params: { message: "Say something long." },
    });

    await expect(
      screen
        .getByRole("article", "Reply")
        .filter({ hasText: "Streaming reply one", hasNotText: "finished." }),
    ).toBeVisible();
    await expect(screen.getByRole("article", "Reply").last()).toContainText("finished.");
  });

  test("shows thinking until the reply starts", async ({ agent, screen }) => {
    await agent.act("send the message {message}", { params: { message: "Think first." } });

    await expect(screen.getByText("Thinking…")).toBeVisible();
    await expect(screen.getByText("Thinking…")).toBeHidden();
    await expect(
      screen.getByRole("article", "Reply").filter({ hasNotText: "finished." }),
    ).toBeVisible();
  });
});
