// @vitest-environment jsdom
import { createRequire } from "node:module";

import { describe, expect, it } from "@effect/vitest";

import {
  PASSWORD_CHILD_FRAME_CHANNEL,
  PASSWORD_DROPDOWN_STATE_CHANNEL,
  PASSWORD_FIELD_FOCUS_CHANNEL,
  PASSWORD_FIELD_KEY_CHANNEL,
  PASSWORD_FILL_CHANNEL,
  PASSWORD_FORMS_CHANNEL,
  PASSWORD_FRAME_TOKEN_CHANNEL,
  PASSWORD_SUBMIT_CHANNEL,
} from "../GuestProtocol.ts";
import type { GuestFormsReport } from "./PasswordGuestMessages.ts";
import { FRAME_MESSAGE_TYPE, installPasswordPreload } from "./PasswordPreload.ts";

// Each test gets its own window so listeners from earlier installs cannot leak in.
const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom") as {
  JSDOM: new (html: string) => { window: Window & typeof globalThis };
};
// Script-dispatched events are never trusted; the browser's own input is. jsdom
// only marks events trusted through its internal dispatch, which tests reach here.
const { implForWrapper } = require("jsdom/lib/generated/idl/utils.js") as {
  implForWrapper: (wrapper: object) => any;
};

const dispatchTrusted = (target: EventTarget, event: Event) => {
  const impl = implForWrapper(event);
  impl.isTrusted = true;
  implForWrapper(target)._dispatch(impl);
  return event;
};

interface Sent {
  readonly channel: string;
  readonly payload: any;
}

const setup = (html: string) => {
  const { window: win } = new JSDOM(`<!doctype html><body>${html}</body>`);
  const sent: Array<Sent> = [];
  const listeners = new Map<string, (payload: unknown) => void>();
  const handle = installPasswordPreload({
    window: win,
    ipc: {
      send: (channel, payload) => sent.push({ channel, payload }),
      on: (channel, listener) => listeners.set(channel, listener),
    },
    isVisible: (element) => element.closest(".invisible") === null,
  });
  if (!handle) throw new Error("preload did not install");
  handle.scanNow();
  const doc = win.document;
  const input = (id: string) => doc.getElementById(id) as HTMLInputElement;
  const fromMain = (channel: string, payload: unknown) => listeners.get(channel)?.(payload);
  const on = (channel: string) => sent.filter((message) => message.channel === channel);
  const lastReport = () => on(PASSWORD_FORMS_CHANNEL).at(-1)?.payload as GuestFormsReport;
  return { win, doc, sent, input, fromMain, on, lastReport, handle };
};

const SIGN_IN = `
  <form id="form">
    <input id="user" name="username" autocomplete="username">
    <input id="pass" type="password" autocomplete="current-password">
    <button id="submit">Sign in</button>
  </form>`;

describe("installPasswordPreload", () => {
  it("reports detected forms with roles and a filled flag, never values", () => {
    const page = setup(SIGN_IN);
    page.input("pass").value = "secret-typed";
    page.handle.scanNow();
    const report = page.lastReport();
    expect(report.forms).toHaveLength(1);
    expect(report.forms[0]?.kind).toBe("signIn");
    expect(report.forms[0]?.fields.map((field) => field.role)).toEqual([
      "username",
      "currentPassword",
    ]);
    expect(report.forms[0]?.passwordFilled).toBe(true);
    expect(JSON.stringify(page.sent)).not.toContain("secret-typed");
    expect(page.on(PASSWORD_FRAME_TOKEN_CHANNEL)).toHaveLength(1);
  });

  it("captures typed values once when a button click causes a submit", () => {
    const page = setup(SIGN_IN);
    page.input("user").value = "ada";
    page.input("pass").value = "hunter2";
    dispatchTrusted(page.input("submit"), new page.win.MouseEvent("click", { bubbles: true }));
    dispatchTrusted(
      page.doc.getElementById("form")!,
      new page.win.Event("submit", { bubbles: true }),
    );
    const submits = page.on(PASSWORD_SUBMIT_CHANNEL);
    expect(submits).toHaveLength(1);
    expect(submits[0]?.payload).toMatchObject({
      kind: "signIn",
      username: "ada",
      password: "hunter2",
      formToken: page.lastReport().forms[0]?.token,
    });
  });

  it("captures Enter in the password field", () => {
    const page = setup(SIGN_IN);
    page.input("pass").value = "hunter2";
    dispatchTrusted(
      page.input("pass"),
      new page.win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(page.on(PASSWORD_SUBMIT_CHANNEL)[0]?.payload).toMatchObject({
      username: "",
      password: "hunter2",
    });
  });

  it("captures the new password on a sign-up form without a form element", () => {
    const page = setup(`
      <div>
        <input id="email" type="email">
        <input id="pass" type="password" autocomplete="new-password">
        <div role="button" id="go">Create account</div>
      </div>`);
    page.input("email").value = "ada@example.com";
    page.input("pass").value = "fresh";
    dispatchTrusted(page.input("go"), new page.win.MouseEvent("click", { bubbles: true }));
    expect(page.on(PASSWORD_SUBMIT_CHANNEL)[0]?.payload).toMatchObject({
      kind: "signUp",
      username: "ada@example.com",
      password: "",
      newPassword: "fresh",
    });
  });

  it("ignores submit events the page script dispatches itself", () => {
    const page = setup(SIGN_IN);
    page.input("pass").value = "hunter2";
    // A script calling button.click() makes the browser submit the form for
    // real (a trusted event), so only synthetic events are ignored here; main
    // drops agent-driven submissions separately.
    page.doc.getElementById("form")!.dispatchEvent(new page.win.Event("submit"));
    expect(page.on(PASSWORD_SUBMIT_CHANNEL)).toHaveLength(0);
  });

  it("fills through the pristine setter and dispatches input and change", () => {
    const page = setup(SIGN_IN);
    const seen: Array<string> = [];
    for (const type of ["input", "change"])
      page.doc.addEventListener(type, (event) => {
        const target = event.target as HTMLInputElement;
        seen.push(`${type}:${target.id}:${String(event.bubbles)}`);
      });
    const formToken = page.lastReport().forms[0]?.token;
    page.fromMain(PASSWORD_FILL_CHANNEL, { formToken, username: "ada", password: "hunter2" });
    expect(page.input("user").value).toBe("ada");
    expect(page.input("pass").value).toBe("hunter2");
    expect(seen).toEqual([
      "input:user:true",
      "change:user:true",
      "input:pass:true",
      "change:pass:true",
    ]);
  });

  it("does not let a page setter installed later intercept the fill", () => {
    const page = setup(SIGN_IN);
    const descriptor = Object.getOwnPropertyDescriptor(
      page.win.HTMLInputElement.prototype,
      "value",
    )!;
    const intercepted: Array<unknown> = [];
    Object.defineProperty(page.win.HTMLInputElement.prototype, "value", {
      configurable: true,
      get: descriptor.get!,
      set(value: unknown) {
        intercepted.push(value);
        descriptor.set!.call(this, value);
      },
    });
    const formToken = page.lastReport().forms[0]?.token;
    page.fromMain(PASSWORD_FILL_CHANNEL, { formToken, username: "ada", password: "hunter2" });
    expect(intercepted).toEqual([]);
    expect(descriptor.get!.call(page.input("pass"))).toBe("hunter2");
  });

  it("skips invisible fields and unknown form tokens", () => {
    const page = setup(SIGN_IN);
    const formToken = page.lastReport().forms[0]?.token;
    page.input("user").classList.add("invisible");
    page.fromMain(PASSWORD_FILL_CHANNEL, { formToken, username: "ada", password: "hunter2" });
    expect(page.input("user").value).toBe("");
    expect(page.input("pass").value).toBe("hunter2");

    page.fromMain(PASSWORD_FILL_CHANNEL, { formToken: "unknown", username: "x", password: "y" });
    expect(page.input("pass").value).toBe("hunter2");
  });

  it("fills only the password when the form has no username field", () => {
    const page = setup(`<form><input id="pass" type="password"></form>`);
    const formToken = page.lastReport().forms[0]?.token;
    page.fromMain(PASSWORD_FILL_CHANNEL, { formToken, username: "ada", password: "hunter2" });
    expect(page.input("pass").value).toBe("hunter2");
  });

  it("adds nothing to window", () => {
    const { window: win } = new JSDOM("<!doctype html><body></body>");
    const before = new Set(Reflect.ownKeys(win));
    installPasswordPreload({ window: win, ipc: { send: () => {}, on: () => {} } });
    expect(Reflect.ownKeys(win).filter((key) => !before.has(key))).toEqual([]);
  });

  it("reports the username typed on page 1 of a multi-step login", () => {
    const page = setup(`<form><input id="email" type="email"><button>Next</button></form>`);
    page.input("email").value = "ada@example.com";
    dispatchTrusted(page.input("email"), new page.win.InputEvent("input", { bubbles: true }));
    page.handle.scanNow();
    expect(page.lastReport()).toEqual({ forms: [], typedUsername: "ada@example.com" });
  });

  it("forwards list keys only while the dropdown is open", () => {
    const page = setup(SIGN_IN);
    dispatchTrusted(page.input("pass"), new page.win.FocusEvent("focusin", { bubbles: true }));
    expect(page.on(PASSWORD_FIELD_FOCUS_CHANNEL)).toHaveLength(1);
    const press = (key: string) =>
      dispatchTrusted(
        page.input("pass"),
        new page.win.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );

    expect(press("ArrowDown").defaultPrevented).toBe(false);
    expect(press("Escape").defaultPrevented).toBe(false);
    expect(page.on(PASSWORD_FIELD_KEY_CHANNEL).map((message) => message.payload.key)).toEqual([
      "ArrowDown",
    ]);

    page.fromMain(PASSWORD_DROPDOWN_STATE_CHANNEL, { open: true });
    page.input("pass").value = "typed";
    expect(press("Enter").defaultPrevented).toBe(true);
    expect(press("Tab").defaultPrevented).toBe(false);
    expect(page.on(PASSWORD_FIELD_KEY_CHANNEL).map((message) => message.payload.key)).toEqual([
      "ArrowDown",
      "Enter",
      "Tab",
    ]);
    expect(page.on(PASSWORD_SUBMIT_CHANNEL)).toHaveLength(0);
  });

  it("reports where a child frame sits when it announces itself", () => {
    const page = setup(`<iframe id="child"></iframe>`);
    const frame = page.doc.getElementById("child") as HTMLIFrameElement;
    page.win.dispatchEvent(
      new page.win.MessageEvent("message", {
        data: { type: FRAME_MESSAGE_TYPE, token: "child-token" },
        source: frame.contentWindow,
      }),
    );
    expect(page.on(PASSWORD_CHILD_FRAME_CHANNEL)[0]?.payload).toEqual({
      childToken: "child-token",
      // The iframe's default 2px border sits between its box and the child's viewport.
      rect: { x: 2, y: 2, width: 0, height: 0 },
    });
  });
});
