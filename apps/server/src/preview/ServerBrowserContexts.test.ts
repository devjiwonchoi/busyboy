import * as NodeEvents from "node:events";

import { INCOGNITO_BROWSER_PROFILE_ID } from "@t3tools/contracts";
import { chromium, type Browser, type BrowserContext, type BrowserType } from "playwright-core";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ServerBrowserContexts } from "./ServerBrowserContexts.ts";

const launches = vi.hoisted(() => ({
  launch: vi.fn<BrowserType["launch"]>(),
  persistent: vi.fn<BrowserType["launchPersistentContext"]>(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));
vi.spyOn(chromium, "launch").mockImplementation(launches.launch);
vi.spyOn(chromium, "launchPersistentContext").mockImplementation(launches.persistent);
vi.mock("node:fs/promises", () => ({ mkdir: launches.mkdir, rm: launches.rm }));

const makePage = () => {
  const events = new NodeEvents.EventEmitter();
  return {
    once: vi.fn((event: string, listener: () => void) => events.once(event, listener)),
    close: vi.fn(async () => {
      events.emit("close");
    }),
  };
};

const makeContext = () => {
  const events = new NodeEvents.EventEmitter();
  const pages = new Set<ReturnType<typeof makePage>>();
  let closed = false;
  return {
    on: vi.fn((event: string, listener: (...args: Array<unknown>) => void) =>
      events.on(event, listener),
    ),
    pages: vi.fn(() => [...pages]),
    /** Like a tab opening a page in the context. */
    openPage: () => {
      const page = makePage();
      pages.add(page);
      page.once("close", () => pages.delete(page));
      events.emit("page", page);
      return page;
    },
    get closed() {
      return closed;
    },
    close: vi.fn(async () => {
      if (!closed) {
        closed = true;
        events.emit("close");
      }
    }),
  };
};

const makeBrowser = () => {
  const events = new NodeEvents.EventEmitter();
  const created: ReturnType<typeof makeContext>[] = [];
  return {
    created,
    contexts: vi.fn(() => created.filter((context) => !context.closed)),
    on: vi.fn((event: string, listener: () => void) => events.on(event, listener)),
    newContext: vi.fn(async () => {
      const context = makeContext();
      created.push(context);
      return context as unknown as BrowserContext;
    }),
    close: vi.fn(async () => {
      for (const context of created) await context.close();
      events.emit("disconnected");
    }),
  };
};

const options = () => ({
  profilesDir: "/test/profiles",
  executable: vi.fn(async () => "/test/chromium"),
  env: {},
});

beforeEach(() => {
  launches.launch.mockReset();
  launches.persistent.mockReset();
  launches.mkdir.mockClear();
  launches.rm.mockClear();
});

describe("ServerBrowserContexts", () => {
  it("lazily shares one browser across concurrent isolated sessions and reuses each context", async () => {
    const browser = makeBrowser();
    const launch = Promise.withResolvers<Browser>();
    launches.launch.mockReturnValue(launch.promise);
    const configuration = options();
    const pool = new ServerBrowserContexts(configuration);
    expect(configuration.executable).not.toHaveBeenCalled();
    const first = pool.contextFor("default", "agent-a");
    const again = pool.contextFor("default", "agent-a");
    const second = pool.contextFor("default", "agent-b");
    const incognito = pool.contextFor(INCOGNITO_BROWSER_PROFILE_ID);
    launch.resolve(browser as unknown as Browser);
    const [a, reused, b, privateContext] = await Promise.all([first, again, second, incognito]);
    expect(a).toBe(reused);
    expect(new Set([a, b, privateContext]).size).toBe(3);
    expect(launches.launch).toHaveBeenCalledTimes(1);
    expect(launches.persistent).not.toHaveBeenCalled();
    expect(browser.newContext).toHaveBeenCalledWith({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });
    await pool.close();
    expect(browser.close).toHaveBeenCalledTimes(1);
    for (const context of browser.created) expect(context.close).toHaveBeenCalled();
  });

  it("keeps human profiles persistent without sharing their storage with agents", async () => {
    const human = makeContext();
    const browser = makeBrowser();
    launches.persistent.mockResolvedValue(human as unknown as BrowserContext);
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const pool = new ServerBrowserContexts(options());
    const persistent = await pool.contextFor("work/team");
    expect(await pool.contextFor("work/team")).toBe(persistent);
    expect(await pool.contextFor("work/team", "agent")).not.toBe(persistent);
    expect(launches.persistent).toHaveBeenCalledExactlyOnceWith(
      "/test/profiles/work%2Fteam",
      expect.objectContaining({ chromiumSandbox: true, executablePath: "/test/chromium" }),
    );
    expect(launches.mkdir).toHaveBeenCalledWith("/test/profiles/work%2Fteam", { recursive: true });
    await pool.close();
    expect(human.close).toHaveBeenCalledTimes(1);
  });

  it("clears a profile by closing its open context before deleting its storage", async () => {
    const human = makeContext();
    const browser = makeBrowser();
    launches.persistent.mockResolvedValue(human as unknown as BrowserContext);
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const onContextClose = vi.fn();
    const pool = new ServerBrowserContexts({ ...options(), onContextClose });
    const persistent = await pool.contextFor("work/team");
    const agent = await pool.contextFor("work/team", "agent");
    launches.rm.mockImplementationOnce(async () => {
      expect(human.close).toHaveBeenCalledTimes(1);
    });
    await pool.clearProfile("work/team");
    expect(onContextClose).toHaveBeenCalledExactlyOnceWith(persistent);
    expect(launches.rm).toHaveBeenCalledExactlyOnceWith("/test/profiles/work%2Fteam", {
      recursive: true,
      force: true,
    });
    expect(await pool.contextFor("work/team", "agent")).toBe(agent);
    expect(browser.created[0]?.close).not.toHaveBeenCalled();
    launches.persistent.mockResolvedValue(makeContext() as unknown as BrowserContext);
    expect(await pool.contextFor("work/team")).not.toBe(persistent);
    await pool.clearProfile("never-opened");
    expect(launches.rm).toHaveBeenLastCalledWith("/test/profiles/never-opened", {
      recursive: true,
      force: true,
    });
    await pool.close();
  });

  it("opens a profile requested during its clear only after the storage is deleted", async () => {
    launches.persistent.mockImplementation(async () => makeContext() as unknown as BrowserContext);
    const configuration = options();
    const pool = new ServerBrowserContexts(configuration);
    await pool.contextFor("work/team");
    const removing = Promise.withResolvers<void>();
    const removed = Promise.withResolvers<void>();
    let deleted = false;
    launches.rm.mockImplementationOnce(async () => {
      removing.resolve();
      await removed.promise;
      deleted = true;
    });
    const launchedAfterDelete: Array<boolean> = [];
    configuration.executable.mockImplementation(async () => {
      launchedAfterDelete.push(deleted);
      return "/test/chromium";
    });
    const clearing = pool.clearProfile("work/team");
    const reopening = pool.contextFor("work/team");
    await removing.promise;
    removed.resolve();
    await Promise.all([clearing, reopening]);
    expect(launchedAfterDelete).toEqual([true]);
    await pool.close();
  });

  it.each([undefined, "default"])(
    "never retries a failed %s launch with the sandbox disabled",
    async (profile) => {
      const launch = profile ? launches.persistent : launches.launch;
      launch.mockRejectedValue(new Error("sandbox unavailable"));
      const pool = new ServerBrowserContexts(options());
      await expect(pool.contextFor(profile ?? INCOGNITO_BROWSER_PROFILE_ID)).rejects.toThrow(
        "sandbox unavailable",
      );
      expect(launch).toHaveBeenCalledTimes(1);
      expect(
        profile ? launches.persistent.mock.calls[0]?.[1] : launches.launch.mock.calls[0]?.[0],
      ).toMatchObject({ chromiumSandbox: true });
      await pool.close();
    },
  );

  it("allows only an explicit sandbox opt-out", async () => {
    const browser = makeBrowser();
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const pool = new ServerBrowserContexts({
      ...options(),
      env: { BUSYBOY_SERVER_BROWSER_SANDBOX: "0" },
    });
    await pool.contextFor(INCOGNITO_BROWSER_PROFILE_ID);
    expect(launches.launch).toHaveBeenCalledWith(
      expect.objectContaining({ chromiumSandbox: false }),
    );
    await pool.close();
  });

  it("retries a failed startup on a later request with sandboxing still enabled", async () => {
    const browser = makeBrowser();
    launches.launch
      .mockRejectedValueOnce(new Error("executable unavailable"))
      .mockResolvedValue(browser as unknown as Browser);
    const pool = new ServerBrowserContexts(options());
    await expect(pool.contextFor("default", "agent")).rejects.toThrow("executable unavailable");
    await pool.contextFor("default", "agent");
    expect(launches.launch).toHaveBeenCalledTimes(2);
    expect(launches.launch).toHaveBeenLastCalledWith(
      expect.objectContaining({ chromiumSandbox: true }),
    );
    await pool.close();
  });

  it("evicts a closed context without closing other agents or relaunching chromium", async () => {
    const browser = makeBrowser();
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const onContextClose = vi.fn();
    const pool = new ServerBrowserContexts({ ...options(), onContextClose });
    const a = await pool.contextFor("default", "agent-a");
    const b = await pool.contextFor("default", "agent-b");
    await a.close();
    expect(onContextClose).toHaveBeenCalledWith(a);
    expect(await pool.contextFor("default", "agent-a")).not.toBe(a);
    expect(await pool.contextFor("default", "agent-b")).toBe(b);
    expect(browser.close).not.toHaveBeenCalled();
    expect(launches.launch).toHaveBeenCalledTimes(1);
    await pool.close();
  });

  it("cleans up a browser whose launch finishes during shutdown and rejects future work", async () => {
    const browser = makeBrowser();
    const launch = Promise.withResolvers<Browser>();
    launches.launch.mockReturnValue(launch.promise);
    const pool = new ServerBrowserContexts(options());
    const opening = expect(pool.contextFor("default", "agent")).rejects.toThrow("closed");
    const closing = pool.close();
    launch.resolve(browser as unknown as Browser);
    await Promise.all([opening, closing]);
    await expect(pool.contextFor("default", "agent")).rejects.toThrow("closed");
    await pool.close();
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(browser.created[0]?.close).toHaveBeenCalled();
  });

  describe("when idle", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      return () => vi.useRealTimers();
    });

    it("closes a profile's browser after its last tab closes and relaunches it on demand", async () => {
      const human = makeContext();
      launches.persistent.mockResolvedValueOnce(human as unknown as BrowserContext);
      const pool = new ServerBrowserContexts({ ...options(), idleCloseMs: 1_000 });
      await pool.contextFor("work");
      const first = human.openPage();
      const second = human.openPage();

      await first.close();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(human.close).not.toHaveBeenCalled();

      await second.close();
      await vi.advanceTimersByTimeAsync(999);
      expect(human.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(human.close).toHaveBeenCalledTimes(1);

      const relaunched = makeContext();
      launches.persistent.mockResolvedValueOnce(relaunched as unknown as BrowserContext);
      expect(await pool.contextFor("work")).toBe(relaunched);
      expect(launches.persistent).toHaveBeenCalledTimes(2);
      await pool.close();
    });

    it("keeps a context that was just handed out until its tab has had time to open", async () => {
      const human = makeContext();
      launches.persistent.mockResolvedValueOnce(human as unknown as BrowserContext);
      const pool = new ServerBrowserContexts({ ...options(), idleCloseMs: 1_000 });
      await pool.contextFor("work");
      await vi.advanceTimersByTimeAsync(800);
      expect(await pool.contextFor("work")).toBe(human);
      await vi.advanceTimersByTimeAsync(800);
      expect(human.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(200);
      expect(human.close).toHaveBeenCalledTimes(1);
      await pool.close();
    });

    it("closes the shared browser once its last context closes and relaunches it lazily", async () => {
      const browser = makeBrowser();
      launches.launch.mockResolvedValueOnce(browser as unknown as Browser);
      const pool = new ServerBrowserContexts({ ...options(), idleCloseMs: 1_000 });
      const a = await pool.contextFor("default", "agent-a");
      const b = await pool.contextFor("default", "agent-b");
      // Each agent tab keeps a page open in its own context.
      for (const context of browser.created) context.openPage();

      await a.close();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(browser.close).not.toHaveBeenCalled();

      await b.close();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(browser.close).toHaveBeenCalledTimes(1);

      const next = makeBrowser();
      launches.launch.mockResolvedValueOnce(next as unknown as Browser);
      await pool.contextFor("default", "agent-c");
      expect(launches.launch).toHaveBeenCalledTimes(2);
      expect(next.newContext).toHaveBeenCalledTimes(1);
      await pool.close();
      expect(next.close).toHaveBeenCalledTimes(1);
    });
  });
});
