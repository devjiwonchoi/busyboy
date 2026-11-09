import { parseNewThreadLink, PROMPT_LINK_MAX_PROMPT_LENGTH } from "@t3tools/shared/promptLinks";
import { describe, expect, it } from "vite-plus/test";

import { crashDebugLinkPath, crashDebugPrompt } from "./crashDebugLink";

const REPORT = [
  "BusyBoy (Beta) 0.0.15",
  "Path: /draft/273a7c77",
  "",
  "Error: Minified React error #301",
  "\tat vo (busyboy://app/assets/main.js:247:47823)",
].join("\n");

function parse(path: string) {
  expect(path.startsWith("/new?")).toBe(true);
  const parsed = parseNewThreadLink(path.slice("/new".length));
  if (!parsed.ok || parsed.value.kind !== "new") throw new Error("expected a new-thread link");
  return parsed.value;
}

describe("crashDebugLinkPath", () => {
  it("opens a new chat on the BusyBoy repository with the report in the prompt", () => {
    const link = parse(crashDebugLinkPath(REPORT));
    expect(link.repository).toEqual({ owner: "devjiwonchoi", name: "busyboy" });
    expect(link.prompt.text).toContain(REPORT);
    expect(link.prompt.hiddenCharacters).toBe(0);
  });

  it("truncates a long report so the link still opens", () => {
    const prompt = crashDebugPrompt(`${REPORT}\n${"x".repeat(PROMPT_LINK_MAX_PROMPT_LENGTH)}`);
    expect(prompt.length).toBe(PROMPT_LINK_MAX_PROMPT_LENGTH);
    expect(prompt).toContain("[report truncated]");
    expect(parse(crashDebugLinkPath(`${REPORT}\n${"x".repeat(20_000)}`)).prompt.text).toContain(
      "Error: Minified React error #301",
    );
  });
});
