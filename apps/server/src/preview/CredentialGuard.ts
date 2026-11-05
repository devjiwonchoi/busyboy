// @effect-diagnostics globalDate:off - Playwright callbacks run outside the Effect runtime.

/**
 * Keeps passwords a person fills in a preview tab away from agents.
 *
 * Agent scripts (`preview_evaluate`) run in the page itself, so they can read a
 * filled field, encode it, or send it anywhere. An isolated world doesn't stop
 * that: it shares the page's elements and can add a <script> that runs in the
 * page. So the guard blocks agent scripts where a password could be reached, and
 * remembers filled values so every agent-facing text masks them.
 *
 * Fields are read from isolated worlds, where page script can't change what
 * `value` returns. Agents can't type into password fields (preview_type refuses
 * them), so any value there is someone's.
 */

import type { PreviewAutomationSnapshot } from "@t3tools/contracts";
import type { BrowserContext, CDPSession, Page } from "playwright-core";

import * as ServerBrowserPage from "./ServerBrowserPage.ts";

const WORLD = "t3-credential-guard";
// Stands in for a snapshot image that would show a filled password as text.
const BLANK_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const HIDDEN_SCREENSHOT_NOTE =
  "[Screenshot hidden: a filled password shows as plain text on this page.]";
const BINDING = "__t3CredentialFill";

interface FrameCredentials {
  readonly origin: string;
  /** Password and dot-masked fields with no value. */
  readonly empty: number;
  readonly values: ReadonlyArray<string>;
  /** Whether a remembered value shows as plain text. */
  readonly revealed: boolean;
}

const isFrameCredentials = (value: unknown): value is FrameCredentials => {
  const frame = value as Partial<FrameCredentials> | null;
  return (
    typeof frame === "object" &&
    frame !== null &&
    typeof frame.origin === "string" &&
    typeof frame.empty === "number" &&
    Array.isArray(frame.values) &&
    frame.values.every((each) => typeof each === "string") &&
    typeof frame.revealed === "boolean"
  );
};

/** Reads password fields, and whether a known value shows as plain text, in one frame. */
const readScript = (known: ReadonlyArray<string>) => `((known) => {
  const values = [];
  const plain = [];
  let empty = 0;
  const visit = (root) => {
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) visit(element.shadowRoot);
      const field = element.localName === "input" || element.localName === "textarea";
      if (!field && !element.isContentEditable) continue;
      const value = field ? element.value : (element.textContent ?? "");
      const dots = getComputedStyle(element).getPropertyValue("-webkit-text-security");
      if (element.type === "password" || (dots !== "none" && dots !== "")) {
        if (value) values.push(value);
        else empty += 1;
      } else if (value) plain.push(value);
    }
  };
  visit(document);
  const text = known.length
    ? [document.body?.innerText ?? "", document.title, ...plain].join("\\n")
    : "";
  return {
    origin: self.origin,
    empty,
    values: [...new Set(values)],
    revealed: known.some((value) => text.includes(value)),
  };
})(${JSON.stringify(known)})`;

/**
 * Reports a password field's value when it changes, loses focus, or its page
 * goes away, so a fill is remembered even if no agent tool looks at the page
 * first. Runs in its own world, out of reach of page and agent scripts.
 */
const WATCH_SCRIPT = `(() => {
  const report = (element) => {
    if (!element) return;
    const field = element.localName === "input" || element.localName === "textarea";
    if (!field && !element.isContentEditable) return;
    const dots = getComputedStyle(element).getPropertyValue("-webkit-text-security");
    if (element.type !== "password" && (dots === "none" || dots === "")) return;
    const value = field ? element.value : (element.textContent ?? "");
    if (value) ${BINDING}(JSON.stringify({ origin: self.origin, value }));
  };
  const all = () => {
    const visit = (root) => {
      for (const element of root.querySelectorAll("input, textarea, [contenteditable]")) report(element);
      for (const element of root.querySelectorAll("*")) if (element.shadowRoot) visit(element.shadowRoot);
    };
    visit(document);
  };
  for (const type of ["change", "focusout"])
    addEventListener(type, (event) => report(event.composedPath()[0]), true);
  addEventListener("submit", all, true);
  addEventListener("pagehide", all, true);
})()`;

const executionError = (message: string) =>
  new ServerBrowserPage.ServerBrowserOperationError("PreviewAutomationExecutionError", message);

export const blockedOnPasswordPage = () =>
  executionError(
    "preview_evaluate is turned off on pages with a password field, so agent scripts can't read or capture passwords. Use preview_snapshot, preview_click, and preview_type instead.",
  );

export const blockedOnFilledOrigin = (origin: string) =>
  executionError(
    `preview_evaluate is turned off on ${origin} for this session because a password was filled there. Use preview_snapshot, preview_click, and preview_type instead.`,
  );

const uncheckable = () =>
  executionError(
    "The page's password fields couldn't be checked, so preview_evaluate didn't run. Wait for the page to settle and try again.",
  );

interface ContextState {
  /** Origins where a password was filled; agent scripts stay off there. */
  readonly origins: Set<string>;
}

export interface GuardedTab {
  readonly page: Page;
  readonly cdp: CDPSession;
}

export const makeCredentialGuard = () => {
  const contexts = new WeakMap<BrowserContext, ContextState>();
  // Remembered across every context: masking a value in an unrelated tab only hides more.
  const values = new Set<string>();
  let pattern: RegExp | undefined;
  let patternFor = -1;

  const stateOf = (context: BrowserContext) => {
    let state = contexts.get(context);
    if (!state) {
      state = { origins: new Set() };
      contexts.set(context, state);
    }
    return state;
  };

  const remember = (context: BrowserContext, origin: string, value: string) => {
    stateOf(context).origins.add(origin);
    values.add(value);
  };

  const read = async (tab: GuardedTab): Promise<ReadonlyArray<FrameCredentials> | undefined> => {
    const attempt = async () => {
      const { read } = await ServerBrowserPage.openReaders(
        tab.page,
        tab.cdp,
        readScript([...values]),
      );
      const results = await read();
      if (results.some((result) => result === undefined)) return undefined;
      const frames = (results as unknown as ReadonlyArray<ReadonlyArray<unknown>>).flat();
      // Anything else means the read didn't run as written, so nothing is known.
      return frames.every(isFrameCredentials) ? frames : undefined;
    };
    // Frames come and go while a page loads; a second look usually finds it settled.
    return attempt().catch(() => attempt().catch(() => undefined));
  };

  const learn = (context: BrowserContext, frames: ReadonlyArray<FrameCredentials>) => {
    for (const frame of frames)
      for (const value of frame.values) remember(context, frame.origin, value);
  };

  const maskPattern = () => {
    if (patternFor !== values.size) {
      // Raw, JSON, and URL forms; a form posted with GET puts the value in the address.
      const forms = [...values].flatMap((value) => {
        const uri = encodeURIComponent(value);
        const form = new URLSearchParams({ v: value }).toString().slice(2);
        return [value, uri, uri.replaceAll("%20", "+"), form];
      });
      pattern = ServerBrowserPage.dottedPattern([...new Set(forms)]);
      patternFor = values.size;
    }
    return pattern;
  };

  const maskText = (text: string) => {
    const dotted = values.size ? maskPattern() : undefined;
    return dotted ? text.replace(dotted, ServerBrowserPage.MASKED_VALUE) : text;
  };

  /** Masks every string except images and videos, and trees a snapshot already masked. */
  const mask = <A>(value: A): A => {
    if (values.size === 0) return value;
    const visit = (node: unknown, key?: string): unknown => {
      if (typeof node === "string") return key === "accessibilityTree" ? node : maskText(node);
      if (Array.isArray(node)) return node.map((each) => visit(each));
      if (node === null || typeof node !== "object") return node;
      const mimeType = (node as { mimeType?: unknown }).mimeType;
      if (typeof mimeType === "string" && /^(image|video)\//.test(mimeType)) return node;
      return Object.fromEntries(
        Object.entries(node).map(([name, each]) => [name, visit(each, name)]),
      );
    };
    return visit(value) as A;
  };

  /** Reads the tab, remembers fills, and says whether a remembered value shows as text. */
  const revealed = async (tab: GuardedTab) => {
    const frames = await read(tab);
    if (frames) learn(tab.page.context(), frames);
    // A page that couldn't be read counts as showing one, once anything is remembered.
    return frames ? frames.some((frame) => frame.revealed) : values.size > 0;
  };

  return {
    /** Watches the tab's frames for fills. Best effort: reads before each agent script still apply. */
    install: async (tab: GuardedTab) => {
      const context = tab.page.context();
      tab.cdp.on("Runtime.bindingCalled", (event) => {
        if (event.name !== BINDING) return;
        try {
          const { origin, value } = JSON.parse(event.payload) as { origin: string; value: string };
          if (typeof origin === "string" && typeof value === "string" && value)
            remember(context, origin, value);
        } catch {
          // Only this world's script calls the binding.
        }
      });
      try {
        // The named world only runs its script, and only gets the binding, with both enabled.
        await tab.cdp.send("Page.enable");
        await tab.cdp.send("Runtime.enable");
        await tab.cdp.send("Runtime.addBinding", { name: BINDING, executionContextName: WORLD });
        await tab.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
          source: WATCH_SCRIPT,
          worldName: WORLD,
          runImmediately: true,
        });
      } catch {
        // A host that refuses these still has the reads below.
      }
    },

    /**
     * Throws unless an agent script may run in this tab. Any password field, empty
     * or filled, turns it off, as does an origin
     * where a password was filled. Other tabs that share storage are read too.
     */
    assertMayEvaluate: async (tab: GuardedTab, siblings: ReadonlyArray<GuardedTab>) => {
      const context = tab.page.context();
      const frames = await read(tab);
      if (!frames) throw uncheckable();
      learn(context, frames);
      if (frames.some((frame) => frame.empty > 0 || frame.values.length > 0))
        throw blockedOnPasswordPage();
      await Promise.all(
        siblings.map(async (sibling) => {
          const found = await read(sibling);
          if (found) learn(context, found);
        }),
      );
      const origin = frames[0]?.origin ?? "null";
      // An opaque origin can still reach its opener's document.
      if (origin === "null" && stateOf(context).origins.size > 0)
        throw blockedOnFilledOrigin("this page");
      if (stateOf(context).origins.has(origin)) throw blockedOnFilledOrigin(origin);
    },

    /**
     * Takes a snapshot that masks remembered passwords too. When one shows as plain
     * text before or after, the image is swapped for a blank one.
     */
    snapshot: async (
      tab: GuardedTab,
      take: (remembered: ReadonlyArray<string>) => Promise<PreviewAutomationSnapshot>,
    ): Promise<PreviewAutomationSnapshot> => {
      const before = await revealed(tab);
      const snapshot = await take([...values]);
      if (!before && !(await revealed(tab))) return snapshot;
      return {
        ...snapshot,
        visibleText: `${HIDDEN_SCREENSHOT_NOTE}\n${snapshot.visibleText}`,
        screenshot: { mimeType: "image/png", data: BLANK_PNG, width: 1, height: 1 },
      };
    },

    /** Whether a recording frame may be kept: no remembered password shows as text. */
    mayShowFrame: async (tab: GuardedTab) => values.size === 0 || !(await revealed(tab)),
    mask,
    maskText,
  };
};

export type CredentialGuard = ReturnType<typeof makeCredentialGuard>;
