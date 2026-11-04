import {
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  type BrowserLoginSummary,
  type BrowserNeverSaveEntry,
  type BrowserPasswordsAddInput,
  type BrowserPasswordsChangedEvent,
  type BrowserPasswordsIdsInput,
  type BrowserPasswordsListInput,
  type BrowserPasswordsProfileInput,
  type BrowserPasswordsUpdateInput,
  type BrowserPasswordsStatus,
  type DesktopBrowserPasswordsBridge,
} from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

vi.mock(import("../../env"), async (original) => ({ ...(await original()), isElectron: true }));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({
    environments: [{ environmentId: ENVIRONMENT_ID, label: "Local" }],
    isReady: true,
  })) as never,
  usePrimaryEnvironment: () => null,
  usePrimaryEnvironmentId: () => null,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useClientSettings: ((selector?: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
    selector ? selector(DEFAULT_CLIENT_SETTINGS) : DEFAULT_CLIENT_SETTINGS) as never,
  useClientSettingsHydrated: () => true,
  usePrimarySettingsAvailable: () => true,
  usePrimarySettings: (() => DEFAULT_UNIFIED_SETTINGS) as never,
  useUpdatePrimarySettings: (() => vi.fn()) as never,
}));
const toasts = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: toasts.add } as never };
});
vi.mock(import("./ProjectDefaultsSettings"), async (original) => ({
  ...(await original()),
  ProjectDefaultsSettings: (() => null) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { kind: "all", environmentIds: [] },
    search: {},
    environment: null,
    environments: [],
    target: null,
    connectedEnvironments: [],
    targets: [],
  })) as never,
  useOptionalSettingsScope: () => null,
}));

import { IntegrationsSettingsPanel } from "./IntegrationsSettings";

const HOUR = 3_600_000;

function login(
  id: number,
  origin: string,
  username: string,
  lastUsedAt: number | null,
): BrowserLoginSummary {
  return {
    id,
    origin,
    signonRealm: origin,
    username,
    createdAt: Date.now() - 48 * HOUR,
    updatedAt: Date.now() - 48 * HOUR,
    lastUsedAt,
    lastFilledAt: lastUsedAt,
    timesUsed: lastUsedAt === null ? 0 : 1,
    source: "manual",
    hasNote: false,
  };
}

/**
 * An in-memory stand-in for the desktop vault. Passwords stay inside it; the
 * device check is scripted through `gateAnswers` (true = approved).
 */
function createFakePasswordsBridge(options: {
  readonly logins: ReadonlyArray<BrowserLoginSummary>;
  readonly passwords: Readonly<Record<number, string>>;
  readonly neverSave?: ReadonlyArray<BrowserNeverSaveEntry>;
  readonly status?: BrowserPasswordsStatus;
  readonly gateAnswers?: Array<boolean>;
}) {
  let logins = [...options.logins];
  let neverSave = [...(options.neverSave ?? [])];
  const passwords = new Map(Object.entries(options.passwords).map(([k, v]) => [Number(k), v]));
  const gateAnswers = options.gateAnswers ?? [];
  const gate = () => gateAnswers.shift() ?? true;
  const listeners = new Set<(event: BrowserPasswordsChangedEvent) => void>();
  const emit = (profileId: string) => {
    for (const listener of listeners) listener({ profileId });
  };
  let nextId = 100;
  const bridge = {
    status: vi.fn(
      async () =>
        options.status ?? ({ available: true, touchIdAvailable: true } as BrowserPasswordsStatus),
    ),
    list: vi.fn(async (input: BrowserPasswordsListInput) => {
      const query = input.query?.toLowerCase() ?? "";
      return logins.filter(
        (candidate) =>
          query.length === 0 ||
          candidate.origin.toLowerCase().includes(query) ||
          candidate.username.toLowerCase().includes(query),
      );
    }),
    add: vi.fn(async (input: BrowserPasswordsAddInput) => {
      let origin: string;
      try {
        origin = new URL(input.url).origin;
      } catch {
        return { kind: "invalidUrl" as const };
      }
      if (origin.startsWith("http://") && !origin.includes("localhost") && !input.allowInsecure) {
        return { kind: "insecure" as const, origin };
      }
      const existing = logins.find(
        (candidate) => candidate.origin === origin && candidate.username === input.username,
      );
      if (existing && !input.replaceExisting)
        return { kind: "duplicate" as const, id: existing.id };
      if (existing) {
        passwords.set(existing.id, input.password);
        emit(input.profileId);
        return { kind: "updated" as const, id: existing.id };
      }
      const id = nextId++;
      logins = [...logins, login(id, origin, input.username, null)];
      passwords.set(id, input.password);
      emit(input.profileId);
      return { kind: "added" as const, id };
    }),
    update: vi.fn(async (input: BrowserPasswordsUpdateInput) => {
      const current = logins.find((candidate) => candidate.id === input.id);
      if (!current) return { kind: "notFound" as const };
      if (input.username !== undefined) {
        const clash = logins.find(
          (candidate) =>
            candidate.id !== input.id &&
            candidate.origin === current.origin &&
            candidate.username === input.username,
        );
        if (clash) return { kind: "duplicate" as const, id: clash.id };
        logins = logins.map((candidate) =>
          candidate.id === input.id ? { ...candidate, username: input.username! } : candidate,
        );
      }
      if (input.password !== undefined) passwords.set(input.id, input.password);
      emit(input.profileId);
      return { kind: "updated" as const };
    }),
    remove: vi.fn(async (input: BrowserPasswordsIdsInput) => {
      logins = logins.filter((candidate) => !input.ids.includes(candidate.id));
      emit(input.profileId);
    }),
    note: vi.fn(async () => ({ note: "" })),
    reveal: vi.fn(async (input: { id: number }) => {
      if (!gate()) return { kind: "cancelled" as const };
      const password = passwords.get(input.id);
      return password === undefined
        ? { kind: "notFound" as const }
        : { kind: "revealed" as const, password };
    }),
    copy: vi.fn(async () => (gate() ? { kind: "done" as const } : { kind: "cancelled" as const })),
    deleteAll: vi.fn(async (input: BrowserPasswordsProfileInput) => {
      if (!gate()) return { kind: "cancelled" as const };
      const count = logins.length;
      logins = [];
      emit(input.profileId);
      return { kind: "deleted" as const, count };
    }),
    neverSave: {
      list: vi.fn(async () => neverSave),
      remove: vi.fn(async (input: BrowserPasswordsIdsInput) => {
        neverSave = neverSave.filter((entry) => !input.ids.includes(entry.id));
        emit(input.profileId);
      }),
    },
    onChanged: (listener: (event: BrowserPasswordsChangedEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    autofill: {
      onEvent: () => () => {},
      choose: vi.fn(async () => {}),
      dismissFillList: vi.fn(async () => {}),
      respondToPrompt: vi.fn(async () => {}),
      peek: vi.fn(async () => ({ password: null })),
      reopenPrompt: vi.fn(async () => {}),
      signInOptions: vi.fn(async () => ({ available: false, logins: [] })),
      signIn: vi.fn(async () => ({ outcome: "unavailable" as const })),
    },
  } satisfies DesktopBrowserPasswordsBridge;
  return bridge;
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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

async function openSettings() {
  const router = createRouter({
    routeTree: createRootRoute({ component: IntegrationsSettingsPanel }),
    history: createMemoryHistory(),
  });
  await router.load();
  await act(async () => root.render(<RouterProvider router={router} />));
}

function passwordRows(): string[] {
  const list = container.querySelector('[role="list"][aria-label="Saved passwords"]');
  return [...(list?.querySelectorAll('[role="listitem"]') ?? [])].map(
    (row) =>
      `${row.querySelector('[data-slot="site"]')?.textContent} ${row.querySelector('[data-slot="username"]')?.textContent}`,
  );
}

describe("Settings → Passwords", () => {
  it("searches, edits, reveals, copies and deletes a saved password", async () => {
    const bridge = createFakePasswordsBridge({
      logins: [
        login(1, "https://accounts.example.com", "alice", Date.now() - 2 * HOUR),
        login(2, "https://accounts.example.com", "carol", null),
        login(3, "https://docs.example.org", "bob", null),
      ],
      passwords: { 1: "alice-secret", 2: "carol-secret", 3: "bob-secret" },
      neverSave: [{ id: 7, origin: "https://bank.example.net", createdAt: Date.now() }],
      // Reveal: declined, then approved. Copy: approved.
      gateAnswers: [false, true, true],
    });
    (window as { desktopBridge?: unknown }).desktopBridge = { browserPasswords: bridge };

    await openSettings();
    await vi.waitFor(() =>
      expect(passwordRows()).toEqual([
        "accounts.example.com alice",
        "accounts.example.com carol",
        "docs.example.org bob",
      ]),
    );
    expect(bridge.status).toHaveBeenCalledWith({ profileId: "default" });
    await expect.element(page.getByTitle("Last used").first()).toHaveTextContent("2h ago");
    await expect.element(page.getByTitle("Last used").nth(1)).toHaveTextContent("Never");
    await expect
      .element(page.getByText("Importing or exporting passwords as CSV isn’t available."))
      .toBeVisible();
    expect(page.getByRole("button", { name: /export/i }).elements()).toHaveLength(0);
    expect(page.getByRole("button", { name: /leaked/i }).elements()).toHaveLength(0);

    await userEvent.type(page.getByRole("searchbox", { name: "Search passwords" }), "bob");
    await vi.waitFor(() => expect(passwordRows()).toEqual(["docs.example.org bob"]));
    expect(bridge.list).toHaveBeenLastCalledWith({ profileId: "default", query: "bob" });
    await userEvent.clear(page.getByRole("searchbox", { name: "Search passwords" }));
    await vi.waitFor(() => expect(passwordRows()).toHaveLength(3));

    // Never saved: listed and removable.
    await userEvent.click(
      page.getByRole("button", { name: "Remove bank.example.net from never saved" }),
    );
    expect(bridge.neverSave.remove).toHaveBeenCalledExactlyOnceWith({
      profileId: "default",
      ids: [7],
    });

    await userEvent.click(page.getByRole("button", { name: "accounts.example.com, alice" }));
    const dialog = page.getByRole("dialog", { name: "accounts.example.com" });
    await expect.element(dialog).toBeVisible();
    expect(bridge.note).toHaveBeenCalledWith({ profileId: "default", id: 1 });

    // A username another saved login on the site uses is refused inline.
    const usernameField = dialog.getByRole("textbox", { name: "Username" });
    await userEvent.fill(usernameField, "carol");
    await userEvent.tab();
    await expect
      .element(dialog.getByText("Another saved password for this site already uses that username."))
      .toBeVisible();
    await userEvent.fill(usernameField, "alice@example.com");
    await userEvent.tab();
    await vi.waitFor(() =>
      expect(bridge.update).toHaveBeenLastCalledWith({
        profileId: "default",
        id: 1,
        username: "alice@example.com",
      }),
    );
    await vi.waitFor(() =>
      expect(passwordRows()[0]).toBe("accounts.example.com alice@example.com"),
    );

    // Reveal: the declined device check leaves the field masked.
    const passwordField = dialog.getByLabelText("Password", { exact: true });
    await userEvent.click(dialog.getByRole("button", { name: "Show password" }));
    await vi.waitFor(() => expect(bridge.reveal).toHaveBeenCalledTimes(1));
    await expect.element(passwordField).toHaveAttribute("type", "password");
    await expect.element(passwordField).toHaveValue("");
    await expect.element(dialog.getByRole("button", { name: "Show password" })).toBeEnabled();
    await userEvent.click(dialog.getByRole("button", { name: "Show password" }));
    await expect.element(passwordField).toHaveValue("alice-secret");
    await expect.element(passwordField).toHaveAttribute("type", "text");

    await userEvent.click(dialog.getByRole("button", { name: "Copy password" }));
    expect(bridge.copy).toHaveBeenCalledExactlyOnceWith({ profileId: "default", id: 1 });
    await expect.element(dialog.getByRole("button", { name: "Copied" })).toBeVisible();

    await userEvent.click(dialog.getByRole("button", { name: "Delete…" }));
    const confirm = page.getByRole("alertdialog", {
      name: "Delete the password for accounts.example.com?",
    });
    await userEvent.click(confirm.getByRole("button", { name: "Delete", exact: true }));
    expect(bridge.remove).toHaveBeenCalledExactlyOnceWith({ profileId: "default", ids: [1] });
    await vi.waitFor(() =>
      expect(passwordRows()).toEqual(["accounts.example.com carol", "docs.example.org bob"]),
    );
    expect(page.getByRole("dialog", { name: "accounts.example.com" }).elements()).toHaveLength(0);
  }, 60_000);

  it("adds a password after confirming http and replacing a duplicate", async () => {
    const bridge = createFakePasswordsBridge({
      logins: [login(1, "http://router.example.com", "admin", null)],
      passwords: { 1: "old" },
    });
    (window as { desktopBridge?: unknown }).desktopBridge = { browserPasswords: bridge };

    await openSettings();
    await vi.waitFor(() => expect(passwordRows()).toEqual(["router.example.com admin"]));
    await userEvent.click(page.getByRole("button", { name: "Add password…" }));
    const dialog = page.getByRole("dialog", { name: "Add password" });
    await userEvent.fill(dialog.getByRole("textbox", { name: "Site" }), "not a url");
    await userEvent.fill(dialog.getByLabelText("Password", { exact: true }), "new-secret");
    await userEvent.click(dialog.getByRole("button", { name: "Save", exact: true }));
    await expect
      .element(dialog.getByText("Enter a site address, like https://example.com."))
      .toBeVisible();

    await userEvent.fill(
      dialog.getByRole("textbox", { name: "Site" }),
      "http://router.example.com/login",
    );
    await userEvent.fill(dialog.getByRole("textbox", { name: "Username" }), "admin");
    await userEvent.click(dialog.getByRole("button", { name: "Save", exact: true }));
    await expect.element(dialog.getByText(/uses http, which isn.t secure/)).toBeVisible();
    await userEvent.click(dialog.getByRole("button", { name: "Save anyway" }));
    await expect.element(dialog.getByText(/already saved\. Update it\?/)).toBeVisible();
    await userEvent.click(dialog.getByRole("button", { name: "Update existing" }));

    expect(bridge.add).toHaveBeenLastCalledWith({
      profileId: "default",
      url: "http://router.example.com/login",
      username: "admin",
      password: "new-secret",
      allowInsecure: true,
      replaceExisting: true,
    });
    await vi.waitFor(() =>
      expect(page.getByRole("dialog", { name: "Add password" }).elements()).toHaveLength(0),
    );

    // Delete all: the declined device check deletes nothing; approving clears the list.
    (
      bridge.deleteAll as { mockImplementationOnce: (fn: () => unknown) => void }
    ).mockImplementationOnce(async () => ({ kind: "cancelled" }));
    await userEvent.click(page.getByRole("button", { name: "Delete all passwords…" }));
    await userEvent.click(page.getByRole("button", { name: "Delete all", exact: true }));
    await vi.waitFor(() => expect(bridge.deleteAll).toHaveBeenCalledTimes(1));
    expect(passwordRows()).toEqual(["router.example.com admin"]);
    await userEvent.click(page.getByRole("button", { name: "Delete all passwords…" }));
    await userEvent.click(page.getByRole("button", { name: "Delete all", exact: true }));
    await vi.waitFor(() => expect(passwordRows()).toEqual([]));
    await vi.waitFor(() =>
      expect(toasts.add).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Deleted 1 password" }),
      ),
    );
  }, 60_000);

  it("explains why passwords are off when secure storage is unavailable", async () => {
    const bridge = createFakePasswordsBridge({
      logins: [],
      passwords: {},
      status: { available: false, reason: "encryptionUnavailable", touchIdAvailable: false },
    });
    (window as { desktopBridge?: unknown }).desktopBridge = { browserPasswords: bridge };

    await openSettings();
    await expect
      .element(page.getByText(/this computer.s secure storage isn.t available/))
      .toBeVisible();
    expect(page.getByRole("button", { name: "Add password…" }).elements()).toHaveLength(0);
    expect(page.getByRole("searchbox", { name: "Search passwords" }).elements()).toHaveLength(0);
    expect(bridge.list).not.toHaveBeenCalled();
  });
});
