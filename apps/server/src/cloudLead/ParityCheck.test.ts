import { describe, expect, it } from "vite-plus/test";

import {
  cleanLocalEnv,
  compareInit,
  parseInitLine,
  renderParitySummary,
  type ClaudeInit,
} from "./ParityCheck.ts";

const init = (overrides: Partial<ClaudeInit> = {}): ClaudeInit => ({
  skills: ["jwn:align", "docs"],
  slashCommands: ["jwn:align"],
  plugins: ["jwn"],
  mcpServers: [{ name: "plugin:productivity:slack", status: "needs-auth" }],
  tools: ["Bash", "Read"],
  agents: ["Explore"],
  permissionMode: "default",
  model: "claude-opus-5-5",
  claudeVersion: "2.1.311",
  ...overrides,
});

const side = (value: ClaudeInit, settingsHash = "h") => ({ init: value, settingsHash });
const category = (result: ReturnType<typeof compareInit>, name: string) =>
  result.categories.find((entry) => entry.category === name)!;

describe("parseInitLine", () => {
  it("reads the SDK init message and names plugins by name", () => {
    const parsed = parseInitLine(
      JSON.stringify({
        type: "system",
        subtype: "init",
        skills: ["a"],
        slash_commands: ["a"],
        plugins: [{ name: "productivity", source: "productivity@synced", path: "/Users/me/x" }],
        mcp_servers: [{ name: "rea", status: "connected" }],
        tools: ["Bash"],
        agents: ["Explore"],
        permissionMode: "default",
        model: "m",
        claude_code_version: "2.1.311",
      }),
    );
    expect(parsed.plugins).toEqual(["productivity"]);
    expect(parsed.mcpServers).toEqual([{ name: "rea", status: "connected" }]);
    expect(() => parseInitLine(JSON.stringify({ type: "assistant" }))).toThrow();
  });
});

describe("compareInit", () => {
  it("passes when both sides are identical", () => {
    const result = compareInit(side(init()), side(init()));
    expect(result.ok).toBe(true);
    expect(result.categories.every((entry) => entry.same)).toBe(true);
  });

  it("fails on an unexpected difference and names it", () => {
    const result = compareInit(
      side(init()),
      side(init({ skills: ["jwn:align"], permissionMode: "acceptEdits" }), "other"),
    );
    expect(result.ok).toBe(false);
    expect(category(result, "skills").onlyLocal).toEqual([{ name: "docs" }]);
    expect(category(result, "permissionMode").ok).toBe(false);
    expect(category(result, "settingsHash").ok).toBe(false);
    expect(renderParitySummary(result)).toContain("스킬: 다름 — 로컬에만: docs");
  });

  it("marks local-only MCP servers, their tools and prompts as expected", () => {
    const local = init({
      mcpServers: [
        { name: "rea", status: "connected" },
        { name: "claude.ai Gmail", status: "connected" },
      ],
      tools: [
        "Bash",
        "mcp__rea__decompile",
        "mcp__claude_ai_Gmail__search",
        "mcp__t3-code__computer_click",
      ],
      slashCommands: ["jwn:align", "mcp__rea__trace_crash", "extra-usage"],
      agents: ["Explore", "web-fetch"],
    });
    const remote = init({ mcpServers: [], tools: ["Bash", "WebFetch"], agents: ["Explore"] });
    const result = compareInit(side(local), side(remote), (name) =>
      name === "rea" ? { command: "/usr/local/bin/rea" } : undefined,
    );

    expect(result.ok).toBe(true);
    expect(category(result, "mcpServers").onlyLocal.map((item) => item.expected?.kind)).toEqual([
      "claude-ai-connector",
      "mac-stdio-mcp",
    ]);
    expect(category(result, "tools").onlyLocal.map((item) => item.expected?.kind)).toEqual([
      "claude-ai-connector",
      "mac-stdio-mcp",
      "computer-use",
    ]);
    expect(category(result, "tools").onlyRemote[0]?.expected?.kind).toBe("claude-ai-account");
    expect(category(result, "slashCommands").ok).toBe(true);
    expect(category(result, "agents").ok).toBe(true);
    expect(renderParitySummary(result)).toContain("rea(예상된 차이)");
  });

  it("compares plugin MCP servers by connector and tolerates unconnected extras", () => {
    const local = init({
      mcpServers: [{ name: "plugin:productivity:slack", status: "needs-auth" }],
    });
    const remote = init({
      mcpServers: [
        { name: "plugin:customer-support:slack", status: "connected" },
        { name: "plugin:engineering:github", status: "failed" },
      ],
    });
    const result = compareInit(side(local), side(remote));
    const mcp = category(result, "mcpServers");
    expect(mcp.onlyLocal).toEqual([]);
    expect(mcp.onlyRemote.map((item) => [item.name, item.expected?.kind])).toEqual([
      ["plugin:*:github", "claude-ai-account"],
    ]);
    expect(result.mcpStatusChanges).toEqual([
      { name: "plugin:productivity:slack", local: "needs-auth", remote: "connected" },
    ]);
    expect(result.ok).toBe(true);

    const connectedExtra = compareInit(
      side(local),
      side(
        init({ mcpServers: [...remote.mcpServers, { name: "plugin:x:new", status: "connected" }] }),
      ),
    );
    expect(connectedExtra.ok).toBe(false);
  });

  it("treats an unknown remote-only item as a failure", () => {
    const result = compareInit(side(init()), side(init({ tools: ["Bash", "Read", "Surprise"] })));
    expect(category(result, "tools").ok).toBe(false);
    expect(result.ok).toBe(false);
  });
});

describe("cleanLocalEnv", () => {
  it("drops vars a parent Claude session leaks", () => {
    expect(
      cleanLocalEnv({
        HOME: "/Users/me",
        PATH: "/bin",
        CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
        CLAUDECODE: "1",
        ANTHROPIC_API_KEY: "x",
      }),
    ).toEqual({ HOME: "/Users/me", PATH: "/bin" });
  });
});
