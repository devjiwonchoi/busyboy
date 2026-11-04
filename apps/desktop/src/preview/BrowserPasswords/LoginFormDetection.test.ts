// @vitest-environment jsdom
import { describe, expect, it } from "@effect/vitest";

import {
  createTokenRegistry,
  detectLoginForms,
  isUsernameLikeField,
  type DetectionEnvironment,
} from "./LoginFormDetection.ts";

// jsdom has no layout, so fixtures mark invisible fields with a class instead.
const environment = (): DetectionEnvironment => {
  const registry = createTokenRegistry((array) => crypto.getRandomValues(array));
  return {
    isVisible: (element) => element.closest(".invisible") === null,
    tokenFor: registry.tokenFor,
    querySelectorAll: (root, selector) => root.querySelectorAll(selector),
  };
};

const detect = (html: string, env = environment()) => {
  document.body.innerHTML = html;
  return detectLoginForms(document, env);
};

const byId = (id: string) => document.getElementById(id);

describe("detectLoginForms", () => {
  it("finds a sign-in form and its username", () => {
    const [form, ...rest] = detect(`
      <form id="f">
        <input id="u" name="login" type="text">
        <input id="p" type="password" autocomplete="current-password">
        <button id="b">Sign in</button>
      </form>`);
    expect(rest).toHaveLength(0);
    expect(form?.kind).toBe("signIn");
    expect(form?.form).toBe(byId("f"));
    expect(form?.username).toBe(byId("u"));
    expect(form?.passwords.map((field) => [field.element, field.role])).toEqual([
      [byId("p"), "currentPassword"],
    ]);
    expect(form?.submitButton).toBe(byId("b"));
  });

  it("treats a single untagged password field as sign-in", () => {
    const [form] = detect(`<form><input id="u"><input id="p" type="password"></form>`);
    expect(form?.kind).toBe("signIn");
    expect(form?.username).toBe(byId("u"));
  });

  it("finds a sign-up form with new and confirm passwords", () => {
    const [form] = detect(`
      <form>
        <input id="name" name="fullname">
        <input id="e" type="email" autocomplete="email">
        <input id="p1" type="password" autocomplete="new-password">
        <input id="p2" type="password" autocomplete="new-password">
      </form>`);
    expect(form?.kind).toBe("signUp");
    expect(form?.username).toBe(byId("e"));
    expect(form?.passwords.map((field) => field.role)).toEqual(["newPassword", "confirmPassword"]);
  });

  it("finds a change-password form", () => {
    const [form] = detect(`
      <form>
        <input id="u" autocomplete="username" type="text">
        <input type="password" autocomplete="current-password">
        <input type="password" autocomplete="new-password">
        <input type="password">
      </form>`);
    expect(form?.kind).toBe("changePassword");
    expect(form?.username).toBe(byId("u"));
    expect(form?.passwords.map((field) => field.role)).toEqual([
      "currentPassword",
      "newPassword",
      "confirmPassword",
    ]);
  });

  it("orders untagged password fields as current then new", () => {
    const [form] = detect(`<form><input type="password"><input type="password"></form>`);
    expect(form?.passwords.map((field) => field.role)).toEqual(["currentPassword", "newPassword"]);
    expect(form?.kind).toBe("changePassword");
  });

  it("groups formless inputs by their nearest common ancestor", () => {
    const [form] = detect(`
      <div id="signin">
        <div><input id="u" type="email"></div>
        <div><input id="p" type="password"></div>
        <div role="button" id="go">Continue</div>
      </div>`);
    expect(form?.form).toBeNull();
    expect(form?.container).toBe(byId("signin"));
    expect(form?.username).toBe(byId("u"));
    expect(form?.submitButton).toBe(byId("go"));
  });

  it("reports page 1 of a multi-step login as username-like but not a login form", () => {
    expect(
      detect(`<form><input id="u" type="email" name="identifier"><button>Next</button></form>`),
    ).toEqual([]);
    expect(isUsernameLikeField(byId("u") as HTMLInputElement)).toBe(true);
  });

  it("finds page 2 of a multi-step login as a password-only form", () => {
    const [form] = detect(
      `<form><input id="p" type="password" autocomplete="current-password"></form>`,
    );
    expect(form?.kind).toBe("signIn");
    expect(form?.username).toBeNull();
  });

  it("finds no login form on a one-time-code page", () => {
    expect(
      detect(`
        <form>
          <label for="c">Verification code</label>
          <input id="c" inputmode="numeric" maxlength="6">
          <input type="password" autocomplete="one-time-code">
          <input type="password" autocomplete="off">
        </form>`),
    ).toEqual([]);
  });

  it("keeps an autocomplete=off password field when nothing marks a one-time code", () => {
    expect(detect(`<form><input><input type="password" autocomplete="off"></form>`)).toHaveLength(
      1,
    );
  });

  it("returns one result per form with distinct tokens", () => {
    const forms = detect(`
      <form id="a"><input name="user"><input type="password"></form>
      <form id="b"><input type="email"><input type="password" autocomplete="new-password"></form>`);
    expect(forms.map((form) => form.form?.id)).toEqual(["a", "b"]);
    expect(forms.map((form) => form.kind)).toEqual(["signIn", "signUp"]);
    expect(new Set(forms.map((form) => form.token)).size).toBe(2);
  });

  it("ignores credit card forms", () => {
    expect(
      detect(`
        <form>
          <input autocomplete="cc-name">
          <input autocomplete="cc-number">
          <input type="password" autocomplete="cc-csc">
        </form>`),
    ).toEqual([]);
  });

  it("ignores invisible password fields", () => {
    expect(
      detect(`<form><input name="user"><input class="invisible" type="password"></form>`),
    ).toEqual([]);
  });

  it("skips invisible username candidates", () => {
    const [form] = detect(`
      <form><input id="v" name="login"><input class="invisible" name="email"><input type="password"></form>`);
    expect(form?.username).toBe(byId("v"));
  });

  it("falls back to name hints when no input precedes the password", () => {
    const [form] = detect(`<form><input type="password"><input id="u" name="account_id"></form>`);
    expect(form?.username).toBe(byId("u"));
  });

  it("keeps tokens stable across rescans and random rather than page-derived", () => {
    const env = environment();
    const [first] = detect(`<form id="login"><input type="password"></form>`, env);
    const [second] = detectLoginForms(document, env);
    expect(first?.token).toBe(second?.token);
    expect(first?.token).toMatch(/^[0-9a-f]{32}$/);
    expect(first?.token).not.toContain("login");
  });
});
