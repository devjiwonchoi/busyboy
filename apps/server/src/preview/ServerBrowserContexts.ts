// @effect-diagnostics nodeBuiltinImport:off - Owns Playwright resources outside the Effect runtime.
import { INCOGNITO_BROWSER_PROFILE_ID } from "@t3tools/contracts";
import { constVoid } from "effect/Function";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Browser, BrowserContext, CDPSession } from "playwright-core";

import { sandboxDisabled } from "./PreviewBrowserHost.ts";

// Playwright needs its files on disk. createRequire also resolves it from a Node SEA executable.
const requirePlaywright = NodeModule.createRequire(import.meta.url);
const loadPlaywright = () =>
  requirePlaywright("playwright-core") as typeof import("playwright-core");

interface Options {
  readonly profilesDir: string;
  readonly executable: () => Promise<string>;
  readonly diagnose?: (executable: string, cause: unknown) => Promise<unknown>;
  readonly env?: NodeJS.ProcessEnv;
  readonly onContextClose?: (context: BrowserContext) => void;
  /** How long a context with no pages, or the shared browser with no contexts, stays open. */
  readonly idleCloseMs?: number;
}

/** Each Chrome holds hundreds of MB, so an unused one closes soon and relaunches on demand. */
const DEFAULT_IDLE_CLOSE_MS = 10_000;

const UA_PLATFORMS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
};

/**
 * Sites block a user agent that disagrees with `Sec-CH-UA`, so both change together.
 */
const chromeIdentity = (
  headlessUserAgent: string,
  host: { readonly platform: NodeJS.Platform; readonly arch: string; readonly release: string },
) => {
  const version = /HeadlessChrome\/((\d+)[\d.]*)/.exec(headlessUserAgent);
  const fullVersion = version?.[1];
  const major = version?.[2];
  if (!version || !fullVersion || !major) return null;
  const brands = (names: (version: string) => string) => [
    { brand: "Chromium", version: names(major) },
    { brand: "Google Chrome", version: names(major) },
    { brand: "Not A(Brand", version: names("99") },
  ];
  return {
    userAgent: headlessUserAgent.replace(version[0], `Chrome/${major}.0.0.0`),
    userAgentMetadata: {
      brands: brands((value) => value),
      fullVersionList: brands((value) => (value === major ? fullVersion : `${value}.0.0.0`)),
      platform: UA_PLATFORMS[host.platform] ?? "Unknown",
      platformVersion: host.platform === "linux" ? host.release : "",
      architecture: host.arch.startsWith("arm") ? "arm" : "x86",
      bitness: host.arch.endsWith("64") ? "64" : "32",
      model: "",
      mobile: false,
      wow64: false,
    },
  };
};

export const presentAsChrome = async (
  cdp: CDPSession,
  host: { readonly platform: NodeJS.Platform; readonly arch: string },
) => {
  const { userAgent } = await cdp.send("Browser.getVersion");
  const identity = chromeIdentity(userAgent, { ...host, release: NodeOS.release() });
  if (identity) await cdp.send("Emulation.setUserAgentOverride", identity);
};

export class ServerBrowserContexts {
  private readonly options: Options;
  private readonly contexts = new Map<string, Promise<BrowserContext>>();
  private readonly clearing = new Map<string, Promise<void>>();
  /** Idle contexts closing; a new context for the same profile waits for its lock. */
  private readonly retiring = new Map<string, Promise<void>>();
  private readonly lastUse = new Map<string, number>();
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private browser: Promise<Browser> | undefined;
  private browserLastUse = 0;
  private browserContextsOpening = 0;
  private browserIdleTimer: ReturnType<typeof setTimeout> | undefined;
  private closing: Promise<void> | undefined;

  constructor(options: Options) {
    this.options = options;
  }

  private get idleCloseMs() {
    return this.options.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS;
  }

  private startTimer(run: () => void, delayMs: number) {
    const timer = setTimeout(run, delayMs);
    timer.unref?.();
    return timer;
  }

  /** Closes a context once it has had no pages, and no caller, for the idle period. */
  private scheduleContextIdle(key: string, pending: Promise<BrowserContext>, delayMs?: number) {
    if (this.closing || this.contexts.get(key) !== pending) return;
    clearTimeout(this.idleTimers.get(key));
    this.idleTimers.set(
      key,
      this.startTimer(() => {
        this.idleTimers.delete(key);
        void this.retireContextIfIdle(key, pending);
      }, delayMs ?? this.idleCloseMs),
    );
  }

  private async retireContextIfIdle(key: string, pending: Promise<BrowserContext>) {
    if (this.closing || this.contexts.get(key) !== pending) return;
    const context = await pending.catch(() => undefined);
    if (!context || this.contexts.get(key) !== pending) return;
    // A page still open reschedules the check when it closes.
    if (context.pages().length > 0) return;
    // A caller that just received the context has not opened its page yet.
    const idleFor = Date.now() - (this.lastUse.get(key) ?? 0);
    if (idleFor < this.idleCloseMs) {
      this.scheduleContextIdle(key, pending, this.idleCloseMs - idleFor);
      return;
    }
    this.contexts.delete(key);
    this.lastUse.delete(key);
    const retiring = context.close().catch(constVoid);
    this.retiring.set(key, retiring);
    await retiring;
    if (this.retiring.get(key) === retiring) this.retiring.delete(key);
  }

  /** Closes the shared browser once it has had no contexts for the idle period. */
  private scheduleBrowserIdle(delayMs?: number) {
    if (this.closing || !this.browser) return;
    clearTimeout(this.browserIdleTimer);
    this.browserIdleTimer = this.startTimer(() => {
      this.browserIdleTimer = undefined;
      void this.retireBrowserIfIdle();
    }, delayMs ?? this.idleCloseMs);
  }

  private async retireBrowserIfIdle() {
    const launched = this.browser;
    if (this.closing || !launched) return;
    const browser = await launched.catch(() => undefined);
    if (!browser || this.browser !== launched) return;
    if (this.browserContextsOpening > 0 || browser.contexts().length > 0) return;
    const idleFor = Date.now() - this.browserLastUse;
    if (idleFor < this.idleCloseMs) {
      this.scheduleBrowserIdle(this.idleCloseMs - idleFor);
      return;
    }
    this.browser = undefined;
    await browser.close().catch(constVoid);
  }

  private async newSharedContext(options?: Parameters<Browser["newContext"]>[0]) {
    this.browserContextsOpening += 1;
    try {
      const context = await (await this.sharedBrowser()).newContext(options);
      context.on("close", () => this.scheduleBrowserIdle());
      return context;
    } finally {
      this.browserContextsOpening -= 1;
    }
  }

  private async launchOptions() {
    const executablePath = await this.options.executable();
    const env = this.options.env ?? process.env;
    return {
      executablePath,
      env,
      args: [
        "--disable-gpu",
        "--force-device-scale-factor=2",
        "--disable-blink-features=AutomationControlled",
      ],
      ignoreDefaultArgs: ["--enable-automation"],
      headless: true,
      // Only an explicit operator opt-out disables sandboxing. Launch errors never do.
      chromiumSandbox: !sandboxDisabled(env),
    };
  }

  private async launch<A>(options: { readonly executablePath: string }, start: () => Promise<A>) {
    try {
      return await start();
    } catch (cause) {
      throw (await this.options.diagnose?.(options.executablePath, cause)) ?? cause;
    }
  }

  private sharedBrowser() {
    this.browserLastUse = Date.now();
    clearTimeout(this.browserIdleTimer);
    this.browserIdleTimer = undefined;
    if (!this.browser) {
      const launched = this.launchOptions().then(async (options) => {
        const { chromium } = loadPlaywright();
        const browser = await this.launch(options, () => chromium.launch(options));
        browser.on("disconnected", () => {
          if (this.browser === launched) this.browser = undefined;
        });
        return browser;
      });
      this.browser = launched;
      void launched.catch(() => {
        if (this.browser === launched) this.browser = undefined;
      });
    }
    return this.browser;
  }

  contextFor(profileId: string, isolationKey?: string): Promise<BrowserContext> {
    if (this.closing) return Promise.reject(new Error("The preview browser is closed."));
    const key = JSON.stringify([profileId, isolationKey ?? null]);
    this.lastUse.set(key, Date.now());
    const cached = this.contexts.get(key);
    if (cached) return cached;
    const cleared = Promise.all(
      [this.clearing.get(key), this.retiring.get(key)].map((settled) => settled?.catch(constVoid)),
    );
    const pending: Promise<BrowserContext> = cleared
      .then(() => this.createContext(profileId, isolationKey))
      .then(async (context) => {
        context.on("close", () => {
          if (this.contexts.get(key) === pending) {
            this.contexts.delete(key);
            this.lastUse.delete(key);
          }
          this.options.onContextClose?.(context);
        });
        for (const page of context.pages()) await page.close().catch(constVoid);
        if (this.closing) {
          await context.close().catch(constVoid);
          throw new Error("The preview browser is closed.");
        }
        // Tabs close their pages; the context closes once its last page is gone.
        context.on("page", (page) => {
          page.once("close", () => {
            if (context.pages().length === 0) this.scheduleContextIdle(key, pending);
          });
        });
        this.scheduleContextIdle(key, pending);
        return context;
      });
    this.contexts.set(key, pending);
    void pending.catch(() => {
      if (this.contexts.get(key) === pending) this.contexts.delete(key);
    });
    return pending;
  }

  private async createContext(profileId: string, isolationKey?: string) {
    const contextOptions = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 };
    if (isolationKey !== undefined || profileId === INCOGNITO_BROWSER_PROFILE_ID) {
      return this.newSharedContext(contextOptions);
    }
    const directory = this.profileDirectory(profileId);
    const options = await this.launchOptions();
    const { chromium } = loadPlaywright();
    await NodeFSP.mkdir(directory, { recursive: true });
    return this.launch(options, () =>
      chromium.launchPersistentContext(directory, { ...options, ...contextOptions }),
    );
  }

  private profileDirectory(profileId: string) {
    const encoded = encodeURIComponent(profileId);
    return NodePath.join(
      this.options.profilesDir,
      profileId === "." || profileId === ".." ? encoded.replaceAll(".", "%2E") : encoded,
    );
  }

  async scratchPage() {
    if (this.closing) throw new Error("The preview browser is closed.");
    const context = await this.newSharedContext();
    const page = await context.newPage();
    page.once("close", () => void context.close().catch(constVoid));
    return page;
  }

  async connectDesktopPage(endpoint: string) {
    const { chromium } = loadPlaywright();
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
    const page = browser.contexts().flatMap((context) => context.pages())[0];
    if (!page) {
      await browser.close().catch(constVoid);
      throw new Error("The desktop tab has no page.");
    }
    return { browser, page };
  }

  async clearProfile(profileId: string) {
    if (profileId === INCOGNITO_BROWSER_PROFILE_ID) return;
    const key = JSON.stringify([profileId, null]);
    const clearing = (async () => {
      const pending = this.contexts.get(key);
      if (pending) {
        this.contexts.delete(key);
        const context = await pending.catch(() => undefined);
        await context?.close();
      }
      await NodeFSP.rm(this.profileDirectory(profileId), { recursive: true, force: true });
    })();
    this.clearing.set(key, clearing);
    try {
      await clearing;
    } finally {
      if (this.clearing.get(key) === clearing) this.clearing.delete(key);
    }
  }

  close() {
    this.closing ??= this.dispose();
    return this.closing;
  }

  private async dispose() {
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    clearTimeout(this.browserIdleTimer);
    await Promise.allSettled(
      [...this.contexts.values()].map(async (pending) => (await pending).close()),
    );
    const browser = await this.browser?.catch(() => undefined);
    await browser?.close().catch(constVoid);
    this.contexts.clear();
  }
}
