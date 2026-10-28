// @effect-diagnostics globalTimers:off -- Runs in the guest page preload, outside any Effect runtime.

type PasswordFillRequest = {
  readonly typedUsername: string;
  readonly wantsPassword: boolean;
};

type InvokePasswordFill = (request: PasswordFillRequest) => Promise<unknown>;

const USERNAME_INPUT_TYPES = new Set(["text", "email", "tel"]);

const autocompleteTokens = (input: HTMLInputElement) =>
  input.autocomplete.toLowerCase().split(/\s+/);

/** In view and big enough to see: a field parked off-screen or shrunk to a dot is a trap. */
const isOnScreen = (input: HTMLInputElement) => {
  const rect = input.getBoundingClientRect();
  return (
    rect.width >= 4 &&
    rect.height >= 4 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth
  );
};

/** Opacity is not inherited in computed style, so a faded ancestor is checked too. */
const isOpaqueEnough = (input: HTMLInputElement) => {
  let opacity = 1;
  for (let element: Element | null = input; element !== null; element = element.parentElement) {
    opacity *= Number(getComputedStyle(element).opacity);
  }
  return opacity >= 0.1;
};

const isFillable = (input: HTMLInputElement) =>
  !input.disabled &&
  !input.readOnly &&
  input.getClientRects().length > 0 &&
  isOnScreen(input) &&
  getComputedStyle(input).visibility !== "hidden" &&
  // A field the page made invisible is a trap, not a sign-in form.
  isOpaqueEnough(input);

/** The visible text field just before the password field, in its form when it has one. */
const usernameFieldBefore = (passwordField: HTMLInputElement) => {
  const scope = passwordField.form ?? document;
  const candidates = [...scope.querySelectorAll("input")].filter(
    (input) =>
      USERNAME_INPUT_TYPES.has(input.type) &&
      isFillable(input) &&
      input.compareDocumentPosition(passwordField) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
  return candidates.at(-1);
};

/**
 * Sets the value through the native setter so frameworks that track the last
 * value they wrote (React) notice the change, then reports it like typing.
 */
const fillField = (input: HTMLInputElement, value: string) => {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setValue === undefined) {
    return;
  }
  setValue.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
};

const readFill = (value: unknown) => {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const { username, password } = value as Record<string, unknown>;
  if (typeof username !== "string" || (password !== null && typeof password !== "string")) {
    return undefined;
  }
  return { username, password };
};

/**
 * Fills saved logins into the page once a person interacts with it. Main
 * decides what this origin may have and refuses pages an agent drives, so the
 * page only ever sees the login for itself.
 */
/**
 * Which sign-in fields a click or Tab into `target` should fill, or nothing
 * when it is not an empty field of a sign-in form.
 */
const fieldsFor = (target: HTMLInputElement) => {
  if (target.value !== "" || !isFillable(target)) {
    return undefined;
  }
  if (target.type === "password") {
    // Sign-up forms ask for a new password; those are never filled.
    return autocompleteTokens(target).includes("new-password")
      ? undefined
      : { passwordField: target, usernameField: usernameFieldBefore(target) };
  }
  if (!USERNAME_INPUT_TYPES.has(target.type)) {
    return undefined;
  }
  const passwordField = [
    ...(target.form ?? document).querySelectorAll<HTMLInputElement>('input[type="password"]'),
  ].find(
    (input) =>
      input.value === "" &&
      !autocompleteTokens(input).includes("new-password") &&
      isFillable(input) &&
      target.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING,
  );
  if (passwordField !== undefined) {
    return { passwordField, usernameField: target };
  }
  // Identifier-first sign-ins (Google, Microsoft) ask for the username alone.
  // Only fields that say they want one count, so search boxes are left alone.
  return autocompleteTokens(target).includes("username") || target.type === "email"
    ? { passwordField: undefined, usernameField: target }
    : undefined;
};

export function installPasswordAutofill(invoke: InvokePasswordFill) {
  let requestInFlight = false;

  const fill = async (target: EventTarget | null) => {
    if (requestInFlight || !(target instanceof HTMLInputElement)) {
      return;
    }
    const fields = fieldsFor(target);
    if (fields === undefined) {
      return;
    }
    const { passwordField, usernameField } = fields;

    requestInFlight = true;
    try {
      const login = readFill(
        await invoke({
          typedUsername: usernameField?.value ?? "",
          wantsPassword: passwordField !== undefined,
        }),
      );
      if (login === undefined) {
        return;
      }
      if (usernameField !== undefined && usernameField.value === "" && login.username !== "") {
        fillField(usernameField, login.username);
      }
      if (passwordField !== undefined && passwordField.value === "" && login.password !== null) {
        fillField(passwordField, login.password);
      }
    } catch {
      // A failed lookup leaves the form for the user to fill.
    } finally {
      requestInFlight = false;
    }
  };

  // Like Safari, a login is filled when the person clicks or tabs into one of
  // its fields, never on its own: a script cannot plant a hidden form and
  // wait for any click on the page. Main checks the input really happened.
  window.addEventListener(
    "pointerdown",
    (event) => {
      if (event.isTrusted) {
        void fill(event.target);
      }
    },
    true,
  );
  window.addEventListener(
    "keyup",
    (event) => {
      if (event.isTrusted && event.key === "Tab") {
        void fill(document.activeElement);
      }
    },
    true,
  );
}
