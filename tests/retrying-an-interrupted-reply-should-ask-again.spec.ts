import { expect, test, type Page } from "@playwright/test";

import { useProjectsHome } from "./support/projects-home";

const SLOW_REQUEST = "Write a long story about a lighthouse.";

async function openChat(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("log", { name: "Transcript" })).toHaveAttribute(
    "data-connected",
    "true",
  );
}

test("retrying an interrupted reply should ask again", async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, ["web"]);
  await openChat(page);
  const transcript = page.getByRole("log", { name: "Transcript" });

  await page.getByRole("textbox", { name: "Message" }).fill(SLOW_REQUEST);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(transcript.getByLabel("Reply in progress")).toContainText(
    "Once upon a time, a lighthouse",
  );

  await page.getByRole("button", { name: "Stop" }).click();
  const reply = transcript.getByLabel("Reply", { exact: true });
  await expect(reply).toHaveAttribute("data-interrupted", "true");
  await expect(transcript).toHaveAttribute("data-status", "idle");

  await reply.hover();
  await reply.locator("..").getByRole("button", { name: "Retry" }).click();

  await expect(transcript.getByLabel("Your message")).toHaveText(SLOW_REQUEST);
  await expect(transcript.getByLabel("Reply", { exact: true })).toHaveText(
    "A lighthouse, briefly.",
  );
  await expect(transcript.getByText("Once upon a time, a lighthouse")).toHaveCount(0);
  await expect(transcript.getByText("Interrupted", { exact: true })).toHaveCount(0);
  await expect(transcript).toHaveAttribute("data-status", "idle");
});
