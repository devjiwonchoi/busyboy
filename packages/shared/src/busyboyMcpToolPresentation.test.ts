import { describe, expect, it } from "vite-plus/test";

import { BUSYBOY_MCP_TOOL_NAMES, resolveBusyboyMcpToolPresentation } from "./busyboyMcpToolPresentation.ts";

describe("resolveBusyboyMcpToolPresentation", () => {
  it("recognizes every Busyboy tool across provider prefixes and completion suffixes", () => {
    for (const tool of BUSYBOY_MCP_TOOL_NAMES) {
      const presentation = resolveBusyboyMcpToolPresentation(tool);
      for (const prefix of [
        "mcp__busyboy__",
        "mcp__busyboy__",
        "mcp__busyboy__",
        "busyboy.",
        "busyboy/",
        "busyboy:",
        "mcp_busyboy_",
        "Busyboy ",
        "busyboy · ",
      ]) {
        expect(resolveBusyboyMcpToolPresentation(`${prefix}${tool} completed`), tool).toEqual(
          presentation,
        );
      }
      expect(resolveBusyboyMcpToolPresentation(`mcp__another-server__${tool}`), tool).toBeNull();
    }
  });
  it("pretty prints Claude and Cursor Busyboy MCP tool names", () => {
    expect(resolveBusyboyMcpToolPresentation("mcp__busyboy__busyboy_thread_read")).toEqual({
      displayName: "Read a Busyboy thread",
      logo: "busyboy",
    });
  });

  it("pretty prints Codex Busyboy MCP tool names", () => {
    expect(resolveBusyboyMcpToolPresentation("busyboy.create_threads")).toEqual({
      displayName: "Create Busyboy threads",
      logo: "busyboy",
    });
  });

  it("pretty prints thread metadata updates", () => {
    expect(resolveBusyboyMcpToolPresentation("mcp__busyboy__busyboy_thread_update")).toEqual({
      displayName: "Update Busyboy thread metadata",
      logo: "busyboy",
    });
  });

  it("pretty prints bare Busyboy MCP toolkit names", () => {
    expect(resolveBusyboyMcpToolPresentation("list_scheduled_tasks")).toEqual({
      displayName: "List scheduled tasks",
      logo: "busyboy",
    });
  });

  it("pretty prints worktree Busyboy MCP tool names", () => {
    expect(resolveBusyboyMcpToolPresentation("mcp__busyboy__busyboy_worktree_handoff")).toEqual({
      displayName: "Hand off thread to a git worktree",
      logo: "busyboy",
    });
    expect(resolveBusyboyMcpToolPresentation("busyboy.busyboy_worktree_status")).toEqual({
      displayName: "Get thread worktree status",
      logo: "busyboy",
    });
  });

  it("pretty prints preview Busyboy MCP tool names", () => {
    expect(resolveBusyboyMcpToolPresentation("busyboy.preview_open")).toEqual({
      displayName: "Open a page in the preview browser",
      logo: "busyboy",
    });
    expect(resolveBusyboyMcpToolPresentation("mcp__busyboy__preview_status")).toEqual({
      displayName: "Get preview browser status",
      logo: "busyboy",
    });
  });

  it("matches the separator variants ACP registry agents emit", () => {
    for (const name of [
      "mcp_busyboy_delegate_task",
      "busyboy:delegate_task",
      "busyboy/delegate_task",
      "busyboy delegate_task",
      "Busyboy delegate_task",
      "busyboy__delegate_task",
    ]) {
      expect(resolveBusyboyMcpToolPresentation(name)?.displayName).toBe("Delegate a child task");
    }
  });

  it("matches OpenCode 2's per-thread server names, whose thread ids hold underscores", () => {
    expect(
      resolveBusyboyMcpToolPresentation("busyboy-thread_opencode2-adapter_delegate_task")?.displayName,
    ).toBe("Delegate a child task");
    expect(resolveBusyboyMcpToolPresentation("busyboy-thread_opencode2-adapter_not_a_tool")).toBeNull();
  });

  it("keeps unknown MCP tools on the generic renderer path", () => {
    expect(resolveBusyboyMcpToolPresentation("mcp__github__search_issues")).toBeNull();
    expect(resolveBusyboyMcpToolPresentation("busyboy.not_a_real_tool")).toBeNull();
  });
});
