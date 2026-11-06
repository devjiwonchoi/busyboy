import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ProjectTeamAttentionSummary } from "@t3tools/contracts";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

// The fake server: applies a settings patch the way ProjectTeamService.applySettings does.
const server = vi.hoisted(() => ({
  patches: [] as Array<unknown>,
  apply: (_patch: { autoApprovePlans?: { hours: number | null } | null }) => {},
}));

vi.mock(import("../../state/projectTeam"), async (original) => ({
  ...(await original()),
  useUpdateTeamSettings: (() => (_ref: unknown, patch: never) => {
    server.patches.push(patch);
    server.apply(patch);
    return Promise.resolve();
  }) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
}));

import { makeProjectManagerSummaryFixture } from "../../test-fixtures";
import { AutoApprovePlansBanner } from "./AutoApprovePlans";
import { SitrepIntervalPicker, SitrepSettingsContent } from "./SitrepIntervalPicker";

const projectRef = scopeProjectRef("env-1" as never, "project-1" as never);

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  server.patches = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** The PM chat's composer area: the real banner above the real settings control. */
function PmComposer(props: { compact: boolean; initial?: ProjectTeamAttentionSummary }) {
  const [summary, setSummary] = useState(props.initial ?? makeProjectManagerSummaryFixture());
  server.apply = (patch) => {
    if (patch.autoApprovePlans === undefined) return;
    setSummary((current) => {
      const { autoApprovePlans: _old, ...settings } = current.settings;
      const choice = patch.autoApprovePlans;
      if (choice === null || choice === undefined) return { ...current, settings };
      const since = new Date().toISOString();
      const until =
        choice.hours === null
          ? null
          : new Date(Date.now() + choice.hours * 3_600_000).toISOString();
      return { ...current, settings: { ...settings, autoApprovePlans: { since, until } } };
    });
  };
  return (
    <div className="mx-auto w-full max-w-2xl p-3">
      <AutoApprovePlansBanner projectRef={projectRef} summary={summary} />
      <div className="rounded-xl border p-2">
        {props.compact ? (
          // Phones show the sitrep settings inside the composer's overflow menu.
          <SitrepSettingsContent projectRef={projectRef} summary={summary} />
        ) : (
          <SitrepIntervalPicker projectRef={projectRef} summary={summary} />
        )}
      </div>
    </div>
  );
}

const banner = () => page.getByRole("status").filter({ hasText: "Auto-approving plans" });

describe("Auto-approve plans in the PM chat", () => {
  it("turns on for 8 hours from the composer menu, shows the banner, and turns off", async () => {
    await page.viewport(1280, 800);
    await act(() => root.render(<PmComposer compact={false} />));
    await expect.element(banner()).not.toBeInTheDocument();

    await userEvent.click(page.getByRole("button", { name: /Sitrep/ }));
    const off = page.getByRole("radio", { name: "Off" });
    await expect.element(off).toHaveAttribute("aria-checked", "true");
    await userEvent.click(page.getByRole("radio", { name: "8 hours" }));
    expect(server.patches).toEqual([{ autoApprovePlans: { hours: 8 } }]);

    await expect.element(banner()).toBeVisible();
    await expect.element(banner().getByText(/^Auto-approving plans until \S*\d/)).toBeVisible();
    await expect.element(page.getByText(/^On until /)).toBeVisible();
    await expect
      .element(page.getByRole("radio", { name: "8 hours" }))
      .toHaveAttribute("aria-checked", "true");

    await userEvent.click(page.getByRole("button", { name: "Turn off" }));
    expect(server.patches.at(-1)).toEqual({ autoApprovePlans: null });
    await expect.element(banner()).not.toBeInTheDocument();
    await expect.element(off).toHaveAttribute("aria-checked", "true");
  });

  it("works at phone width: until I turn it off, banner fits the screen", async () => {
    await page.viewport(390, 844);
    await act(() => root.render(<PmComposer compact />));

    await userEvent.click(page.getByRole("radio", { name: "Until I turn it off" }));
    expect(server.patches).toEqual([{ autoApprovePlans: { hours: null } }]);
    await expect
      .element(banner().getByText("Auto-approving plans until you turn it off"))
      .toBeVisible();
    await expect
      .element(page.getByRole("radio", { name: "Until I turn it off" }))
      .toHaveAttribute("aria-checked", "true");
    const rect = banner().element().getBoundingClientRect();
    expect(rect.right).toBeLessThanOrEqual(390);
    await expect.element(page.getByRole("button", { name: "Turn off" })).toBeVisible();
  });

  it("hides the banner by itself when the window ends", async () => {
    await page.viewport(1280, 800);
    const until = new Date(Date.now() + 1_500).toISOString();
    const initial = makeProjectManagerSummaryFixture();
    await act(() =>
      root.render(
        <PmComposer
          compact
          initial={{
            ...initial,
            settings: {
              ...initial.settings,
              autoApprovePlans: { since: new Date().toISOString(), until },
            },
          }}
        />,
      ),
    );
    await expect.element(banner()).toBeVisible();
    await expect.element(banner(), { timeout: 4_000 }).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("radio", { name: "Off" }))
      .toHaveAttribute("aria-checked", "true");
  });
});
