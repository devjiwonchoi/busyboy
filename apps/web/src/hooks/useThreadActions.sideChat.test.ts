import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useThreadActions } from "./useThreadActions";
import { useThreadUndoNotice } from "./showThreadUndoNotice";
import { useSideChatStore } from "../sideChatStore";
import { threadEnvironment } from "../state/threads";

const commands = vi.hoisted(() => ({
  archive: vi.fn(),
  unarchive: vi.fn(),
  delete: vi.fn(),
}));
// The active shells by thread id; archiving or deleting removes a thread, as the shell stream does.
const shells = vi.hoisted(() => new Map<string, Record<string, unknown>>());
const router = vi.hoisted(() => ({
  navigate: vi.fn(async () => {}),
  state: { matches: [{ params: {} as Record<string, string> }] },
}));
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/session", async (original) => ({
  ...(await original<typeof import("../state/session")>()),
  readEnvironmentScope: () => true,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useCallback: (callback: unknown) => callback,
  useMemo: (create: () => unknown) => create(),
  useRef: (value: unknown) => ({ current: value }),
}));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => router }));
vi.mock("./useSettings", () => ({ useClientSettings: () => false }));
vi.mock("./useHandleNewThread", () => ({ useNewThreadHandler: () => vi.fn() }));
vi.mock("../composerDraftStore", () => ({ useComposerDraftStore: () => vi.fn() }));
vi.mock("../terminalUiStateStore", () => ({ useTerminalUiStateStore: () => vi.fn() }));
vi.mock("../uiStateStore", () => ({ useUiStateStore: () => vi.fn() }));
vi.mock("../lib/archivedThreadsState", () => ({ refreshArchivedThreadsForEnvironment: vi.fn() }));
vi.mock("../lib/composerDraftUploads", () => ({ releaseComposerDraftUploads: vi.fn() }));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  readThreadShell: ((ref: { threadId: string }) => shells.get(ref.threadId) ?? null) as never,
  readEnvironmentThreadRefs: ((environmentId: string) =>
    [...shells.keys()].map((threadId) => ({ environmentId, threadId }))) as never,
  readProject: () => null,
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => {
    switch (command) {
      case threadEnvironment.archive:
        return commands.archive;
      case threadEnvironment.unarchive:
        return commands.unarchive;
      case threadEnvironment.delete:
        return commands.delete;
      default:
        return vi.fn();
    }
  },
}));

const environmentId = EnvironmentId.make("environment");
const thread = { environmentId, threadId: ThreadId.make("thread") };
const sideChat = { environmentId, threadId: ThreadId.make("side-chat") };
const shell = (id: string) => ({
  id,
  environmentId,
  projectId: "project",
  title: id,
  runtime: null,
  worktreePath: "/work/tree",
  archivedAt: null,
});
const threadIdsOf = (command: ReturnType<typeof vi.fn>) =>
  command.mock.calls.map(([call]) => (call as { input: { threadId: string } }).input.threadId);

beforeEach(() => {
  vi.useFakeTimers();
  shells.clear();
  shells.set(thread.threadId, shell(thread.threadId));
  shells.set(sideChat.threadId, shell(sideChat.threadId));
  useSideChatStore.setState({ parentByThreadKey: {} });
  useSideChatStore.getState().register(sideChat, thread);
  for (const [name, command] of Object.entries(commands)) {
    command.mockReset().mockImplementation(async (call: { input: { threadId: string } }) => {
      if (name !== "unarchive") shells.delete(call.input.threadId);
      return { _tag: "Success", value: undefined };
    });
  }
  router.state.matches[0]!.params = {};
});
afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a thread's side chats", () => {
  it("are archived before the thread so its worktree can be cleaned up", async () => {
    await useThreadActions().archiveThread(thread);
    expect(threadIdsOf(commands.archive)).toEqual([sideChat.threadId, thread.threadId]);
  });

  it("come back when the thread's archive is undone", async () => {
    await useThreadActions().archiveThread(thread);
    await useThreadUndoNotice.getState().notice!.undo();
    expect(threadIdsOf(commands.unarchive)).toEqual([thread.threadId, sideChat.threadId]);
  });

  it("are deleted with the thread and never chosen as the place to land", async () => {
    router.state.matches[0]!.params = { environmentId, threadId: thread.threadId };
    await useThreadActions().deleteThread(thread);
    expect(threadIdsOf(commands.delete)).toEqual([thread.threadId, sideChat.threadId]);
    // With only its side chat left, deleting the open thread goes home rather than to the side chat.
    expect(router.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/", replace: true });
  });
});
