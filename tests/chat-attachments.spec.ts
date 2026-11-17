import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { useProjectsHome } from "./support/projects-home";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");

function composer(page: Page) {
  return page
    .locator("form")
    .filter({ has: page.getByRole("textbox", { name: "Message" }) })
    .locator("..");
}

async function openChat(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("log", { name: "Transcript" })).toHaveAttribute(
    "data-connected",
    "true",
  );
}

async function pasteImage(page: Page, name: string) {
  await page.getByRole("textbox", { name: "Message" }).click();
  await page.evaluate(
    ({ base64, name: fileName }) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const file = new File([bytes], fileName, { type: "image/png" });
      const data = new DataTransfer();
      data.items.add(file);
      const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: data });
      const box = document.querySelector('[aria-label="Message"]');
      if (!box) throw new Error("No message box");
      box.dispatchEvent(event);
    },
    { base64: PNG_BASE64, name },
  );
}

async function dropImageOnChat(page: Page, name: string) {
  await page.evaluate(
    ({ base64, name: fileName }) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const file = new File([bytes], fileName, { type: "image/png" });
      const data = new DataTransfer();
      data.items.add(file);
      const transcript = document.querySelector('[role="log"][aria-label="Transcript"]');
      if (!transcript) throw new Error("No transcript");
      transcript.dispatchEvent(
        new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }),
      );
    },
    { base64: PNG_BASE64, name },
  );
}

async function send(page: Page, text: string) {
  await page.getByRole("textbox", { name: "Message" }).fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

test("pasting an image should send an image block to the harness", async ({
  page,
  context,
  baseURL,
}) => {
  const { home } = await useProjectsHome(context, baseURL!, ["web"]);
  await openChat(page);

  await pasteImage(page, "pixel.png");

  const box = composer(page);
  await expect(box.getByRole("img", { name: "pixel.png" })).toBeVisible();
  mkdirSync("/opt/cursor/artifacts", { recursive: true });
  await page.screenshot({ path: "/opt/cursor/artifacts/composer-pasted-image.png" });
  await send(page, "Look at this pasted image");

  const reply = page.getByLabel("Reply", { exact: true });
  await expect(reply).toContainText(`image image/png ${PNG_BYTES.length}`, { timeout: 15_000 });
  await expect(reply).toContainText("codex-image");
  const text = await reply.innerText();
  const saved = text.match(/codex-image (\S+)/)?.[1];
  expect(saved).toBeTruthy();
  expect(saved).toContain(join(home, "director", "attachments"));
  expect(saved).toContain("pixel.png");
  expect(readFileSync(saved!).equals(PNG_BYTES)).toBe(true);
  await expect(page.getByLabel("Your message")).toContainText("Image: pixel.png");
});

test("dropping an image on the chat should send an image block to the harness", async ({
  page,
  context,
  baseURL,
}) => {
  await useProjectsHome(context, baseURL!, ["web"]);
  await openChat(page);

  await dropImageOnChat(page, "dropped.png");

  await expect(composer(page).getByRole("img", { name: "dropped.png" })).toBeVisible();
  mkdirSync("/opt/cursor/artifacts", { recursive: true });
  await page.screenshot({ path: "/opt/cursor/artifacts/composer-dropped-image.png" });
  await send(page, "Look at this dropped image");

  const reply = page.getByLabel("Reply", { exact: true });
  await expect(reply).toContainText(`image image/png ${PNG_BYTES.length}`, { timeout: 15_000 });
  await expect(reply).toContainText("codex-image");
  await expect(reply).toContainText("dropped.png");
});

test("attaching a file should send its path to the harness", async ({ page, context, baseURL }) => {
  const { home } = await useProjectsHome(context, baseURL!, ["web"]);
  await openChat(page);

  await composer(page)
    .getByLabel("Choose a file")
    .setInputFiles({
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("hello from the composer"),
    });

  const box = composer(page);
  await expect(box.getByRole("list", { name: "Attachments" })).toContainText("notes.txt");
  mkdirSync("/opt/cursor/artifacts", { recursive: true });
  await page.screenshot({ path: "/opt/cursor/artifacts/composer-attached-file.png" });
  await send(page, "Look at this attached file");

  const reply = page.getByLabel("Reply", { exact: true });
  await expect(reply).toContainText("file ", { timeout: 15_000 });
  await expect(reply).toContainText("notes.txt");
  const saved = (await reply.innerText()).match(/file (\S+)/)?.[1];
  expect(saved).toBeTruthy();
  expect(saved).toContain(join(home, "director", "attachments"));
  expect(readFileSync(saved!, "utf8")).toBe("hello from the composer");
  await expect(page.getByLabel("Your message")).toContainText("notes.txt");
});

test("removing an attachment should take it off the message", async ({
  page,
  context,
  baseURL,
}) => {
  await useProjectsHome(context, baseURL!, ["web"]);
  await openChat(page);

  await pasteImage(page, "pixel.png");
  const box = composer(page);
  await expect(box.getByRole("img", { name: "pixel.png" })).toBeVisible();
  await box.getByRole("button", { name: "Remove pixel.png" }).click();
  await expect(box.getByRole("list", { name: "Attachments" })).toHaveCount(0);
});

test("attaching an unsupported file should show an error", async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, ["web"]);
  await openChat(page);
  const box = composer(page);

  await box.getByLabel("Choose a file").setInputFiles({
    name: "diagram.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
  });

  await expect(box.getByRole("alert")).toHaveText("Use a PNG, JPEG, GIF, or WebP image.");
  await expect(box.getByRole("list", { name: "Attachments" })).toHaveCount(0);
  mkdirSync("/opt/cursor/artifacts", { recursive: true });
  await page.screenshot({ path: "/opt/cursor/artifacts/composer-attachment-error.png" });
});

test("attaching an oversized file should show an error", async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, ["web"]);
  await openChat(page);
  const box = composer(page);

  await box.getByLabel("Choose a file").setInputFiles({
    name: "big.txt",
    mimeType: "text/plain",
    buffer: Buffer.alloc(1024 * 1024 + 1, 1),
  });

  await expect(box.getByRole("alert")).toHaveText("big.txt is larger than 1 MB.");
  await expect(box.getByRole("list", { name: "Attachments" })).toHaveCount(0);
});

test("a file that is not a real image should show an error and stay attached", async ({
  page,
  context,
  baseURL,
}) => {
  await useProjectsHome(context, baseURL!, ["web"]);
  await openChat(page);
  const box = composer(page);

  await box.getByLabel("Choose a file").setInputFiles({
    name: "fake.png",
    mimeType: "image/png",
    buffer: Buffer.from("not a png"),
  });
  await expect(box.getByRole("img", { name: "fake.png" })).toBeVisible();
  await send(page, "Look at this broken image");

  await expect(page.getByTestId("chat").getByRole("alert")).toHaveText(
    "fake.png could not be read. Use a PNG, JPEG, GIF, or WebP image.",
    { timeout: 15_000 },
  );
  await expect(box.getByRole("img", { name: "fake.png" })).toBeVisible();
  await expect(page.getByLabel("Your message")).toHaveCount(0);
});
