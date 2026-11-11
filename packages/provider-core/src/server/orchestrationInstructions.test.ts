import { assert, describe, it } from "@effect/vitest";

import {
  directorInstructions,
  PROJECT_MANAGER_INSTRUCTIONS,
  projectManagerInstructions,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  t3AcpPromptWithInstructions,
  t3OrchestrationPromptForFirstRun,
  t3OrchestrationSystemPrompt,
  USER_FACING_TASK_INSTRUCTIONS,
} from "./orchestrationInstructions.ts";

describe("T3 orchestration provider instructions", () => {
  it("requires messenger requests and resolves user request references", () => {
    assert.include(USER_FACING_TASK_INSTRUCTIONS, "one messenger-style message");
    assert.include(USER_FACING_TASK_INSTRUCTIONS, "No headings, labels, bullets, task keys");
    assert.include(USER_FACING_TASK_INSTRUCTIONS, "Optional details has up to 8 label/text pairs");
    assert.include(USER_FACING_TASK_INSTRUCTIONS, "omit attentionItemId");
    assert.include(USER_FACING_TASK_INSTRUCTIONS, "t3-request:<id>");
    assert.include(USER_FACING_TASK_INSTRUCTIONS, "Required context still applies");
  });
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

  it("tells the PM to start a cloud lead only when the user asks", () => {
    assert.include(
      PROJECT_MANAGER_INSTRUCTIONS,
      'Only when the user asks for it, call `task_start` with location "cloud"',
    );
    assert.include(PROJECT_MANAGER_INSTRUCTIONS, "The app marks such a task Cloud.");
    assert.include(
      PROJECT_MANAGER_INSTRUCTIONS,
      "Computer Use and the local app preview don't work there.",
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

  it("has the PM answer bursts of messages and run small read-only work itself", () => {
    assert.include(PROJECT_MANAGER_INSTRUCTIONS, "answer every one, none is dropped or cancelled");
    assert.include(PROJECT_MANAGER_INSTRUCTIONS, "follow the latest and say so");
    assert.include(PROJECT_MANAGER_INSTRUCTIONS, "`delegate_task` in async mode, read-only");
    assert.include(PROJECT_MANAGER_INSTRUCTIONS, "never to edit the repository");
    assert.include(PROJECT_MANAGER_INSTRUCTIONS, "produces a PR");
    assert.include(PROJECT_MANAGER_INSTRUCTIONS, '"Delegated task … reached a terminal state"');
  });

  it("has the PM's task_create start the task, with scope shaped at plan approval", () => {
    assert.include(PROJECT_MANAGER_INSTRUCTIONS, "its lead starts right away");
    assert.include(PROJECT_MANAGER_INSTRUCTIONS, "shapes its scope at the lead's plan approval");
    assert.include(PROJECT_MANAGER_INSTRUCTIONS, "the result's `waiting` says why");
    for (const text of ["태스크로 추가", "[제안 승인됨]", "[제안 빠짐]", "[제안 피드백]"]) {
      assert.notInclude(PROJECT_MANAGER_INSTRUCTIONS, text);
    }
  });

  it("tells the PM to report only on a due sitrep", () => {
    assert.include(PROJECT_MANAGER_INSTRUCTIONS, "call `team_status` first");
    assert.include(PROJECT_MANAGER_INSTRUCTIONS, "[Sitrep due] since <time>");
    assert.include(PROJECT_MANAGER_INSTRUCTIONS, "keep it to one short line naming what you did");
    assert.include(
      PROJECT_MANAGER_INSTRUCTIONS,
      "When the user asks about progress, call `team_status`",
    );
    assert.include(PROJECT_MANAGER_INSTRUCTIONS, "Mention: ...");
    assert.include(PROJECT_MANAGER_INSTRUCTIONS, "never the user's approval");
  });

  it("has the PM report a finished task right away, and not again in the sitrep", () => {
    assert.include(PROJECT_MANAGER_INSTRUCTIONS, "tell the user right away in 2–4 short lines");
    assert.include(PROJECT_MANAGER_INSTRUCTIONS, "its result or PR link");
    assert.include(
      PROJECT_MANAGER_INSTRUCTIONS,
      "already reported on its done or in-review wake is not news",
    );
    assert.notInclude(PROJECT_MANAGER_INSTRUCTIONS, "Do not summarize results on these wakes");
  });

  it("has the PM close questions the conversation made moot", () => {
    assert.include(
      PROJECT_MANAGER_INSTRUCTIONS,
      "close it with `attention_dismiss` and a short reason",
    );
  });

  it("has sitreps cover the user's own threads, by name", () => {
    assert.include(PROJECT_MANAGER_INSTRUCTIONS, "covers your tasks and `otherThreads` together");
    assert.include(PROJECT_MANAGER_INSTRUCTIONS, "Needs you: each question waiting for the user");
    assert.include(PROJECT_MANAGER_INSTRUCTIONS, "by their title, never by number alone");
    assert.include(
      PROJECT_MANAGER_INSTRUCTIONS,
      'On "[Thread waiting] "<title>" is waiting on you for',
    );
  });

  it("lists the PM's wakes and keeps decisions in memory across compactions", () => {
    assert.include(PROJECT_MANAGER_INSTRUCTIONS, '"#N failed: …"');
    assert.include(PROJECT_MANAGER_INSTRUCTIONS, '"#N done: <title> · <result>"');
    assert.include(PROJECT_MANAGER_INSTRUCTIONS, '"#N ready: <title> · PR <url>"');
    assert.notInclude(PROJECT_MANAGER_INSTRUCTIONS, "A task finishing does not wake you");
    assert.include(
      PROJECT_MANAGER_INSTRUCTIONS,
      'Use "preferences" for how the user likes to work',
    );
    assert.include(PROJECT_MANAGER_INSTRUCTIONS, "After a context compaction, call `team_status`");
  });

  it("gives the PM its name and voice", () => {
    const text = projectManagerInstructions({ name: "Remy", voice: "Terse and dry." });
    assert.include(text, PROJECT_MANAGER_INSTRUCTIONS);
    assert.include(text, "Your name is Remy.");
    assert.include(text, "Your voice: Terse and dry.");
    assert.include(text, "`team_settings_update`");
  });

  it("gives both user-facing roles named task links and explicit decision context", () => {
    const prompts = [
      projectManagerInstructions({ name: "Remy", voice: "Terse." }),
      directorInstructions({ name: "Nova", voice: "Calm." }),
    ];

    for (const text of prompts) {
      assert.include(text, USER_FACING_TASK_INSTRUCTIONS);
      assert.include(text, "name the work and its project first");
      assert.include(text, "supporting detail in parentheses");
      assert.include(text, "[로그인 리다이렉트 수정 · 웹 앱](t3-task:task%3Alogin)");
      assert.include(text, "using `encodeURIComponent(task.id)`");
      assert.include(text, "`action`");
      assert.include(text, "`reason`");
      assert.include(text, "`impacts`");
      assert.include(text, "`cost`");
      assert.include(text, "`reversibility`");
      assert.include(text, "`recommendation`");
      assert.include(text, "explicitly use [] for none");
      assert.include(text, "Existing role, explicit-approval, and AFK restrictions still apply");
      assert.include(text, "the card's impact labels do not grant permission");
    }
  });

  it("has the Director record goals and link the work that serves them", () => {
    const text = directorInstructions({ name: "Nova", voice: "Calm." });
    assert.include(text, "### Goals");
    assert.include(text, "record it with `goal_write`");
    assert.include(text, "Link the work that serves a goal with `goal_link`");
    assert.include(text, "`workspace.alignment`");
  });

  it("has the Director act on goal checks without approving plans or starting work", () => {
    const text = directorInstructions({ name: "Nova", voice: "Calm." });
    assert.include(text, "### Working from goals");
    assert.include(text, 'When you receive "[목표 점검]"');
    assert.include(text, "`task_create` and that goal's `goalId`");
    assert.include(text, "`pm_nudge` with `projectId`, `taskId` and the reason");
    assert.include(text, "어느 목표인가요?");
    assert.include(text, "gather everything the user must decide into one `ask_user`");
    assert.include(text, "You never approve plans or start leads");
    assert.notInclude(text, "태스크로 추가");
  });

  it("has the Director keep its one-line briefing current on goal checks and digests", () => {
    const text = directorInstructions({ name: "Nova", voice: "Calm." });
    assert.include(text, "### Briefing");
    assert.include(text, 'Your "briefing" memory topic is one line at the top of All projects');
    assert.include(
      text,
      'After each "[목표 점검]" and each digest, rewrite it with `memory_write`',
    );
    assert.include(text, "The server refuses more than one line");
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
