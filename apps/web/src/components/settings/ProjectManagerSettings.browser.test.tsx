import type { ProjectTeamAttentionSummary } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  updateSettings: vi.fn(),
}));

vi.mock(import("../../state/projectTeam"), async (original) => ({
  ...(await original()),
  useUpdateTeamSettings: (() => state.updateSettings) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
}));

import { makeProjectManagerSummaryFixture } from "../../test-fixtures";
import { ProjectManagerSettingsSection } from "./ProjectManagerSettings";

const projectRef = { environmentId: "env-1", projectId: "project-1" } as never;
let current: ProjectTeamAttentionSummary;
let root: Root;
let container: HTMLDivElement;

const renderSection = () =>
  act(() =>
    root.render(<ProjectManagerSettingsSection projectRef={projectRef} summary={current} />),
  );
const byLabel = <T extends Element>(label: string) =>
  document.querySelector<T>(`[aria-label="${label}"]`);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  current = makeProjectManagerSummaryFixture();
  // The server applies the patch and pushes the next summary.
  state.updateSettings.mockReset().mockImplementation(async (_ref, patch) => {
    current = makeProjectManagerSummaryFixture({
      enabled: patch.enabled ?? current.enabled,
      persona: { ...current.persona, ...patch.persona },
      taskKeyPrefix: patch.taskKeyPrefix ?? current.taskKeyPrefix,
    });
    await renderSection();
    return { _tag: "Success" };
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("project manager settings", () => {
  it("shows the project using a duplicate prefix and restores the saved value", async () => {
    current = makeProjectManagerSummaryFixture({ taskKeyPrefix: "BU" });
    await renderSection();
    state.updateSettings.mockResolvedValueOnce({
      _tag: "Failure",
      cause: Cause.fail(
        new Error("태스크 접두어 NB는 ‘next-benchmarks’ 프로젝트에서 사용 중입니다."),
      ),
    });
    const prefix = byLabel<HTMLInputElement>("Task key prefix")!;
    await userEvent.clear(prefix);
    await userEvent.type(prefix, "NB{Enter}");
    await vi.waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("next-benchmarks"),
    );
    expect(prefix.value).toBe("BU");
  });

  it("renames the PM on Enter and leaves an unchanged name alone", async () => {
    await renderSection();
    expect(container.textContent).toContain("You can also just tell Remy in chat.");
    const name = byLabel<HTMLInputElement>("Project manager name")!;
    await userEvent.click(name);
    await userEvent.tab();
    expect(state.updateSettings).not.toHaveBeenCalled();

    await userEvent.clear(name);
    await userEvent.type(name, "  Juno  {Enter}");
    expect(state.updateSettings).toHaveBeenCalledExactlyOnceWith(projectRef, {
      persona: { name: "Juno" },
    });
    expect(container.textContent).toContain("You can also just tell Juno in chat.");
  });

  it("saves the voice, and a custom voice from its text box", async () => {
    await renderSection();
    expect(byLabel("Custom voice")).toBeNull();
    await userEvent.click(
      document.querySelector<HTMLElement>(
        '[aria-label="Project manager voice"] button:nth-child(2)',
      )!,
    );
    expect(state.updateSettings).toHaveBeenLastCalledWith(projectRef, {
      persona: { voice: "dry" },
    });

    const custom = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Custom",
    )!;
    await userEvent.click(custom);
    expect(state.updateSettings).toHaveBeenLastCalledWith(projectRef, {
      persona: { voice: "custom" },
    });
    const textarea = byLabel<HTMLTextAreaElement>("Custom voice")!;
    await userEvent.type(textarea, "Pirate, but brief.");
    await userEvent.tab();
    expect(state.updateSettings).toHaveBeenLastCalledWith(projectRef, {
      persona: { voice: "custom", voiceCustom: "Pirate, but brief." },
    });
  });

  it("turns the project manager off and hides its persona settings", async () => {
    await renderSection();
    // The switch has no layout size in the test page, so it is clicked directly.
    await act(async () => byLabel<HTMLElement>("Project manager")!.click());
    expect(state.updateSettings).toHaveBeenCalledExactlyOnceWith(projectRef, { enabled: false });
    expect(byLabel("Project manager name")).toBeNull();
    expect(byLabel("Project manager voice")).toBeNull();
  });

  it("opens the icon picker for the avatar", async () => {
    await renderSection();
    await userEvent.click(byLabel<HTMLElement>("Choose an avatar")!);
    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
  });
  it("changes the task key prefix, uppercasing it and refusing an invalid one", async () => {
    current = makeProjectManagerSummaryFixture({ taskKeyPrefix: "BU" });
    await renderSection();
    expect(container.textContent).toContain("보조 키는 BU-7처럼 표시됩니다.");
    const prefix = byLabel<HTMLInputElement>("Task key prefix")!;

    await userEvent.clear(prefix);
    await userEvent.type(prefix, "7x{Enter}");
    expect(state.updateSettings).not.toHaveBeenCalled();
    expect(prefix.value).toBe("BU");

    await userEvent.clear(prefix);
    await userEvent.type(prefix, "bb{Enter}");
    expect(state.updateSettings).toHaveBeenCalledExactlyOnceWith(projectRef, {
      taskKeyPrefix: "BB",
    });
    expect(container.textContent).toContain("보조 키는 BB-7처럼 표시됩니다.");
  });
});
