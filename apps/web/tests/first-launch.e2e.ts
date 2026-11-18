import { describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

// One serial flow: the app under test keeps one data folder for the whole run,
// so the setup check must run before anything finishes setup.
describe("first launch", { serial: true }, () => {
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
    // tests/fixtures/fake-claude sends one word every 250 ms. A reply that only
    // shows up once the turn ends never matches this partial-text locator.
    await screen
      .getByRole("article", "Reply")
      .filter({ hasText: "Streaming reply one", hasNotText: "finished." })
      .waitFor();

    await expect(screen.getByRole("article", "Reply")).toContainText("finished.");
  });
});
