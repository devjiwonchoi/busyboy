import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { useProjectsHome } from "./support/projects-home";
import { startStandaloneServer } from "./support/standalone-server";

const QUICK_REQUEST = "Add a CONTRIBUTING.md that explains how to run the project.";
const QUICK_FOLLOW_UP = "Also add a section on running the tests.";
const CARD_FOLLOW_UP = "Now delete the build folder.";
const LONG_REQUEST = "Write the release notes for this week.";
const LONG_FOLLOW_UP = "List the fixes only.";
const APPROVAL_REQUEST = "Delete the build folder.";
const SUBAGENT_REQUEST = "Say which branch is checked out.";

type StoredTask = { id: string; agentId: string; sessionId: string | null; activity?: string };

function storedTasks(home: string): StoredTask[] {
  const file = join(home, "task-list.json");
  return existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as { tasks: StoredTask[] }).tasks
    : [];
}

function sessionMessages(sessionId: string | null | undefined): string[] {
  if (!sessionId) return [];
  const file = join(tmpdir(), "busyboy-scripted-sessions", `${sessionId}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as string[]) : [];
}

async function callTool(request: APIRequestContext, name: string, args: Record<string, string>) {
  const response = await request.post("/api/mcp", {
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as {
    result: { isError?: boolean; content: { text: string }[] };
  };
  return { isError: Boolean(body.result.isError), text: body.result.content[0].text };
}

async function openChat(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("log", { name: "Transcript" })).toHaveAttribute(
    "data-connected",
    "true",
  );
}

const taskLine = (page: Page, name: string) =>
  page.getByRole("group", { name: "Tasks" }).getByRole("listitem", { name });

async function sendTo(page: Page, name: string, text: string) {
  await taskLine(page, name)
    .getByRole("button", { name: `Message ${name}` })
    .click();
  await expect(page.getByText(`Messaging ${name}`)).toBeVisible();
  await page.getByRole("textbox", { name: "Message" }).fill(text);
  await page.getByRole("button", { name: "Send" }).click();
}

test("messaging a task that finished its turn should reach its agent and not the Director", async ({
  page,
  context,
  baseURL,
}) => {
  const { home } = await useProjectsHome(context, baseURL!, ["web"]);
  await callTool(context.request, "create_task", {
    project: "web",
    title: "Contributing guide",
    request: QUICK_REQUEST,
  });
  await openChat(page);
  const line = taskLine(page, "web · Contributing guide");
  await expect(line.locator("[data-status]")).toHaveText("Idle");
  const before = storedTasks(home)[0];

  await sendTo(page, "web · Contributing guide", QUICK_FOLLOW_UP);

  const transcript = page.getByRole("log", { name: "Transcript" });
  await expect(
    transcript.getByRole("group", { name: "Your reply to web · Contributing guide" }),
  ).toHaveText(QUICK_FOLLOW_UP);
  await expect
    .poll(() => sessionMessages(before.sessionId))
    .toEqual([QUICK_REQUEST, QUICK_FOLLOW_UP]);
  expect(storedTasks(home)[0].agentId).toBe(before.agentId);
  await expect(page.getByText("Messaging web · Contributing guide")).toHaveCount(0);
  await expect(transcript.getByRole("group", { name: "Reply", exact: true })).toHaveCount(0);
  await expect(transcript).toHaveAttribute("data-status", "idle");
});

test("a message typed for a task that started waiting on a card should not be sent to the Director", async ({
  page,
  context,
  baseURL,
}) => {
  const { home } = await useProjectsHome(context, baseURL!, ["web"]);
  await callTool(context.request, "create_task", {
    project: "web",
    title: "Contributing guide",
    request: QUICK_REQUEST,
  });
  await openChat(page);
  const line = taskLine(page, "web · Contributing guide");
  await expect(line.locator("[data-status]")).toHaveText("Idle");
  const [task] = storedTasks(home);
  await line.getByRole("button", { name: "Message web · Contributing guide" }).click();
  await page.getByRole("textbox", { name: "Message" }).fill("Yes, delete it.");

  await callTool(context.request, "message_task", { task: task.id, message: CARD_FOLLOW_UP });
  await expect(line.locator("[data-status]")).toHaveText("Needs you");
  await expect(page.getByText("Messaging web · Contributing guide")).toHaveCount(0);
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByTestId("chat").getByRole("alert")).toContainText(
    "The task you were messaging stopped taking messages, so this was not sent.",
  );
  const transcript = page.getByRole("log", { name: "Transcript" });
  await expect(transcript.getByRole("group", { name: /^Your / })).toHaveCount(0);
  await expect(transcript).toHaveAttribute("data-status", "idle");
  expect(sessionMessages(task.sessionId)).toEqual([QUICK_REQUEST, CARD_FOLLOW_UP]);
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveText("Yes, delete it.");
});

test("messaging an idle task after a restart should start its agent again on the same session", async ({
  browser,
}) => {
  const server = await startStandaloneServer();
  try {
    const context = await browser.newContext({ baseURL: server.baseURL });
    const { home } = await useProjectsHome(context, server.baseURL, ["web"]);
    await callTool(context.request, "create_task", {
      project: "web",
      title: "Contributing guide",
      request: QUICK_REQUEST,
    });
    await expect.poll(() => storedTasks(home)[0]?.activity).toBe("idle");
    const before = storedTasks(home)[0];
    await server.stop("SIGTERM");

    await server.restart();
    const page = await context.newPage();
    await openChat(page);
    const line = taskLine(page, "web · Contributing guide");
    await expect(line.locator("[data-status]")).toHaveText("Idle");
    expect(storedTasks(home)[0].agentId).toBe(before.agentId);

    await sendTo(page, "web · Contributing guide", QUICK_FOLLOW_UP);

    await expect.poll(() => storedTasks(home)[0]?.agentId).not.toBe(before.agentId);
    expect(storedTasks(home)[0].sessionId).toBe(before.sessionId);
    await expect
      .poll(() => sessionMessages(before.sessionId))
      .toEqual([QUICK_REQUEST, QUICK_FOLLOW_UP]);
    await expect.poll(() => storedTasks(home)[0]?.activity).toBe("idle");
    await expect(line.locator("[data-status]")).toHaveText("Idle");
    await context.close();
  } finally {
    await server.dispose();
  }
});

test("messaging a stopped task should start it again in its worktree", async ({
  page,
  context,
  baseURL,
}) => {
  const { home } = await useProjectsHome(context, baseURL!, ["web"]);
  await callTool(context.request, "create_task", {
    project: "web",
    title: "Release notes",
    request: LONG_REQUEST,
  });
  await openChat(page);
  const line = taskLine(page, "web · Release notes");
  await expect.poll(() => storedTasks(home)[0]?.sessionId).toMatch(/^scripted-/);
  const before = storedTasks(home)[0];
  await line.getByRole("button", { name: "Stop web · Release notes" }).click();
  await expect(line.locator("[data-status]")).toHaveText("Stopped");

  await sendTo(page, "web · Release notes", LONG_FOLLOW_UP);

  await expect
    .poll(() => sessionMessages(before.sessionId))
    .toEqual([LONG_REQUEST, LONG_FOLLOW_UP]);
  await expect(line.locator("[data-status]")).toHaveText("Idle");
  expect(storedTasks(home)[0].agentId).not.toBe(before.agentId);
});

test("calling message_task should send the message to the task agent", async ({
  context,
  baseURL,
}) => {
  const { home } = await useProjectsHome(context, baseURL!, ["web"]);
  await callTool(context.request, "create_task", {
    project: "web",
    title: "Contributing guide",
    request: QUICK_REQUEST,
  });
  await expect.poll(() => storedTasks(home)[0]?.activity).toBe("idle");
  const [task] = storedTasks(home);

  const result = await callTool(context.request, "message_task", {
    task: task.id,
    message: QUICK_FOLLOW_UP,
  });

  expect(result).toEqual({
    isError: false,
    text: `Sent to task ${task.id} in web. Its agent is working on it now.`,
  });
  await expect
    .poll(() => sessionMessages(task.sessionId))
    .toEqual([QUICK_REQUEST, QUICK_FOLLOW_UP]);
});

test("a task waiting on a card, a subagent, and an unknown task should not take a message", async ({
  page,
  context,
  baseURL,
}) => {
  const { home } = await useProjectsHome(context, baseURL!, ["web"]);
  await callTool(context.request, "create_task", {
    project: "web",
    title: "Clean build",
    request: APPROVAL_REQUEST,
  });
  await callTool(context.request, "run_subagent", {
    project: "web",
    title: "Which branch",
    request: SUBAGENT_REQUEST,
  });
  await openChat(page);
  await expect(taskLine(page, "web · Clean build").locator("[data-status]")).toHaveText(
    "Needs you",
  );
  await expect(taskLine(page, "web · Which branch").locator("[data-status]")).toHaveText("Done");
  const [waiting, subagent] = storedTasks(home);

  await expect(page.getByRole("button", { name: /^Message web · / })).toHaveCount(0);
  expect(
    await callTool(context.request, "message_task", { task: waiting.id, message: "Hurry up." }),
  ).toEqual({
    isError: true,
    text: "web · Clean build is waiting on a card. Answer or reply to that card instead.",
  });
  expect(
    await callTool(context.request, "message_task", {
      task: subagent.id,
      message: "And the commit?",
    }),
  ).toEqual({
    isError: true,
    text: "web · Which branch is a subagent: it does one action and takes no further messages. Start a new one.",
  });
  expect(
    await callTool(context.request, "message_task", { task: "missing", message: "Hello." }),
  ).toEqual({
    isError: true,
    text: "There is no task missing.",
  });
});
