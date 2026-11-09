import { RegistryProvider } from "@effect/atom-react";
import { matchComposerProjectItems } from "@t3tools/client-runtime/composerProjectItems";
import { matchComposerThreadItems } from "@t3tools/client-runtime/composerThreadItems";
import { EnvironmentId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { act, createRef, type ComponentProps, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { formatInlineContextReference } from "~/lib/composerContextReferences";
import { linkedContextReference, projectContextRecord } from "~/lib/composerContextRecords";
import { ComposerCommandMenu, type ComposerCommandItem } from "./ComposerCommandMenu";
import { MessagesTimeline } from "./MessagesTimeline";

// In the Director the user juggles next-bot and next-benchmarks, whose task keys are both
// NB. Typing @ offers the projects first; the sent message carries a project chip.

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const AT = "2026-11-09T10:00:00.000Z";
const PROJECTS = [
  { id: "p-next-bot", title: "next-bot" },
  { id: "p-next-benchmarks", title: "next-benchmarks" },
  { id: "p-busyboy", title: "busyboy" },
].map((project) => ({
  environmentId: ENVIRONMENT_ID,
  id: ProjectId.make(project.id),
  title: project.title,
  workspaceRoot: `/Users/me/code/${project.title}`,
}));

vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useProject: ((ref: { projectId: string } | null) =>
    PROJECTS.find((project) => project.id === ref?.projectId) ?? null) as never,
}));

const roots: Root[] = [];
let container: HTMLDivElement;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await page.viewport(900, 600);
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function render(element: ReactElement, height = 260) {
  container = document.body.appendChild(document.createElement("div"));
  container.style.cssText = `height: ${height}px; width: 640px; display: flex; flex-direction: column;`;
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<RegistryProvider>{element}</RegistryProvider>));
}

function menuItems(query: string): ComposerCommandItem[] {
  return [
    ...matchComposerProjectItems({ projects: PROJECTS, environmentId: ENVIRONMENT_ID, query }),
    ...matchComposerThreadItems({
      shells: [
        {
          environmentId: ENVIRONMENT_ID,
          id: ThreadId.make("t-1"),
          title: "next-bot deploy check",
          updatedAt: AT,
          archivedAt: null,
        },
      ],
      environmentId: ENVIRONMENT_ID,
      excludeThreadId: null,
      query,
    }),
  ];
}

const optionLabels = () =>
  [...container.querySelectorAll("[data-composer-item-id]")].map((option) =>
    option.getAttribute("data-composer-item-id"),
  );

describe("referencing a project with @", () => {
  it("lists projects first, then threads, filtered by the query", async () => {
    await render(
      <ComposerCommandMenu
        listId="composer-menu"
        items={menuItems("next-b")}
        resolvedTheme="dark"
        isLoading={false}
        triggerKind="path"
        activeItemId="project:environment-local:p-next-benchmarks"
        onHighlightedItemChange={() => {}}
        onSelect={() => {}}
      />,
    );
    expect(optionLabels()).toEqual([
      "project:environment-local:p-next-benchmarks",
      "project:environment-local:p-next-bot",
      "thread:environment-local:t-1",
    ]);
    expect(container.textContent).toContain("/Users/me/code/next-benchmarks");
  });

  it("shows the sent project reference as a folder chip with the project name", async () => {
    const record = projectContextRecord({
      environmentId: ENVIRONMENT_ID,
      projectId: PROJECTS[1]!.id,
      title: PROJECTS[1]!.title,
      workspaceRoot: PROJECTS[1]!.workspaceRoot,
    });
    const text = `Fix the failing runs in ${formatInlineContextReference(
      linkedContextReference(record),
    )}`;
    const props: ComponentProps<typeof MessagesTimeline> = {
      isWorking: false,
      activeTurnInProgress: false,
      listRef: createRef<LegendListRef | null>(),
      latestRun: null,
      turnDiffSummaries: [],
      runs: [],
      routeThreadKey: "environment-local:director",
      onOpenTurnDiff: () => {},
      onOpenThread: () => {},
      onForkFromRun: async () => {},
      onRollbackCheckpoint: () => {},
      supportsConversationRollback: false,
      onRevertToTurnCount: () => {},
      isRevertingCheckpoint: false,
      onImageExpand: () => {},
      activeThreadEnvironmentId: ENVIRONMENT_ID,
      markdownCwd: undefined,
      resolvedTheme: "dark",
      timestampFormat: "locale",
      workspaceRoot: undefined,
      anchorMessageId: null,
      onAnchorReady: () => {},
      onAnchorSizeChanged: () => {},
      contentInsetEndAdjustment: 0,
      liveFollowEnabled: true,
      onIsAtEndChange: () => {},
      onManualNavigation: () => {},
      timelineEntries: [
        {
          id: "entry-m-1",
          kind: "message",
          createdAt: AT,
          message: {
            id: MessageId.make("m-1"),
            role: "user",
            text,
            context: { version: 1, records: [record] },
            runId: null,
            createdAt: AT,
            updatedAt: AT,
            streaming: false,
          },
        },
      ] as never,
    };
    await render(<MessagesTimeline {...props} />, 200);
    await vi.waitFor(() =>
      expect(container.querySelector('[aria-label="Project, next-benchmarks"]')).not.toBeNull(),
    );
    expect(container.querySelector('[aria-label="Project, next-benchmarks"] svg')).not.toBeNull();
    expect(container.textContent).not.toContain("t3-context://");
  });
});
