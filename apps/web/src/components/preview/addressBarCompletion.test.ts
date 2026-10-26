import { describe, expect, it } from "vite-plus/test";

import { inlineHostCompletion } from "./addressBarCompletion";

describe("inlineHostCompletion", () => {
  it("completes the rest of the host, with or without www", () => {
    expect(inlineHostCompletion({ typed: "git", url: "https://github.com/a" })).toBe("hub.com");
    expect(inlineHostCompletion({ typed: "exa", url: "https://www.example.com/" })).toBe(
      "mple.com",
    );
    expect(inlineHostCompletion({ typed: "www.ex", url: "https://www.example.com/" })).toBe(
      "ample.com",
    );
  });

  it("leaves text alone when the host does not start with it", () => {
    expect(inlineHostCompletion({ typed: "hub", url: "https://github.com/" })).toBeNull();
    expect(inlineHostCompletion({ typed: "github.com", url: "https://github.com/" })).toBeNull();
    expect(inlineHostCompletion({ typed: "git hub", url: "https://github.com/" })).toBeNull();
    expect(inlineHostCompletion({ typed: "github.com/", url: "https://github.com/a" })).toBeNull();
  });
});
