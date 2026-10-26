/**
 * Scripts the desktop runs in a sign-in page's isolated world. Each is sent as
 * source text, so it must not reference anything outside its own body.
 */

type FieldCheck = {
  readonly password: boolean;
  readonly username: boolean;
  readonly submit: boolean;
};

/** Each selector must match one visible, enabled control of the expected kind. */
export function checkFields(request: {
  readonly passwordSelector: string;
  readonly usernameSelector: string | null;
  readonly submitSelector: string | null;
}): FieldCheck {
  const single = (selector: string) => {
    try {
      const matches = document.querySelectorAll(selector);
      const element = matches.length === 1 ? matches[0] : undefined;
      return element instanceof HTMLElement &&
        element.getClientRects().length > 0 &&
        !(element as HTMLInputElement).disabled
        ? element
        : undefined;
    } catch {
      return undefined;
    }
  };
  const password = single(request.passwordSelector);
  const username = request.usernameSelector === null ? null : single(request.usernameSelector);
  const submit = request.submitSelector === null ? null : single(request.submitSelector);
  return {
    password: password instanceof HTMLInputElement && password.type === "password",
    username:
      username === null ||
      (username instanceof HTMLInputElement && ["text", "email", "tel"].includes(username.type)),
    submit:
      submit === null ||
      submit instanceof HTMLButtonElement ||
      (submit instanceof HTMLInputElement && ["submit", "button", "image"].includes(submit.type)) ||
      submit?.getAttribute("role") === "button",
  };
}

/** Fills like typing (native setter plus input events) and submits as asked. */
export function fillAndSubmit(request: {
  readonly passwordSelector: string;
  readonly usernameSelector: string | null;
  readonly submitSelector: string | null;
  readonly submitWithEnter: boolean;
  readonly username: string;
  readonly password: string;
}): boolean {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  const password = document.querySelector(request.passwordSelector);
  if (setValue === undefined || !(password instanceof HTMLInputElement)) {
    return false;
  }
  const fill = (input: HTMLInputElement, value: string) => {
    input.focus();
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const username =
    request.usernameSelector === null ? null : document.querySelector(request.usernameSelector);
  if (username instanceof HTMLInputElement && request.username !== "") {
    fill(username, request.username);
  }
  fill(password, request.password);

  if (request.submitSelector !== null) {
    const submit = document.querySelector(request.submitSelector);
    if (submit instanceof HTMLElement) {
      submit.click();
    }
  } else if (request.submitWithEnter) {
    if (password.form) {
      password.form.requestSubmit();
    } else {
      for (const type of ["keydown", "keypress", "keyup"]) {
        password.dispatchEvent(
          new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }),
        );
      }
    }
  }
  return true;
}

export function pageHoldsPasswordScript(): boolean {
  return [...document.querySelectorAll("input[type='password']")].some(
    (input) => input instanceof HTMLInputElement && input.value !== "",
  );
}

export function clearPasswordFieldsScript(): void {
  for (const input of document.querySelectorAll("input[type='password']")) {
    if (input instanceof HTMLInputElement) {
      input.value = "";
    }
  }
}
