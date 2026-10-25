import { assert, describe, it } from "@effect/vitest";

import {
  BUSYBOY_ORCHESTRATION_INSTRUCTIONS,
  busyboyAcpPromptWithInstructions,
  busyboyOrchestrationPromptForFirstRun,
  busyboyOrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("Busyboy orchestration provider instructions", () => {
  it("distinguishes delegated subagents from ordinary top-level threads", () => {
    assert.include(BUSYBOY_ORCHESTRATION_INSTRUCTIONS, "Use `delegate_task`");
    assert.include(BUSYBOY_ORCHESTRATION_INSTRUCTIONS, "ordinary top-level Busyboy conversations");
    assert.include(BUSYBOY_ORCHESTRATION_INSTRUCTIONS, "Never use them merely");
    assert.include(BUSYBOY_ORCHESTRATION_INSTRUCTIONS, "cross-provider");
    assert.include(BUSYBOY_ORCHESTRATION_INSTRUCTIONS, "call `delegate_task` again");
    assert.include(
      BUSYBOY_ORCHESTRATION_INSTRUCTIONS,
      "Do not use `busyboy_thread_send` on `childThreadId`",
    );
  });

  it("documents structured schedules instead of JSON strings", () => {
    assert.include(BUSYBOY_ORCHESTRATION_INSTRUCTIONS, "structured object, never as JSON text");
    assert.include(BUSYBOY_ORCHESTRATION_INSTRUCTIONS, '"everyMs":3600000');
    assert.include(BUSYBOY_ORCHESTRATION_INSTRUCTIONS, "bindToCurrentThread=false");
  });

  it("injects prompt fallback only for an MCP-enabled first run", () => {
    const prompt = "Inspect the repository.";
    const injected = busyboyOrchestrationPromptForFirstRun({
      prompt,
      runOrdinal: 1,
      hasBusyboyMcp: true,
    });

    assert.include(injected, "<busyboy_orchestration_instructions>");
    assert.include(injected, `<user_request>\n${prompt}\n</user_request>`);
    assert.equal(
      busyboyOrchestrationPromptForFirstRun({ prompt, runOrdinal: 2, hasBusyboyMcp: true }),
      prompt,
    );
    assert.equal(
      busyboyOrchestrationPromptForFirstRun({ prompt, runOrdinal: 1, hasBusyboyMcp: false }),
      prompt,
    );
  });

  it("only exposes the system prompt when the Busyboy MCP server is attached", () => {
    assert.equal(busyboyOrchestrationSystemPrompt(false), undefined);
    assert.equal(busyboyOrchestrationSystemPrompt(true), BUSYBOY_ORCHESTRATION_INSTRUCTIONS);
  });

  it("gives ACP sessions provider-neutral mode, browser, and orchestration guidance", () => {
    const injected = busyboyAcpPromptWithInstructions({
      prompt: "Inspect the repository.",
      state: { interactionMode: "default", hasBusyboyMcp: true },
    });

    assert.include(injected, "Busyboy interaction mode: Default");
    assert.include(injected, "Busyboy collaborative browser");
    assert.include(injected, "Busyboy orchestration");
    assert.include(injected, "<user_request>\nInspect the repository.\n</user_request>");
  });

  it("reinjects ACP guidance only when mode or tool availability changes", () => {
    const prompt = "Continue.";
    const defaultState = { interactionMode: "default", hasBusyboyMcp: true } as const;

    assert.equal(
      busyboyAcpPromptWithInstructions({ prompt, state: defaultState, previousState: defaultState }),
      prompt,
    );
    assert.include(
      busyboyAcpPromptWithInstructions({
        prompt,
        state: { ...defaultState, interactionMode: "plan" },
        previousState: defaultState,
      }),
      "Busyboy interaction mode: Plan",
    );
    const withoutMcp = busyboyAcpPromptWithInstructions({
      prompt,
      state: { interactionMode: "default", hasBusyboyMcp: false },
    });
    assert.include(withoutMcp, "Busyboy interaction mode: Default");
    assert.notInclude(withoutMcp, "Busyboy collaborative browser");
    assert.notInclude(withoutMcp, "Busyboy orchestration");
  });
});
