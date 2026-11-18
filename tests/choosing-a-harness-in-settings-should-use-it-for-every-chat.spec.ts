import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { useProjectsHome } from "./support/projects-home";

const CODEX_PROMPT = "Reply with exactly this sentence and nothing else: Hello from busyboy.";

async function openChat(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("log", { name: "Transcript" })).toHaveAttribute(
    "data-connected",
    "true",
  );
}

test("choosing a harness in Settings should use it for every chat", async ({
  page,
  context,
  baseURL,
}) => {
  const { home } = await useProjectsHome(context, baseURL!, ["web"], {
    claude: "signed-in",
    codex: "signed-in",
  });
  await page.goto("/settings?section=agents");
  const harness = page.getByRole("radiogroup", { name: "Harness" });
  await expect(harness.getByRole("radio", { name: "Use Claude Code by default" })).toBeChecked();
  await expect(page.getByLabel("Model")).toHaveCount(0);
  await expect(page.getByLabel("Effort")).toHaveCount(0);

  await harness.getByRole("radio", { name: "Use Codex by default" }).click();
  await expect
    .poll(() => JSON.parse(readFileSync(join(home, "app-settings.json"), "utf8")).defaultProvider)
    .toBe("codex");
  await page.reload();
  await expect(
    page
      .getByRole("radiogroup", { name: "Harness" })
      .getByRole("radio", { name: "Use Codex by default" }),
  ).toBeChecked();

  await openChat(page);
  await expect(page.getByRole("radiogroup", { name: "Harness" })).toHaveCount(0);
  await expect(page.getByLabel("Model")).toHaveCount(0);
  await expect(page.getByLabel("Effort")).toHaveCount(0);
  await page.getByRole("textbox", { name: "Message" }).fill(CODEX_PROMPT);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByLabel("Reply", { exact: true })).toHaveText("Hello from busyboy.");
  await expect
    .poll(() => JSON.parse(readFileSync(join(home, "director", "state.json"), "utf8")).provider)
    .toBe("codex");
  expect(existsSync(join(home, "director", "harness.json"))).toBe(false);
});
