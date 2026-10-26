// @effect-diagnostics globalDate:off -- Runs in the guest page preload, outside any Effect runtime.
// Adapted from Min (https://github.com/minbrowser/min), js/preload/passwordFill.js,
// licensed under Apache-2.0. Modified for Busyboy: rewritten in TypeScript, reuses
// the autofill field detection, also treats Enter in a password field as a
// submit, and debounces so one sign-in is reported once.

import { autocompleteTokens, isFillable, usernameFieldBefore } from "./PasswordAutofill.ts";

export type PasswordCapture = {
  readonly username: string;
  readonly password: string;
};

type SendPasswordCapture = (capture: PasswordCapture) => void;

/** One sign-in can fire a click, a submit and a `form.submit()` in a row. */
const CAPTURE_DEBOUNCE_MS = 1_000;

/**
 * The password being submitted: on a sign-up or change form that is the first
 * new-password field, not its confirmation.
 */
const submittedPasswordField = (scope: ParentNode) => {
  const fields = [...scope.querySelectorAll<HTMLInputElement>('input[type="password"]')].filter(
    (input) => input.value !== "" && isFillable(input),
  );
  return (
    fields.find((input) => autocompleteTokens(input).includes("new-password")) ??
    fields.find((input) => !autocompleteTokens(input).includes("current-password")) ??
    fields[0]
  );
};

/**
 * Reports the login a page submits so the host can offer to save it. The
 * page decides nothing: main checks the frame's real origin and what is
 * already saved before anyone is asked.
 */
export function installPasswordCapture(send: SendPasswordCapture) {
  let lastSent = 0;

  const capture = (scope: ParentNode) => {
    const passwordField = submittedPasswordField(scope);
    if (passwordField === undefined) {
      return;
    }
    const now = Date.now();
    if (now - lastSent < CAPTURE_DEBOUNCE_MS) {
      return;
    }
    lastSent = now;
    send({
      username: usernameFieldBefore(passwordField)?.value.trim() ?? "",
      password: passwordField.value,
    });
  };

  // Capture phase, so a page that stops the event still gets its login saved.
  window.addEventListener(
    "submit",
    (event) => {
      capture(event.target instanceof HTMLFormElement ? event.target : document);
    },
    true,
  );

  // Sign-in buttons in single-page apps often submit without a form event.
  window.addEventListener(
    "click",
    (event) => {
      const button = event
        .composedPath()
        .find(
          (target): target is HTMLButtonElement =>
            target instanceof HTMLButtonElement && target.type === "submit" && !target.disabled,
        );
      if (button !== undefined) {
        capture(button.form ?? document);
      }
    },
    true,
  );

  window.addEventListener(
    "keydown",
    (event) => {
      if (
        event.key === "Enter" &&
        event.target instanceof HTMLInputElement &&
        event.target.type === "password"
      ) {
        capture(event.target.form ?? document);
      }
    },
    true,
  );

  // `form.submit()` fires no submit event. The preload shares the page's JS
  // world, so the prototype can be wrapped directly.
  const submit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function (this: HTMLFormElement) {
    // The page's own submit must go through whatever capturing does.
    try {
      capture(this);
    } finally {
      submit.call(this);
    }
  };
}
