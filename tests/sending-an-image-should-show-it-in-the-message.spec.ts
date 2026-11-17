import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

import { useProjectsHome } from "./support/projects-home";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function expectLoaded(image: Locator) {
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBeGreaterThan(0);
}

async function openChat(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("log", { name: "Transcript" })).toHaveAttribute(
    "data-connected",
    "true",
  );
}

async function attachImage(page: Page) {
  await page
    .getByLabel("Choose a file")
    .setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: PNG_BYTES });
}

async function createTask(request: APIRequestContext, args: Record<string, string>) {
  const response = await request.post("/api/mcp", {
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "create_task", arguments: args },
    },
  });
  expect(response.status()).toBe(200);
}

test("sending an image should show it in the message and open it larger on click", async ({
  page,
  context,
  baseURL,
}) => {
  await useProjectsHome(context, baseURL!, ["web"]);
  await openChat(page);
  const transcript = page.getByRole("log", { name: "Transcript" });

  await attachImage(page);
  await page.getByRole("textbox", { name: "Message" }).fill("Look at this pasted image");
  await page.getByRole("button", { name: "Send" }).click();

  const message = transcript.getByLabel("Your message");
  await expect(message).toContainText("Look at this pasted image");
  await expect(message).not.toContainText("Image: pixel.png");
  const chats = page.getByRole("navigation", { name: "Chats" });
  await expect(chats).toHaveAttribute("data-loaded", "true");
  await expect(chats.getByText("Look at this pasted image", { exact: true })).toBeVisible();
  await expect(chats.getByText(/Image:/)).toHaveCount(0);
  await expectLoaded(message.getByRole("img", { name: "pixel.png" }));
  await expect(transcript.getByLabel("Reply", { exact: true })).toContainText("image image/png", {
    timeout: 15_000,
  });

  await message.getByRole("button", { name: "Open image pixel.png" }).click();
  const dialog = page.getByRole("dialog", { name: "pixel.png" });
  await expectLoaded(dialog.getByRole("img", { name: "pixel.png" }));
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);

  await page.reload();
  await expect(transcript).toHaveAttribute("data-connected", "true");
  await expectLoaded(message.getByRole("img", { name: "pixel.png" }));
});

test("sending an image to a task should show it in the message to that task", async ({
  page,
  context,
  baseURL,
}) => {
  await useProjectsHome(context, baseURL!, ["web"]);
  await createTask(context.request, {
    project: "web",
    title: "Contributing guide",
    request: "Add a CONTRIBUTING.md that explains how to run the project.",
  });
  await openChat(page);
  const name = "web · Contributing guide";
  const line = page.getByRole("group", { name: "Tasks" }).getByRole("listitem", { name });
  await expect(line.locator("[data-status]")).toHaveText("Idle");

  await line.getByRole("button", { name: `Message ${name}` }).click();
  await expect(page.getByText(`Messaging ${name}`)).toBeVisible();
  await attachImage(page);
  await page
    .getByRole("textbox", { name: "Message" })
    .fill("Also add a section on running the tests.");
  await page.getByRole("button", { name: "Send" }).click();

  const message = page
    .getByRole("log", { name: "Transcript" })
    .getByRole("group", { name: `Your reply to ${name}` });
  await expect(message).toContainText("Also add a section on running the tests.");
  await expectLoaded(message.getByRole("img", { name: "pixel.png" }));
});

test("retrying an interrupted reply to an image should send the image again", async ({
  page,
  context,
  baseURL,
}) => {
  await useProjectsHome(context, baseURL!, ["web"]);
  await openChat(page);
  const transcript = page.getByRole("log", { name: "Transcript" });

  await attachImage(page);
  await page.getByRole("textbox", { name: "Message" }).fill("Describe this image at length.");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(transcript.getByLabel("Reply in progress")).toContainText("This image shows");

  await page.getByRole("button", { name: "Stop" }).click();
  const reply = transcript.getByLabel("Reply", { exact: true });
  await expect(reply).toHaveAttribute("data-interrupted", "true");
  await expect(transcript).toHaveAttribute("data-status", "idle");

  await reply.hover();
  await reply.locator("..").getByRole("button", { name: "Retry" }).click();

  await expect(transcript.getByLabel("Reply", { exact: true })).toContainText(
    `image image/png ${PNG_BYTES.length}`,
  );
  await expectLoaded(transcript.getByLabel("Your message").getByRole("img", { name: "pixel.png" }));
});

test("a message of images alone should not offer Edit", async ({ page, context, baseURL }) => {
  await useProjectsHome(context, baseURL!, ["web"]);
  await openChat(page);
  const transcript = page.getByRole("log", { name: "Transcript" });
  const box = page.getByRole("textbox", { name: "Message" });

  await attachImage(page);
  await page.getByRole("button", { name: "Send" }).click();
  const message = transcript.getByLabel("Your message");
  await expectLoaded(message.getByRole("img", { name: "pixel.png" }));
  await expect(transcript).toHaveAttribute("data-status", "idle");
  const chats = page.getByRole("navigation", { name: "Chats" });
  await expect(chats).toHaveAttribute("data-loaded", "true");
  await expect(chats.getByText("Image", { exact: true })).toBeVisible();
  await expect(chats.getByText(/Image:/)).toHaveCount(0);

  await message.hover();
  await expect(message.locator("..").getByRole("button", { name: "Copy" })).toBeVisible();
  await expect(message.locator("..").getByRole("button", { name: "Edit" })).toHaveCount(0);
  await box.click();
  await box.press("ArrowUp");
  await expect(page.getByRole("status", { name: "Editing your last message" })).toHaveCount(0);
});
