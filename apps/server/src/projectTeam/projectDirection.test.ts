import { describe, expect, it } from "@effect/vitest";

import { projectDirectionLine } from "./projectDirection.ts";

describe("projectDirectionLine", () => {
  it("skips blank lines and the heading, and strips list markers", () => {
    expect(
      projectDirectionLine(
        "\nProduct direction (user, 2026-11-07, updated 2026-11-08):\n- Make the phone the main way to steer the team.\n- Second point.",
      ),
    ).toBe("Make the phone the main way to steer the team.");
  });

  it("strips markdown heading and quote markers", () => {
    expect(projectDirectionLine("## Ship the map\n")).toBe("Ship the map");
    expect(projectDirectionLine(">  * quoted bullet ")).toBe("quoted bullet");
  });

  it("returns null when only headings or blanks remain", () => {
    expect(projectDirectionLine("")).toBeNull();
    expect(projectDirectionLine("Direction:\n\n  - \n# Notes:")).toBeNull();
  });
});
