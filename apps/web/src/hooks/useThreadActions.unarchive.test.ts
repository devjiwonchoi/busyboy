import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useThreadActions } from "./useThreadActions";
import { threadEnvironment } from "../state/threads";

const unarchive = vi.hoisted(() => vi.fn());
const confirm = vi.hoisted(() => vi.fn());
const activeThreads = vi.hoisted(
  () => [] as Array<{ id: string; environmentId: string; worktreePath: string | null }>,
);
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
vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate: vi.fn() }) }));
vi.mock("./useSettings", () => ({ useClientSettings: () => false }));
vi.mock("./useHandleNewThread", () => ({ useNewThreadHandler: () => vi.fn() }));
vi.mock("../composerDraftStore", () => ({ useComposerDraftStore: () => vi.fn() }));
vi.mock("../terminalUiStateStore", () => ({ useTerminalUiStateStore: () => vi.fn() }));
vi.mock("../uiStateStore", () => ({ useUiStateStore: () => vi.fn() }));
vi.mock("../lib/archivedThreadsState", () => ({ refreshArchivedThreadsForEnvironment: vi.fn() }));
vi.mock("../localApi", () => ({ readLocalApi: () => ({ dialogs: { confirm } }) }));
vi.mock("../state/entities", async (original) => ({
  ...(await original<typeof import("../state/entities")>()),
  readEnvironmentThreadRefs: () =>
    activeThreads.map((thread) => ({
      environmentId: thread.environmentId,
      threadId: thread.id,
    })),
  readThreadShell: (ref: { threadId: string }) =>
    activeThreads.find((thread) => thread.id === ref.threadId) ?? null,
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === threadEnvironment.unarchive ? unarchive : vi.fn(),
}));

const environmentId = EnvironmentId.make("unarchive-env");
const archivedThread = {
  environmentId,
  id: ThreadId.make("archived"),
  worktreePath: "/worktrees/repo/feature",
  branch: "feature",
};

beforeEach(() => {
  unarchive.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  confirm.mockReset();
  activeThreads.length = 0;
});

describe("confirmAndUnarchiveThread", () => {
  it.each([true, false])("passes the restore answer %s to unarchive", async (answer) => {
    confirm.mockResolvedValue(answer);
    await useThreadActions().confirmAndUnarchiveThread(archivedThread);
    expect(confirm).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("Restore this thread's worktree?"),
    );
    expect(unarchive).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { threadId: archivedThread.id, restoreWorktree: answer },
    });
  });

  it("does not ask for a thread without a worktree", async () => {
    await useThreadActions().confirmAndUnarchiveThread({
      ...archivedThread,
      worktreePath: null,
      branch: null,
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(unarchive).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { threadId: archivedThread.id },
    });
  });

  it("does not ask when an active thread kept the shared worktree", async () => {
    activeThreads.push({
      id: "sibling",
      environmentId,
      worktreePath: archivedThread.worktreePath,
    });
    await useThreadActions().confirmAndUnarchiveThread(archivedThread);
    expect(confirm).not.toHaveBeenCalled();
    expect(unarchive).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { threadId: archivedThread.id },
    });
  });
});
