import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { makeProjectManagerSummaryFixture } from "../../test-fixtures";
import { ProjectManagerHeaderIdentity } from "./ProjectManagerHeaderIdentity";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("project manager chat header", () => {
  it("shows the PM's name, project chip and presence, and opens its settings", async () => {
    const onOpenSettings = vi.fn();
    const summary = makeProjectManagerSummaryFixture({
      presence: {
        running: 2,
        waitingOnUser: 1,
        lastAction: {
          text: "nudged #5",
          at: new Date(Date.now() - 10 * 60_000).toISOString() as never,
        },
      },
    });
    await act(() =>
      root.render(
        <ProjectManagerHeaderIdentity
          summary={summary}
          projectName="busyboy"
          pmThreadWorking={false}
          onOpenSettings={onOpenSettings}
        />,
      ),
    );

    expect(container.querySelector("h2")?.textContent).toBe("Remy");
    expect(container.querySelector('[aria-label="Remy, needs you"]')).not.toBeNull();
    expect(container.textContent).toContain("PM · busyboy");
    expect(
      container.querySelector('[data-testid="project-manager-presence"]')?.textContent,
    ).toMatch(/^2 working · 1 needs you · last: nudged #5 · \d+m ago$/);

    await act(async () =>
      container.querySelector<HTMLButtonElement>('button[aria-label="Remy settings"]')!.click(),
    );
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it("says Idle when the team is quiet", async () => {
    await act(() =>
      root.render(
        <ProjectManagerHeaderIdentity
          summary={makeProjectManagerSummaryFixture()}
          projectName="busyboy"
          pmThreadWorking={false}
          onOpenSettings={null}
        />,
      ),
    );
    expect(container.querySelector('[data-testid="project-manager-presence"]')?.textContent).toBe(
      "Idle",
    );
    expect(container.querySelector('[aria-label="Remy, idle"]')).not.toBeNull();
    expect(container.querySelector("button")).toBeNull();
  });
});
