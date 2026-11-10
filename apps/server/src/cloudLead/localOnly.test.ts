import { describe, expect, it } from "vite-plus/test";

import {
  assertToolAvailableInCloud,
  classifyMcpServer,
  classifyTool,
  LocalOnlyError,
  localOnlyError,
} from "./localOnly.ts";

describe("classifyMcpServer", () => {
  it("flags stdio servers that run a Mac-installed program", () => {
    expect(classifyMcpServer("rea", { command: "/usr/local/bin/rea" })?.kind).toBe("mac-stdio-mcp");
    expect(classifyMcpServer("x", { type: "stdio", command: "/opt/homebrew/bin/x" })?.kind).toBe(
      "mac-stdio-mcp",
    );
    expect(
      classifyMcpServer("app", { command: "/Applications/Foo.app/Contents/MacOS/foo" })?.kind,
    ).toBe("mac-stdio-mcp");
    expect(classifyMcpServer("home", { command: "/Users/me/bin/server" })?.kind).toBe(
      "mac-stdio-mcp",
    );
  });

  it("keeps portable servers", () => {
    expect(classifyMcpServer("npx", { command: "npx", args: ["-y", "some-mcp"] })).toBeNull();
    expect(
      classifyMcpServer("remote", { type: "http", url: "https://example.com/mcp" }),
    ).toBeNull();
    expect(classifyMcpServer("unknown", undefined)).toBeNull();
  });

  it("flags claude.ai connectors and computer use", () => {
    expect(classifyMcpServer("claude.ai Gmail", undefined)?.kind).toBe("claude-ai-connector");
    expect(classifyMcpServer("computer-use", undefined)?.kind).toBe("computer-use");
  });
});

describe("classifyTool", () => {
  it("flags Computer Use, local preview and keychain tools", () => {
    expect(classifyTool("mcp__t3-code__computer_click")?.kind).toBe("computer-use");
    expect(classifyTool("mcp__computer-use__screenshot")?.kind).toBe("computer-use");
    expect(classifyTool("mcp__t3-code__preview_open")?.kind).toBe("preview-local-app");
    expect(classifyTool("mcp__t3-code__t3_preview_list")?.kind).toBe("preview-local-app");
    expect(classifyTool("read_keychain_item")?.kind).toBe("keychain");
  });

  it("leaves ordinary tools alone", () => {
    expect(classifyTool("Bash")).toBeNull();
    expect(classifyTool("mcp__t3-code__task_update")).toBeNull();
  });
});

describe("localOnlyError", () => {
  it("says it only works locally and gives an alternative", () => {
    const error = localOnlyError("mac-stdio-mcp", "rea");
    expect(error).toBeInstanceOf(LocalOnlyError);
    expect(error.message.startsWith("로컬에서만 가능해요: rea.")).toBe(true);
    expect(error.alternative).toContain("릴레이");
    expect(localOnlyError("computer-use", "computer_click").alternative).toContain(
      "로컬로 가져와서",
    );
  });

  it("is thrown for a Mac-only tool called from the cloud", () => {
    expect(() => assertToolAvailableInCloud("mcp__t3-code__computer_click")).toThrow(
      /^로컬에서만 가능해요/,
    );
    expect(() => assertToolAvailableInCloud("Bash")).not.toThrow();
  });
});
