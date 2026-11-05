import type { LoginFieldRole, LoginFormKind } from "./PasswordGuestMessages.ts";
import { MAX_FIELDS_PER_FORM, MAX_FORMS_PER_FRAME } from "./PasswordGuestLimits.ts";

/**
 * Finds login forms in one frame's DOM. Pure DOM logic with no Electron
 * imports: the guest preload passes pristine DOM helpers, and tests pass stubs
 * because jsdom has no layout.
 */

export interface DetectionEnvironment {
  readonly isVisible: (element: Element) => boolean;
  /** Opaque token for an element, stable across scans of the same element. */
  readonly tokenFor: (element: Element) => string;
  readonly querySelectorAll: (root: ParentNode, selector: string) => ArrayLike<Element>;
}

export interface DetectedPasswordField {
  readonly element: HTMLInputElement;
  readonly role: Exclude<LoginFieldRole, "username">;
}

export interface DetectedLoginForm {
  readonly token: string;
  readonly kind: LoginFormKind;
  /** The `<form>`, or for formless inputs their nearest common ancestor. */
  readonly container: Element;
  readonly form: HTMLFormElement | null;
  readonly username: HTMLInputElement | null;
  readonly passwords: ReadonlyArray<DetectedPasswordField>;
  readonly submitButton: HTMLElement | null;
}

/** Stops a hostile page from making each scan walk an unbounded number of inputs. */
export const MAX_SCANNED_INPUTS = 500;
const MAX_PASSWORD_FIELDS = 3;
const MAX_OTP_LENGTH = 8;
const DOCUMENT_POSITION_FOLLOWING = 4;

const TEXT_LIKE_TYPES = new Set(["text", "email", "tel", ""]);
const NON_FIELD_TYPES = new Set([
  "hidden",
  "submit",
  "button",
  "reset",
  "image",
  "checkbox",
  "radio",
  "file",
  "range",
  "color",
  "date",
  "datetime-local",
  "month",
  "week",
  "time",
  "number",
  "search",
  "url",
]);
const USERNAME_HINT = /user|login|e-?mail|account|(?:^|[^a-z])id(?:$|[^a-z])/i;
const CODE_HINT = /code|otp|one.?time|verif/i;

const inputType = (input: HTMLInputElement) => (input.getAttribute("type") ?? "").toLowerCase();

export const autocompleteTokens = (input: HTMLInputElement): ReadonlyArray<string> =>
  (input.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/).filter(Boolean);

const hintText = (input: HTMLInputElement) => {
  const parts = [
    input.getAttribute("name"),
    input.getAttribute("id"),
    input.getAttribute("placeholder"),
    input.getAttribute("aria-label"),
  ];
  for (const label of Array.from(input.labels ?? [])) parts.push(label.textContent);
  return parts.filter((part): part is string => typeof part === "string").join(" ");
};

const isCreditCardField = (input: HTMLInputElement) =>
  autocompleteTokens(input).some((token) => token.startsWith("cc-"));

/** One-time codes are never saved as passwords. */
export const isOneTimeCodeField = (input: HTMLInputElement): boolean => {
  if (autocompleteTokens(input).includes("one-time-code")) return true;
  if ((input.getAttribute("inputmode") ?? "").toLowerCase() !== "numeric") return false;
  const maxLength = input.maxLength;
  return maxLength > 0 && maxLength <= MAX_OTP_LENGTH && CODE_HINT.test(hintText(input));
};

const isTextLike = (input: HTMLInputElement) => TEXT_LIKE_TYPES.has(inputType(input));

/** A field someone types an account identifier into, with or without a password beside it. */
export const isUsernameLikeField = (input: HTMLInputElement): boolean => {
  if (!isTextLike(input) || isOneTimeCodeField(input) || isCreditCardField(input)) return false;
  const tokens = autocompleteTokens(input);
  if (tokens.includes("username") || tokens.includes("email")) return true;
  if (inputType(input) === "email") return true;
  return USERNAME_HINT.test(hintText(input));
};

const precedes = (a: Node, b: Node) =>
  (a.compareDocumentPosition(b) & DOCUMENT_POSITION_FOLLOWING) !== 0;

interface Group {
  readonly container: Element;
  readonly form: HTMLFormElement | null;
  readonly inputs: Array<HTMLInputElement>;
}

/** The nearest ancestor of a formless password field that also holds a text-like input. */
const formlessContainer = (
  password: HTMLInputElement,
  formless: ReadonlyArray<HTMLInputElement>,
) => {
  let node = password.parentElement;
  while (node && node.parentElement && node !== password.ownerDocument.body) {
    const ancestor = node;
    if (
      formless.some((input) => input !== password && isTextLike(input) && ancestor.contains(input))
    )
      return ancestor;
    node = node.parentElement;
  }
  return node ?? password.ownerDocument.documentElement;
};

const groupInputs = (inputs: ReadonlyArray<HTMLInputElement>, env: DetectionEnvironment) => {
  const groups = new Map<Element, Group>();
  const formless: Array<HTMLInputElement> = [];
  for (const input of inputs) {
    const form = input.form;
    if (!form) {
      formless.push(input);
      continue;
    }
    let group = groups.get(form);
    if (!group) groups.set(form, (group = { container: form, form, inputs: [] }));
    group.inputs.push(input);
  }
  const formlessPasswords = formless.filter(
    (input) => inputType(input) === "password" && env.isVisible(input),
  );
  const formlessContainers = new Set<Element>();
  for (const password of formlessPasswords)
    formlessContainers.add(formlessContainer(password, formless));
  for (const container of formlessContainers) {
    groups.set(container, {
      container,
      form: null,
      inputs: formless.filter((input) => container.contains(input)),
    });
  }
  return [...groups.values()];
};

const assignPasswordRoles = (
  passwords: ReadonlyArray<HTMLInputElement>,
): Array<DetectedPasswordField> => {
  const explicit = passwords.map((element) => {
    const tokens = autocompleteTokens(element);
    if (tokens.includes("current-password")) return "currentPassword" as const;
    if (tokens.includes("new-password")) return "newPassword" as const;
    return null;
  });
  const fields: Array<DetectedPasswordField> = [];
  let sawNew = false;
  passwords.forEach((element, index) => {
    let role: DetectedPasswordField["role"] =
      explicit[index] ?? (index === 0 ? "currentPassword" : "newPassword");
    if (role === "newPassword") {
      if (sawNew) role = "confirmPassword";
      sawNew = true;
    }
    fields.push({ element, role });
  });
  return fields;
};

const formKind = (fields: ReadonlyArray<DetectedPasswordField>): LoginFormKind => {
  const hasCurrent = fields.some((field) => field.role === "currentPassword");
  const hasNew = fields.some((field) => field.role !== "currentPassword");
  if (hasCurrent && hasNew) return "changePassword";
  return hasNew ? "signUp" : "signIn";
};

const inferUsername = (
  candidates: ReadonlyArray<HTMLInputElement>,
  firstPassword: HTMLInputElement,
): HTMLInputElement | null => {
  const byAutocomplete = candidates.find((input) => {
    const tokens = autocompleteTokens(input);
    return tokens.includes("username") || tokens.includes("email");
  });
  if (byAutocomplete) return byAutocomplete;
  const preceding = candidates.filter((input) => precedes(input, firstPassword));
  const closest = preceding.at(-1);
  if (closest) return closest;
  return candidates.find((input) => USERNAME_HINT.test(hintText(input))) ?? null;
};

const SUBMIT_IN_FORM =
  'button[type="submit"], button:not([type]), input[type="submit"], input[type="image"]';
const BUTTON_LIKE =
  'button, input[type="submit"], input[type="button"], input[type="image"], [role="button"]';

const findSubmitButton = (
  group: Group,
  lastPassword: HTMLInputElement,
  env: DetectionEnvironment,
): HTMLElement | null => {
  if (group.form) {
    const buttons = Array.from(env.querySelectorAll(group.container, SUBMIT_IN_FORM));
    const visible = buttons.find((button) => env.isVisible(button));
    return (visible as HTMLElement | undefined) ?? null;
  }
  // Formless: the button-like element nearest the password field, preferring one after it.
  const buttons = Array.from(env.querySelectorAll(group.container, BUTTON_LIKE)).filter((button) =>
    env.isVisible(button),
  ) as Array<HTMLElement>;
  return (
    buttons.find((button) => precedes(lastPassword, button)) ??
    buttons.filter((button) => precedes(button, lastPassword)).at(-1) ??
    null
  );
};

const detectGroup = (group: Group, env: DetectionEnvironment): DetectedLoginForm | null => {
  const fields = group.inputs.filter(
    (input) =>
      !NON_FIELD_TYPES.has(inputType(input)) &&
      !input.disabled &&
      !isCreditCardField(input) &&
      env.isVisible(input),
  );
  const groupMarksOneTimeCode = group.inputs.some((input) =>
    autocompleteTokens(input).includes("one-time-code"),
  );
  const passwords = fields.filter(
    (input) =>
      inputType(input) === "password" &&
      !isOneTimeCodeField(input) &&
      !(groupMarksOneTimeCode && autocompleteTokens(input).includes("off")),
  );
  if (passwords.length === 0 || passwords.length > MAX_PASSWORD_FIELDS) return null;
  const firstPassword = passwords[0]!;
  const lastPassword = passwords.at(-1)!;
  const candidates = fields.filter((input) => isTextLike(input) && !isOneTimeCodeField(input));
  const passwordFields = assignPasswordRoles(passwords);
  return {
    token: env.tokenFor(group.container),
    kind: formKind(passwordFields),
    container: group.container,
    form: group.form,
    username: inferUsername(candidates, firstPassword),
    passwords: passwordFields.slice(0, MAX_FIELDS_PER_FORM - 1),
    submitButton: findSubmitButton(group, lastPassword, env),
  };
};

/** Every visible login form in this document, in document order. */
export const detectLoginForms = (
  root: Document,
  env: DetectionEnvironment,
): Array<DetectedLoginForm> => {
  const inputs = Array.from(env.querySelectorAll(root, "input")).slice(
    0,
    MAX_SCANNED_INPUTS,
  ) as Array<HTMLInputElement>;
  const forms: Array<DetectedLoginForm> = [];
  for (const group of groupInputs(inputs, env)) {
    const detected = detectGroup(group, env);
    if (detected) forms.push(detected);
  }
  forms.sort((a, b) => (precedes(a.container, b.container) ? -1 : 1));
  return forms.slice(0, MAX_FORMS_PER_FRAME);
};

/** Random tokens for elements, never derived from page data. */
export const createTokenRegistry = (
  getRandomValues: (array: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>,
) => {
  const tokens = new WeakMap<Element, string>();
  const nextToken = () => {
    const bytes = getRandomValues(new Uint8Array(16));
    let token = "";
    for (const byte of bytes) token += byte.toString(16).padStart(2, "0");
    return token;
  };
  return {
    nextToken,
    tokenFor: (element: Element) => {
      let token = tokens.get(element);
      if (!token) tokens.set(element, (token = nextToken()));
      return token;
    },
  };
};

export interface VisibilityPrimitives {
  readonly getBoundingClientRect: (element: Element) => DOMRect;
  readonly getComputedStyle: (element: Element) => CSSStyleDeclaration;
  /** `Element.prototype.checkVisibility` when the engine has it. */
  readonly checkVisibility?: (element: Element) => boolean;
  readonly scrollOffset: () => { readonly x: number; readonly y: number };
}

const MAX_OPACITY_ANCESTORS = 12;

/** Zero size, `display:none`, `visibility:hidden`, `opacity:0`, or placed where no scroll reaches. */
export const createVisibilityCheck =
  (primitives: VisibilityPrimitives) =>
  (element: Element): boolean => {
    const rect = primitives.getBoundingClientRect(element);
    if (!(rect.width > 0 && rect.height > 0)) return false;
    const scroll = primitives.scrollOffset();
    if (rect.right + scroll.x <= 0 || rect.bottom + scroll.y <= 0) return false;
    if (primitives.checkVisibility && !primitives.checkVisibility(element)) return false;
    const style = primitives.getComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse"
    )
      return false;
    let node: Element | null = element;
    for (let depth = 0; node && depth < MAX_OPACITY_ANCESTORS; depth += 1) {
      if (Number.parseFloat(primitives.getComputedStyle(node).opacity) === 0) return false;
      node = node.parentElement;
    }
    return true;
  };
