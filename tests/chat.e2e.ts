import { beforeEach, describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

import { finishSetupWithClaude } from "./utils/app-settings";

describe("chat", () => {
  beforeEach(async ({ app, screen }) => {
    finishSetupWithClaude();
    await app.open("/");
    await screen.getByRole("button", "Send").waitFor();
  });

  test("streams a reply in before it finishes", async ({ screen }) => {
    await screen.getByRole("textbox", "Message").fill("Say something long.");
    await screen.getByRole("button", "Send").tap();
    await screen
      .getByRole("article", "Reply")
      .filter({ hasText: "Streaming reply one", hasNotText: "finished." })
      .waitFor();

    await expect(screen.getByRole("article", "Reply").last()).toContainText("finished.");
  });

  test("shows thinking until the reply starts", async ({ screen }) => {
    await screen.getByRole("textbox", "Message").fill("Think first.");
    await screen.getByRole("button", "Send").tap();
    await screen.getByText("Thinking…").waitFor();
    await screen.getByText("Thinking…").waitFor({ state: "hidden" });

    await expect(
      screen.getByRole("article", "Reply").filter({ hasNotText: "finished." }),
    ).toBeVisible();
  });
});
