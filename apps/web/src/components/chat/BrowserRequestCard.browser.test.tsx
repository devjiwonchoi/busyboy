import { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

const state = vi.hoisted(() => ({
  answers: [] as Array<unknown>,
}));

vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => async (input: { input: unknown }) => {
    state.answers.push(input.input);
    return { _tag: "Success", value: undefined };
  }) as never,
}));

import {
  BrowserRequestCard,
  abbreviateUsername,
  type BrowserRequestItem,
} from "./BrowserRequestCard";

const environmentId = EnvironmentId.make("env-1");
const threadId = ThreadId.make("thread-1");

const card = (overrides: Partial<BrowserRequestItem>): BrowserRequestItem =>
  ({
    id: TurnItemId.make("turn-item:browser-request:1"),
    threadId,
    runId: "run-1",
    nodeId: "node-root",
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "waiting",
    title: "Sign-in request",
    startedAt: "2026-11-05T00:00:00.000Z",
    completedAt: null,
    updatedAt: "2026-11-05T00:00:00.000Z",
    type: "browser_request",
    requestKind: "sign_in",
    reason: "Check the dashboard",
    origin: "http://127.0.0.1:4000",
    tabId: "tab-1",
    browserStatus: "pending",
    ...overrides,
  }) as BrowserRequestItem;

function installBridges() {
  const autofill = {
    onEvent: () => () => {},
    choose: vi.fn(),
    dismissFillList: vi.fn(),
    respondToPrompt: vi.fn(),
    peek: vi.fn(),
    reopenPrompt: vi.fn(),
    signInOptions: vi.fn(async () => ({
      available: true,
      logins: [{ loginId: 7, username: "alice@example.com" }],
    })),
    signIn: vi.fn(async () => ({ outcome: "submitted" as const })),
  };
  const history = {
    search: vi.fn(async () => ({
      visits: [
        {
          id: 1,
          url: "http://127.0.0.1:4000/welcome",
          title: "Welcome",
          visitedAt: 2_000,
          transition: "agent",
          source: "agent",
          threadId: "thread-1",
        },
        {
          id: 2,
          url: "http://127.0.0.1:4000/old",
          title: null,
          visitedAt: 500,
          transition: "link",
          source: "user",
          threadId: null,
        },
      ],
      nextCursor: null,
    })),
  };
  (window as { desktopBridge?: unknown }).desktopBridge = {
    browserPasswords: { autofill },
    browserHistory: history,
  };
  return { autofill, history };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.answers.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete (window as { desktopBridge?: unknown }).desktopBridge;
  vi.unstubAllGlobals();
});

const render = (item: BrowserRequestItem, visibility: "local" | "inherited" = "local") =>
  act(async () =>
    root.render(
      <BrowserRequestCard environmentId={environmentId} item={item} visibility={visibility} />,
    ),
  );

describe("browser sign-in card", () => {
  it("signs in with a saved login and sends only the outcome", async () => {
    const { autofill } = installBridges();
    await render(card({}));
    const form = page.getByRole("form", { name: "Sign in to 127.0.0.1:4000" });
    await expect.element(form.getByText("Check the dashboard")).toBeVisible();
    await userEvent.click(form.getByRole("button", { name: "Use alice@example.com" }));
    await vi.waitFor(() => expect(state.answers).toHaveLength(1));
    expect(autofill.signIn).toHaveBeenCalledWith({
      tabId: JSON.stringify([environmentId, threadId, null, "tab-1"]),
      origin: "http://127.0.0.1:4000",
      choice: { kind: "saved", loginId: 7 },
    });
    expect(state.answers[0]).toEqual({
      threadId,
      turnItemId: "turn-item:browser-request:1",
      answer: { type: "sign_in", outcome: "submitted" },
    });
    expect(JSON.stringify(state.answers)).not.toContain("alice");
  });

  it("signs in with details entered on the card and can save them", async () => {
    const { autofill } = installBridges();
    autofill.signInOptions.mockResolvedValueOnce({ available: true, logins: [] });
    await render(card({}));
    await userEvent.fill(page.getByRole("textbox", { name: "Username" }), "bob");
    await userEvent.fill(page.getByRole("textbox", { name: "Password" }), "bob-pass");
    await userEvent.click(page.getByRole("checkbox", { name: "Save this login" }));
    await userEvent.click(page.getByRole("button", { name: "Sign in", exact: true }));
    await vi.waitFor(() => expect(state.answers).toHaveLength(1));
    expect(autofill.signIn).toHaveBeenCalledWith(
      expect.objectContaining({
        choice: { kind: "entered", username: "bob", password: "bob-pass", save: true },
      }),
    );
    expect(JSON.stringify(state.answers)).not.toContain("bob");
  });

  it("declines", async () => {
    const { autofill } = installBridges();
    await render(card({}));
    await userEvent.click(page.getByRole("button", { name: "Decline" }));
    await vi.waitFor(() => expect(state.answers).toHaveLength(1));
    expect(state.answers[0]).toMatchObject({ answer: { type: "sign_in", outcome: "declined" } });
    expect(autofill.signIn).not.toHaveBeenCalled();
  });

  it("shows the outcome once answered, and that a forked request waits elsewhere", async () => {
    installBridges();
    await render(card({ browserStatus: "page_left_origin" }));
    await expect
      .element(page.getByText(/Sign in to 127\.0\.0\.1:4000 · The page left the site/))
      .toBeVisible();
    await render(card({}), "inherited");
    await expect
      .element(page.getByText(/Waiting for an answer in the original thread/))
      .toBeVisible();
  });
});

describe("browsing history card", () => {
  const historyCard = (overrides: Partial<BrowserRequestItem> = {}) =>
    card({
      requestKind: "history",
      origin: undefined,
      tabId: undefined,
      query: "welcome",
      historyLimit: 10,
      historySince: 1_000,
      ...overrides,
    });

  it("allows once, sharing only matching visits after the cutoff", async () => {
    const { history } = installBridges();
    await render(historyCard());
    await expect.element(page.getByText(/Searching for “welcome”/)).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Allow once" }));
    await vi.waitFor(() => expect(state.answers).toHaveLength(1));
    expect(history.search).toHaveBeenCalledWith({
      profileId: "default",
      query: "welcome",
      limit: 10,
    });
    expect(state.answers[0]).toEqual({
      threadId,
      turnItemId: "turn-item:browser-request:1",
      answer: {
        type: "history",
        decision: "allow",
        visits: [
          {
            url: "http://127.0.0.1:4000/welcome",
            title: "Welcome",
            visitedAt: 2_000,
            source: "agent",
          },
        ],
      },
    });
  });

  it("denies", async () => {
    const { history } = installBridges();
    await render(historyCard());
    await userEvent.click(page.getByRole("button", { name: "Deny" }));
    await vi.waitFor(() => expect(state.answers).toHaveLength(1));
    expect(state.answers[0]).toMatchObject({ answer: { type: "history", decision: "deny" } });
    expect(history.search).not.toHaveBeenCalled();
  });

  it("shares without asking when the setting allows it", async () => {
    installBridges();
    await render(historyCard({ autoApprove: true }));
    await vi.waitFor(() => expect(state.answers).toHaveLength(1));
    expect(state.answers[0]).toMatchObject({ answer: { type: "history", decision: "allow" } });
    expect(page.getByRole("button", { name: "Allow once" }).elements()).toHaveLength(0);
  });
});

describe("abbreviateUsername", () => {
  it("keeps only first letters", () => {
    expect(abbreviateUsername("jane@example.com")).toBe("j…@e…");
    expect(abbreviateUsername("alice")).toBe("a…");
  });
});
