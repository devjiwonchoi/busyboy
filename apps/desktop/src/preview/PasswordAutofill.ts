// @effect-diagnostics globalTimers:off -- Runs in the guest page preload, outside any Effect runtime.

type PasswordFillRequest = {
  readonly typedUsername: string;
  readonly wantsPassword: boolean;
};

type InvokePasswordFill = (request: PasswordFillRequest) => Promise<unknown>;

const SCAN_DELAY_MS = 250;
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

const isFillable = (input: HTMLInputElement) =>
  !input.disabled &&
  !input.readOnly &&
  input.getClientRects().length > 0 &&
  isOnScreen(input) &&
  getComputedStyle(input).visibility !== "hidden" &&
  // A field the page made invisible is a trap, not a sign-in form.
  getComputedStyle(input).opacity !== "0";

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
 * Identifier-first sign-ins (Google, Microsoft) ask for the username alone.
 * Only fields that say they want one count, so search boxes are left alone.
 */
const standaloneUsernameField = () =>
  [...document.querySelectorAll("input")].find(
    (input) =>
      (autocompleteTokens(input).includes("username") || input.type === "email") &&
      isFillable(input),
  );

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
export function installPasswordAutofill(invoke: InvokePasswordFill) {
  // Each field is offered at most once, so a page with no saved login is not
  // asked about again on every DOM change.
  const offered = new WeakSet<HTMLInputElement>();
  let scanTimer: ReturnType<typeof setTimeout> | undefined;
  let requestInFlight = false;

  const scan = async () => {
    if (requestInFlight) {
      return;
    }

    // Sign-up forms ask for a new password; those are never filled.
    const passwordFields = [
      ...document.querySelectorAll<HTMLInputElement>('input[type="password"]'),
    ].filter((input) => !autocompleteTokens(input).includes("new-password") && isFillable(input));
    const passwordField = passwordFields.find((input) => !offered.has(input) && input.value === "");
    if (passwordFields.length > 0 && passwordField === undefined) {
      return;
    }

    const usernameField =
      passwordField === undefined ? standaloneUsernameField() : usernameFieldBefore(passwordField);
    const target = passwordField ?? usernameField;
    if (target === undefined || offered.has(target) || target.value !== "") {
      return;
    }
    offered.add(target);

    requestInFlight = true;
    try {
      const fill = readFill(
        await invoke({
          typedUsername: usernameField?.value ?? "",
          wantsPassword: passwordField !== undefined,
        }),
      );
      if (fill === undefined) {
        return;
      }

      if (usernameField !== undefined && usernameField.value === "" && fill.username !== "") {
        fillField(usernameField, fill.username);
      }
      if (passwordField !== undefined && passwordField.value === "" && fill.password !== null) {
        fillField(passwordField, fill.password);
      }
    } catch {
      // A failed lookup leaves the form for the user to fill.
    } finally {
      requestInFlight = false;
    }
  };

  const scheduleScan = () => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => void scan(), SCAN_DELAY_MS);
  };

  const start = () => {
    scheduleScan();
    // Single-page sign-ins render their forms after load.
    new MutationObserver(scheduleScan).observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["type", "style", "class", "hidden"],
    });
  };

  // Like Chrome, nothing is filled until someone actually clicks or types in
  // the page, so a script that loads with it cannot read a login unattended.
  const startOnGesture = (event: Event) => {
    if (!event.isTrusted) {
      return;
    }
    window.removeEventListener("pointerdown", startOnGesture, true);
    window.removeEventListener("keydown", startOnGesture, true);
    start();
  };
  window.addEventListener("pointerdown", startOnGesture, true);
  window.addEventListener("keydown", startOnGesture, true);
}
