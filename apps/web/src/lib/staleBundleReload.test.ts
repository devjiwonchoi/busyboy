import { describe, expect, it, vi } from "vite-plus/test";

import { reloadOnceForNewerServer } from "./staleBundleReload";

function createStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

describe("reloadOnceForNewerServer", () => {
  it("reloads once per version pair and allows a later update to reload again", () => {
    const storage = createStorageStub();
    const reload = vi.fn();
    const input = {
      clientVersion: "0.0.17",
      serverVersion: "0.0.18",
      getStorage: () => storage,
      reload,
    };

    expect(reloadOnceForNewerServer(input)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.getItem("busyboy:stale-bundle-reloaded")).toBe("0.0.17->0.0.18");

    expect(reloadOnceForNewerServer(input)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);

    expect(
      reloadOnceForNewerServer({
        ...input,
        clientVersion: "0.0.18",
        serverVersion: "0.0.19",
      }),
    ).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
    expect(storage.getItem("busyboy:stale-bundle-reloaded")).toBe("0.0.18->0.0.19");
  });

  it.each([
    { clientVersion: "0.0.18", serverVersion: "0.0.18" },
    { clientVersion: "0.0.19", serverVersion: "0.0.18" },
    { isElectron: true },
    { isHostedStatic: true },
    { clientVersion: "0.0.0" },
    { serverVersion: null },
    { serverVersion: undefined },
    { serverVersion: "" },
    { serverVersion: "   " },
    { clientVersion: "" },
    { clientVersion: "   " },
    { clientVersion: "invalid" },
    { serverVersion: "invalid" },
  ])("skips reload for an excluded client or version: %j", (overrides) => {
    const getStorage = vi.fn(createStorageStub);
    const reload = vi.fn();

    expect(
      reloadOnceForNewerServer({
        clientVersion: "0.0.17",
        serverVersion: "0.0.18",
        getStorage,
        reload,
        ...overrides,
      }),
    ).toBe(false);
    expect(reload).toHaveBeenCalledTimes(0);
    expect(getStorage).toHaveBeenCalledTimes(0);
  });

  it.each(["access", "read", "write"])("skips reload when storage %s throws", (failure) => {
    const storage = createStorageStub();
    const reload = vi.fn();
    const blocked = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    if (failure === "read") {
      storage.getItem = blocked;
    }
    if (failure === "write") {
      storage.setItem = blocked;
    }

    expect(
      reloadOnceForNewerServer({
        clientVersion: "0.0.17",
        serverVersion: "0.0.18",
        getStorage: failure === "access" ? blocked : () => storage,
        reload,
      }),
    ).toBe(false);
    expect(reload).toHaveBeenCalledTimes(0);
  });
});
