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

  it("completes partly typed labels but never extends a whole host", () => {
    expect(inlineHostCompletion({ typed: "github.c", url: "https://github.com/" })).toBe("om");
    expect(inlineHostCompletion({ typed: "docs.goo", url: "https://docs.google.com/" })).toBe(
      "gle.com",
    );
    expect(inlineHostCompletion({ typed: "localhost", url: "http://localhost:3000/" })).toBe(
      ":3000",
    );
    expect(
      inlineHostCompletion({ typed: "github.com", url: "https://github.com.evil.io/" }),
    ).toBeNull();
    expect(inlineHostCompletion({ typed: "127.0.0.1", url: "http://127.0.0.1:3000/" })).toBeNull();
  });
});
