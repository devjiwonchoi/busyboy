import { describe, expect, it } from "vite-plus/test";

import { encodeProjectDir, remapProjectMemoryDir, rewriteHomePaths } from "./pathRewrite.ts";

const mapping = { localHome: "/Users/me", remoteHome: "/vercel" };

describe("rewriteHomePaths", () => {
  it("rewrites settings.json hook commands and paths", () => {
    const settings = JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "/Users/me/bin/notify.sh done" }] }] },
      statusLine: { command: "bash /Users/me/.claude/status.sh" },
    });
    const rewritten = rewriteHomePaths(settings, mapping);
    expect(rewritten).toContain('"/vercel/bin/notify.sh done"');
    expect(rewritten).toContain("bash /vercel/.claude/status.sh");
    expect(rewritten).not.toContain("/Users/me");
  });

  it("rewrites plugin manifest install paths", () => {
    const installed = JSON.stringify({
      plugins: {
        "jwn@jwn": [{ installPath: "/Users/me/.claude/plugins/cache/jwn/jwn/0.0.0" }],
      },
    });
    const marketplaces = JSON.stringify({
      jwn: { installLocation: "/Users/me/.claude/plugins/marketplaces/jwn" },
    });
    expect(JSON.parse(rewriteHomePaths(installed, mapping)).plugins["jwn@jwn"][0].installPath).toBe(
      "/vercel/.claude/plugins/cache/jwn/jwn/0.0.0",
    );
    expect(JSON.parse(rewriteHomePaths(marketplaces, mapping)).jwn.installLocation).toBe(
      "/vercel/.claude/plugins/marketplaces/jwn",
    );
  });

  it("rewrites the bare home and ignores look-alike paths", () => {
    expect(rewriteHomePaths('"/Users/me"', mapping)).toBe('"/vercel"');
    expect(rewriteHomePaths("/Users/me", mapping)).toBe("/vercel");
    expect(rewriteHomePaths("/Users/me2/x and /Users/other/me", mapping)).toBe(
      "/Users/me2/x and /Users/other/me",
    );
  });

  it("accepts homes with a trailing slash", () => {
    expect(
      rewriteHomePaths("/Users/me/a", { localHome: "/Users/me/", remoteHome: "/vercel/" }),
    ).toBe("/vercel/a");
  });
});

describe("project memory directories", () => {
  it("encodes a cwd the way Claude names ~/.claude/projects", () => {
    expect(encodeProjectDir("/Users/me/code/busyboy")).toBe("-Users-me-code-busyboy");
    expect(encodeProjectDir("/Users/me/.busyboy/worktrees/x_1/")).toBe(
      "-Users-me--busyboy-worktrees-x-1",
    );
  });

  it("maps the Mac project memory dir to the sandbox one", () => {
    expect(remapProjectMemoryDir("/Users/me/code/busyboy", "/vercel/busyboy")).toEqual({
      from: "-Users-me-code-busyboy",
      to: "-vercel-busyboy",
    });
  });
});
