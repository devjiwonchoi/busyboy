import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

describe("first launch, then the first chat", { serial: true }, () => {
  test("a first launch opens setup", async ({ app, screen }) => {
    await app.open("/");

    await expect(screen.getByRole("heading", { name: "Sign in to an agent" })).toBeVisible();
  });

  test("a director reply streams in before it finishes", async ({ app, screen }) => {
    await app.open("/setup");
    await screen.getByRole("button", "Continue").tap();
    await screen.getByRole("textbox", "Message").waitFor();

    await screen.getByRole("textbox", "Message").fill("Say something long.");
    await screen.getByRole("button", "Send").tap();
    await screen
      .getByRole("article", "Reply")
      .filter({ hasText: "Streaming reply one", hasNotText: "finished." })
      .waitFor();

    await expect(screen.getByRole("article", "Reply")).toContainText("finished.");
  });

  test("the chat shows thinking until the reply starts", async ({ app, screen }) => {
    await app.open("/");
    await screen.getByRole("textbox", "Message").waitFor();

    await screen.getByRole("textbox", "Message").fill("Think first.");
    await screen.getByRole("button", "Send").tap();
    await screen.getByText("Thinking…").waitFor();
    await screen.getByRole("article", "Reply").nth(1).waitFor();

    await expect(screen.getByText("Thinking…")).toHaveCount(0);
  });
});
