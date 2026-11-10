import { describe, expect, it } from "vite-plus/test";

import { containsSecret, makeSecretMasker } from "./secretMask.ts";

const CLAUDE_TOKEN = "sk-ant-oat01-AbCdEf_123-xyz";
const VERCEL_TOKEN = "plainVercelToken1234";

describe("makeSecretMasker", () => {
  it("masks known values everywhere in multi-line command output", () => {
    const { mask } = makeSecretMasker([VERCEL_TOKEN]);
    const output = `line one ${VERCEL_TOKEN}\nAuthorization: Bearer ${VERCEL_TOKEN}\nend`;
    expect(mask(output)).toBe("line one ***\nAuthorization: Bearer ***\nend");
  });

  it("masks token shapes it was never told about", () => {
    const { mask } = makeSecretMasker([]);
    const text = [
      `CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_TOKEN}`,
      "vercel vcp_abc123DEF",
      "gh github_pat_11AA_bbCC",
      "oauth gho_abcDEF123 ghp_x1 ghs_y2 ghu_z3",
    ].join("\n");
    const masked = mask(text);
    expect(masked).not.toMatch(/sk-ant-|vcp_|github_pat_|gh[opsu]_/);
    expect(masked).toContain("CLAUDE_CODE_OAUTH_TOKEN=***");
  });

  it("masks OpenAI and Slack keys and URL passwords", () => {
    const { mask } = makeSecretMasker([]);
    expect(mask("OPENAI=sk-proj-abc123defghijklmnopqrstu")).toBe("OPENAI=***");
    expect(mask("SLACK=xoxb-123-456-abcdef")).toBe("SLACK=***");
    expect(mask("postgres://app:hunter2pass@db.example.com/x")).toBe(
      "postgres://app:***@db.example.com/x",
    );
    expect(mask("see https://example.com/path and sk-learn")).toBe(
      "see https://example.com/path and sk-learn",
    );
    // Hyphenated names that merely contain "sk-" or "gho_" are not tokens.
    for (const name of [
      "task-observer-learn-your-preferences",
      "risk-ranked-coverage-gaps",
      "desk-organizer-plugin-for-teams",
      "my_gho_helper",
    ]) {
      expect(mask(name)).toBe(name);
    }
  });

  it("ignores values too short to be secrets", () => {
    expect(makeSecretMasker(["short"]).mask("a short word")).toBe("a short word");
  });

  it("masks a longer secret whole when it contains a shorter one", () => {
    const { mask } = makeSecretMasker(["abcdefgh", "abcdefgh-extended"]);
    expect(mask("x abcdefgh-extended y")).toBe("x *** y");
  });

  it("masks error messages, stacks and causes", () => {
    const { maskError } = makeSecretMasker([VERCEL_TOKEN]);
    const cause = new Error(`inner ${VERCEL_TOKEN}`);
    const error = new Error(`outer ${VERCEL_TOKEN}`, { cause });
    const masked = maskError(error);
    expect(masked.message).toBe("outer ***");
    expect(masked.stack).not.toContain(VERCEL_TOKEN);
    expect((masked.cause as Error).message).toBe("inner ***");
    expect(maskError(`thrown ${VERCEL_TOKEN}`).message).toBe("thrown ***");
  });

  it("adds secrets with withSecrets", () => {
    const masker = makeSecretMasker([VERCEL_TOKEN]).withSecrets(["anotherSecret99"]);
    expect(masker.mask(`${VERCEL_TOKEN} anotherSecret99`)).toBe("*** ***");
  });
});

describe("containsSecret", () => {
  it("detects known values and token shapes", () => {
    expect(containsSecret(`x ${VERCEL_TOKEN}`, [VERCEL_TOKEN])).toBe(true);
    expect(containsSecret(`x ${CLAUDE_TOKEN}`, [])).toBe(true);
    expect(containsSecret("nothing here", [VERCEL_TOKEN])).toBe(false);
  });
});
