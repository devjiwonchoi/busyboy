import { describe, expect, it } from "vite-plus/test";

import {
  classifyProtectedField,
  isSecretEntryField,
  PROTECTED_VALUES_SCRIPT,
  scrubProtectedValues,
  type FieldDescriptor,
} from "./ProtectedFields.ts";

const field = (overrides: Partial<FieldDescriptor> = {}): FieldDescriptor => ({
  tag: "input",
  type: "text",
  autocomplete: "",
  hints: [],
  textSecurity: "none",
  contentEditable: false,
  ...overrides,
});

describe("classifyProtectedField", () => {
  it.each([
    ["password type", field({ type: "password" }), "type"],
    ["email type", field({ type: "email" }), "type"],
    ["tel type", field({ type: "tel" }), "type"],
    ["hidden type", field({ type: "hidden" }), "type"],
    ["username token", field({ autocomplete: "section-login username" }), "autocomplete"],
    ["current-password token", field({ autocomplete: "current-password" }), "autocomplete"],
    ["new-password token", field({ autocomplete: "new-password" }), "autocomplete"],
    ["one-time-code token", field({ autocomplete: "one-time-code" }), "autocomplete"],
    ["email token", field({ autocomplete: "email" }), "autocomplete"],
    ["tel-national token", field({ autocomplete: "tel-national" }), "autocomplete"],
    ["card token", field({ autocomplete: "cc-number" }), "autocomplete"],
    ["dotted text", field({ textSecurity: "disc" }), "textSecurity"],
    ["userName hint", field({ hints: ["userName"] }), "hint"],
    ["login_id hint", field({ hints: ["login_id"] }), "hint"],
    ["E-mail label", field({ hints: ["E-mail address"] }), "hint"],
    ["passcode hint", field({ hints: ["Passcode"] }), "hint"],
    ["PIN label", field({ hints: ["Enter your PIN"] }), "hint"],
    ["verification code label", field({ hints: ["Verification code"] }), "hint"],
    ["OTP id", field({ hints: ["otp-input"] }), "hint"],
    ["2FA label", field({ hints: ["2FA code"] }), "hint"],
    ["MFA placeholder", field({ hints: ["MFA token"] }), "hint"],
    ["mobile number", field({ hints: ["Mobile number"] }), "hint"],
    ["telephone", field({ hints: ["telephone"] }), "hint"],
    ["textarea note with password", field({ tag: "textarea", hints: ["password hint"] }), "hint"],
    ["select of phone", field({ tag: "select", hints: ["phone"] }), "hint"],
    [
      "contenteditable email",
      field({ tag: "div", contentEditable: true, hints: ["email"] }),
      "hint",
    ],
  ] as const)("protects %s", (_name, descriptor, reason) => {
    expect(classifyProtectedField(descriptor)).toBe(reason);
  });

  it.each([
    ["search box", field({ type: "search", hints: ["q", "Search"] })],
    ["first name", field({ hints: ["first_name", "First name"] })],
    ["spinner (pin inside a word)", field({ hints: ["spinner"] })],
    ["shipping", field({ hints: ["shipping"] })],
    ["a paragraph", field({ tag: "p", hints: ["password"] })],
    ["dots off", field({ textSecurity: "none" })],
  ] as const)("leaves %s alone", (_name, descriptor) => {
    expect(classifyProtectedField(descriptor)).toBeNull();
  });

  it("serializes into a page script that parses on its own", () => {
    expect(() => new Function(`return ${PROTECTED_VALUES_SCRIPT}`)).not.toThrow();
  });
});

describe("isSecretEntryField", () => {
  it("refuses passwords and one-time codes but not usernames or email", () => {
    expect(isSecretEntryField(field({ type: "password" }))).toBe(true);
    expect(isSecretEntryField(field({ autocomplete: "one-time-code" }))).toBe(true);
    expect(isSecretEntryField(field({ hints: ["Verification code"] }))).toBe(true);
    expect(isSecretEntryField(field({ textSecurity: "disc" }))).toBe(true);
    expect(isSecretEntryField(field({ autocomplete: "username" }))).toBe(false);
    expect(isSecretEntryField(field({ type: "email" }))).toBe(false);
  });
});

describe("scrubProtectedValues", () => {
  it("masks values anywhere in the result, keeping its shape", () => {
    expect(
      scrubProtectedValues(
        { a: "hello alice@example.com", list: ["alice@example.com", 3], alice: true, x: "no" },
        ["alice@example.com", "alice", "no"],
        "•",
      ),
    ).toEqual({ a: "hello •", list: ["•", 3], "•": true, x: "no" });
  });
});
