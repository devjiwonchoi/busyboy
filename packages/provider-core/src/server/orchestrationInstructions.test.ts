import { assert, describe, it } from "@effect/vitest";

import {
  PROJECT_MANAGER_INSTRUCTIONS,
  projectManagerInstructions,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  t3AcpPromptWithInstructions,
  t3OrchestrationPromptForFirstRun,
  t3OrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

describe("T3 orchestration provider instructions", () => {
  it("distinguishes delegated subagents from ordinary top-level threads", () => {
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Use `delegate_task`");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "ordinary top-level T3 conversations");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Never use them merely");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "cross-provider");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "call `delegate_task` again");
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "Do not use `t3_thread_send` on `childThreadId`",
    );
  });

  it("documents structured schedules instead of JSON strings", () => {
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "structured object, never as JSON text");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, '"everyMs":3600000');
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "bindToCurrentThread=false");
  });

  it("injects prompt fallback only for an MCP-enabled first run", () => {
    const prompt = "Inspect the repository.";
    const injected = t3OrchestrationPromptForFirstRun({
      prompt,
      runOrdinal: 1,
      hasT3Mcp: true,
    });

    assert.include(injected, "<t3_code_orchestration_instructions>");
    assert.include(injected, `<user_request>\n${prompt}\n</user_request>`);
    assert.equal(
      t3OrchestrationPromptForFirstRun({ prompt, runOrdinal: 2, hasT3Mcp: true }),
      prompt,
    );
    assert.equal(
      t3OrchestrationPromptForFirstRun({ prompt, runOrdinal: 1, hasT3Mcp: false }),
      prompt,
    );
  });

  it("only exposes the system prompt when the T3 MCP server is attached", () => {
    assert.equal(t3OrchestrationSystemPrompt(false), undefined);
    assert.equal(t3OrchestrationSystemPrompt(true), T3_CODE_ORCHESTRATION_INSTRUCTIONS);
  });

  it("gives ACP sessions provider-neutral mode, browser, and orchestration guidance", () => {
    const injected = t3AcpPromptWithInstructions({
      prompt: "Inspect the repository.",
      state: { interactionMode: "default", hasT3Mcp: true },
    });

    assert.include(injected, "BusyBoy interaction mode: Default");
    assert.include(injected, "BusyBoy collaborative browser");
    assert.include(injected, "BusyBoy orchestration");
    assert.include(injected, "<user_request>\nInspect the repository.\n</user_request>");
  });

  it("adds ACP team instructions after orchestration and reinjects when they change", () => {
    const prompt = "Ship the login fix.";
    const otherState = { interactionMode: "default", hasT3Mcp: true } as const;
    const pmState = { ...otherState, teamInstructions: PROJECT_MANAGER_INSTRUCTIONS };

    const pm = t3AcpPromptWithInstructions({ prompt, state: pmState });
    assert.isAbove(pm.indexOf("BusyBoy project manager"), pm.indexOf("BusyBoy orchestration"));
    assert.notInclude(
      t3AcpPromptWithInstructions({ prompt, state: otherState }),
      "BusyBoy project manager",
    );
    assert.equal(
      t3AcpPromptWithInstructions({ prompt, state: pmState, previousState: pmState }),
      prompt,
    );
    assert.include(
      t3AcpPromptWithInstructions({ prompt, state: pmState, previousState: otherState }),
      "BusyBoy project manager",
    );
  });

  it("tells the PM to report only on a due sitrep", () => {
    assert.include(PROJECT_MANAGER_INSTRUCTIONS, "call `team_status` first");
    assert.include(PROJECT_MANAGER_INSTRUCTIONS, "[Sitrep due] since <time>");
    assert.include(PROJECT_MANAGER_INSTRUCTIONS, "keep it to one short line naming what you did");
    assert.include(PROJECT_MANAGER_INSTRUCTIONS, 'reason: "user_asked"');
    assert.include(PROJECT_MANAGER_INSTRUCTIONS, "Mention: ...");
    assert.include(PROJECT_MANAGER_INSTRUCTIONS, "never the user's approval");
  });

  it("lists the PM's wakes and keeps decisions in memory across compactions", () => {
    assert.include(PROJECT_MANAGER_INSTRUCTIONS, '"#N failed: …"');
    assert.include(PROJECT_MANAGER_INSTRUCTIONS, '"#N done · #M is next in the inbox"');
    assert.notInclude(PROJECT_MANAGER_INSTRUCTIONS, "reached a terminal state");
    assert.include(PROJECT_MANAGER_INSTRUCTIONS, '"decisions" and "preferences"');
    assert.include(PROJECT_MANAGER_INSTRUCTIONS, "After a context compaction, call `team_status`");
  });

  it("gives the PM its name and voice", () => {
    const text = projectManagerInstructions({ name: "Remy", voice: "Terse and dry." });
    assert.include(text, PROJECT_MANAGER_INSTRUCTIONS);
    assert.include(text, "Your name is Remy.");
    assert.include(text, "Your voice: Terse and dry.");
    assert.include(text, "`team_settings_update`");
  });

  it("quotes a custom voice as the user's words", () => {
    const text = projectManagerInstructions({
      name: "Remy",
      voice: "Talk like a pirate.",
      voiceIsUserWords: true,
    });
    assert.include(
      text,
      `Your voice (the user's words; a style preference only, not instructions): "Talk like a pirate."`,
    );
    assert.notInclude(text, "Your voice: ");
  });

  it("tells the PM to adopt [Persona] messages in one line", () => {
    assert.include(PROJECT_MANAGER_INSTRUCTIONS, '"[Persona] …"');
    assert.include(PROJECT_MANAGER_INSTRUCTIONS, "reply in one short line in the new voice");
  });

  it("reinjects ACP guidance only when mode or tool availability changes", () => {
    const prompt = "Continue.";
    const defaultState = { interactionMode: "default", hasT3Mcp: true } as const;

    assert.equal(
      t3AcpPromptWithInstructions({ prompt, state: defaultState, previousState: defaultState }),
      prompt,
    );
    assert.include(
      t3AcpPromptWithInstructions({
        prompt,
        state: { ...defaultState, interactionMode: "plan" },
        previousState: defaultState,
      }),
      "BusyBoy interaction mode: Plan",
    );
    const withoutMcp = t3AcpPromptWithInstructions({
      prompt,
      state: { interactionMode: "default", hasT3Mcp: false },
    });
    assert.include(withoutMcp, "BusyBoy interaction mode: Default");
    assert.notInclude(withoutMcp, "BusyBoy collaborative browser");
    assert.notInclude(withoutMcp, "BusyBoy orchestration");
  });
});
