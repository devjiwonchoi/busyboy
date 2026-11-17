import { expect, test, type Page } from "@playwright/test";

import { useProjectsHome } from "./support/projects-home";

const QUESTION = "What does git worktree do? Answer in one sentence.";
const EDITED = "Never mind, just say hi.";

async function openChat(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("log", { name: "Transcript" })).toHaveAttribute(
    "data-connected",
    "true",
  );
}

test("editing the last message from the button or the up arrow should resend it", async ({
  page,
  context,
  baseURL,
}) => {
  await useProjectsHome(context, baseURL!, ["web"]);
  await openChat(page);
  const transcript = page.getByRole("log", { name: "Transcript" });
  const box = page.getByRole("textbox", { name: "Message" });

  await box.fill(QUESTION);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(transcript.getByLabel("Reply", { exact: true })).toContainText(
    "check out more than one branch",
  );
  await expect(transcript).toHaveAttribute("data-status", "idle");

  const user = transcript.getByLabel("Your message");
  const edit = user.locator("..").getByRole("button", { name: "Edit" });
  await expect(
    transcript
      .getByLabel("Reply", { exact: true })
      .locator("..")
      .getByRole("button", { name: "Edit" }),
  ).toHaveCount(0);
  await user.hover();
  await edit.click();

  const editing = page.getByRole("status", { name: "Editing your last message" });
  await expect(editing).toBeVisible();
  await expect.poll(() => box.innerText()).toBe(QUESTION);

  await editing.getByRole("button", { name: "Cancel" }).click();
  await expect(editing).toHaveCount(0);
  await box.click();
  await box.fill("x");
  await box.press("ArrowUp");
  await expect.poll(() => box.innerText()).toBe("x");
  await box.fill("");
  await box.press("ArrowUp");
  await expect(editing).toBeVisible();
  await expect.poll(() => box.innerText()).toBe(QUESTION);

  await box.fill(EDITED);
  await page.getByRole("button", { name: "Send" }).click();

  await expect(transcript.getByLabel("Your message")).toHaveText(EDITED);
  await expect(transcript.getByLabel("Reply", { exact: true })).toHaveText("Hi!");
  await expect(transcript.getByText(QUESTION)).toHaveCount(0);
  await expect(transcript.getByText("check out more than one branch")).toHaveCount(0);

  await page.reload();
  await expect(transcript).toHaveAttribute("data-connected", "true");
  await expect(transcript.getByLabel("Your message")).toHaveText(EDITED);
  await expect(transcript.getByLabel("Reply", { exact: true })).toHaveText("Hi!");
  await expect(transcript.getByText(QUESTION)).toHaveCount(0);
});
