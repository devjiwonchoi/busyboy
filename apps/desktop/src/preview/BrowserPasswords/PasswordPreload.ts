// @effect-diagnostics globalDate:off globalTimers:off - This isolated Electron preload does not run inside an Effect runtime.
import {
  PASSWORD_CHILD_FRAME_CHANNEL,
  PASSWORD_DROPDOWN_STATE_CHANNEL,
  PASSWORD_FIELD_BLUR_CHANNEL,
  PASSWORD_FIELD_FOCUS_CHANNEL,
  PASSWORD_FIELD_KEY_CHANNEL,
  PASSWORD_FILL_CHANNEL,
  PASSWORD_FORMS_CHANNEL,
  PASSWORD_FRAME_TOKEN_CHANNEL,
  PASSWORD_SUBMIT_CHANNEL,
  PASSWORD_SUBMIT_FORM_CHANNEL,
} from "../GuestProtocol.ts";
import {
  createTokenRegistry,
  createVisibilityCheck,
  detectLoginForms,
  isUsernameLikeField,
  type DetectedLoginForm,
  type DetectionEnvironment,
} from "./LoginFormDetection.ts";
import { MAX_SUBMITTED_VALUE_LENGTH, MAX_TOKEN_LENGTH } from "./PasswordGuestLimits.ts";
import type {
  GuestChildFrame,
  GuestFieldFocus,
  GuestFieldKey,
  GuestFormsReport,
  GuestLoginForm,
  GuestRect,
  GuestSubmit,
  LoginFieldRole,
} from "./PasswordGuestMessages.ts";

/**
 * Login form detection, save capture, and fill for one frame of a guest page.
 *
 * The webview runs with `contextIsolation=false`, so this code shares globals
 * with the page. Everything lives in this closure: nothing is put on `window`,
 * and every DOM call goes through references captured at install time, before
 * page scripts run, so later prototype overrides cannot observe a fill.
 */

export interface PasswordGuestIpc {
  readonly send: (channel: string, payload: unknown) => void;
  readonly on: (channel: string, listener: (payload: unknown) => void) => void;
}

export interface PasswordPreloadOptions {
  readonly window: Window & typeof globalThis;
  readonly ipc: PasswordGuestIpc;
  /** Replaces the layout-based check; jsdom has no layout. */
  readonly isVisible?: (element: Element) => boolean;
}

export interface PasswordPreloadHandle {
  /** Runs a scan now instead of waiting for the debounce. */
  readonly scanNow: () => void;
}

export const FRAME_MESSAGE_TYPE = "busyboy-password-frame";
export const SCAN_DEBOUNCE_MS = 300;
export const GEOMETRY_THROTTLE_MS = 200;
/** A click on the submit button and the `submit` it causes are one submission. */
export const SUBMIT_DEDUPE_MS = 1_000;
const MAX_FIELD_NAME_LENGTH = 256;
const MAX_CLICK_ANCESTORS = 6;
const FORWARDED_KEYS = new Set<GuestFieldKey["key"]>([
  "ArrowDown",
  "ArrowUp",
  "Enter",
  "Escape",
  "Tab",
]);
const WATCHED_ATTRIBUTES = ["type", "autocomplete", "style", "class", "hidden", "disabled", "form"];

interface FieldEntry {
  readonly form: DetectedLoginForm;
  readonly element: HTMLInputElement;
  readonly token: string;
  readonly role: LoginFieldRole;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const finite = (value: number) => (Number.isFinite(value) ? value : 0);

export const installPasswordPreload = (
  options: PasswordPreloadOptions,
): PasswordPreloadHandle | null => {
  const { ipc, window: win } = options;
  const apply = Reflect.apply;
  const stringify = JSON.stringify;
  const parseFloat = Number.parseFloat;
  const dateNow = Date.now;

  const valueDescriptor = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value");
  const getValue = valueDescriptor?.get;
  const setValue = valueDescriptor?.set;
  if (!getValue || !setValue) return null;
  const addEventListener = win.EventTarget.prototype.addEventListener;
  const dispatchEvent = win.EventTarget.prototype.dispatchEvent;
  const preventDefault = win.Event.prototype.preventDefault;
  const stopImmediatePropagation = win.Event.prototype.stopImmediatePropagation;
  const EventCtor = win.Event;
  const InputEventCtor = win.InputEvent ?? win.Event;
  const documentQuerySelectorAll = win.Document.prototype.querySelectorAll;
  const elementQuerySelectorAll = win.Element.prototype.querySelectorAll;
  const getBoundingClientRect = win.Element.prototype.getBoundingClientRect;
  const checkVisibility = win.Element.prototype.checkVisibility as
    | Element["checkVisibility"]
    | undefined;
  const getComputedStyle = win.getComputedStyle;
  const MutationObserverCtor = win.MutationObserver;
  const observe = MutationObserverCtor.prototype.observe;
  const setTimeoutFn = win.setTimeout;
  const cryptoObject = win.crypto;
  const getRandomValues = cryptoObject.getRandomValues;
  const clickElement = win.HTMLElement.prototype.click;
  const requestSubmit = win.HTMLFormElement.prototype.requestSubmit as
    | HTMLFormElement["requestSubmit"]
    | undefined;
  const contentWindowOf = Object.getOwnPropertyDescriptor(
    win.HTMLIFrameElement.prototype,
    "contentWindow",
  )?.get;
  const doc = win.document;
  const parentWindow = win.parent;
  const isChildFrame = parentWindow !== win;

  const now = () => apply(dateNow, Date, []) as number;
  const later = (callback: () => void, delay: number) => {
    apply(setTimeoutFn, win, [callback, delay]);
  };
  const listen = (target: EventTarget, type: string, handler: (event: Event) => void) => {
    apply(addEventListener, target, [type, handler, { capture: true }]);
  };
  const readValue = (input: HTMLInputElement) => apply(getValue, input, []) as string;
  const rectOf = (element: Element): GuestRect => {
    const rect = apply(getBoundingClientRect, element, []) as DOMRect;
    return {
      x: finite(rect.left),
      y: finite(rect.top),
      width: finite(rect.width),
      height: finite(rect.height),
    };
  };

  const tokens = createTokenRegistry(
    (array) => apply(getRandomValues, cryptoObject, [array]) as Uint8Array<ArrayBuffer>,
  );
  const isVisible =
    options.isVisible ??
    createVisibilityCheck({
      getBoundingClientRect: (element) => apply(getBoundingClientRect, element, []) as DOMRect,
      getComputedStyle: (element) => apply(getComputedStyle, win, [element]) as CSSStyleDeclaration,
      ...(checkVisibility
        ? {
            checkVisibility: (element: Element) =>
              apply(checkVisibility, element, [
                { opacityProperty: true, visibilityProperty: true },
              ]) as boolean,
          }
        : {}),
      scrollOffset: () => ({ x: win.scrollX, y: win.scrollY }),
    });
  const env: DetectionEnvironment = {
    isVisible,
    tokenFor: tokens.tokenFor,
    querySelectorAll: (root, selector) =>
      apply(root === doc ? documentQuerySelectorAll : elementQuerySelectorAll, root, [
        selector,
      ]) as NodeListOf<Element>,
  };

  // --- Scanning -------------------------------------------------------------

  let forms: Array<DetectedLoginForm> = [];
  let formsByToken = new Map<string, DetectedLoginForm>();
  let fieldsByElement = new Map<Element, FieldEntry>();
  let formsBySubmitButton = new Map<Element, DetectedLoginForm>();
  let typedUsername: string | undefined;
  // Every document reports once, even with no login forms: after a sign-in in
  // a frame, the next page having none is how main knows it succeeded.
  let lastReportKey: string | null = null;
  let scanPending = false;

  const toGuestForm = (form: DetectedLoginForm): GuestLoginForm => {
    const fields = [
      ...(form.username ? [{ element: form.username, role: "username" as const }] : []),
      ...form.passwords,
    ].map(({ element, role }) => ({
      token: tokens.tokenFor(element),
      role,
      rect: rectOf(element),
    }));
    const fieldName = (input: HTMLInputElement | null | undefined) => {
      const name = input?.getAttribute("name") || input?.getAttribute("id");
      return name ? name.slice(0, MAX_FIELD_NAME_LENGTH) : undefined;
    };
    const usernameFieldName = fieldName(form.username);
    const passwordFieldName = fieldName(form.passwords[0]?.element);
    return {
      token: form.token,
      kind: form.kind,
      fields,
      passwordFilled: form.passwords.some((field) => readValue(field.element).length > 0),
      ...(usernameFieldName ? { usernameFieldName } : {}),
      ...(passwordFieldName ? { passwordFieldName } : {}),
    };
  };

  const scan = () => {
    forms = detectLoginForms(doc, env);
    formsByToken = new Map();
    fieldsByElement = new Map();
    formsBySubmitButton = new Map();
    for (const form of forms) {
      formsByToken.set(form.token, form);
      if (form.submitButton) formsBySubmitButton.set(form.submitButton, form);
      const fields = [
        ...(form.username ? [{ element: form.username, role: "username" as const }] : []),
        ...form.passwords,
      ];
      for (const { element, role } of fields)
        fieldsByElement.set(element, { form, element, token: tokens.tokenFor(element), role });
    }
    const report: GuestFormsReport = {
      forms: forms.map(toGuestForm),
      ...(typedUsername ? { typedUsername } : {}),
    };
    const key = stringify(report);
    if (key === lastReportKey) return;
    lastReportKey = key;
    ipc.send(PASSWORD_FORMS_CHANNEL, report);
  };

  // At most one scan per debounce window, however often the page mutates.
  const scheduleScan = () => {
    if (scanPending) return;
    scanPending = true;
    later(() => {
      scanPending = false;
      scan();
    }, SCAN_DEBOUNCE_MS);
  };

  const fieldFor = (target: EventTarget | null): FieldEntry | undefined => {
    if (!target) return undefined;
    const known = fieldsByElement.get(target as Element);
    if (known) return known;
    // The field may have appeared since the last scan.
    if ((target as Element).localName !== "input") return undefined;
    scan();
    return fieldsByElement.get(target as Element);
  };

  const formFor = (token: string) => {
    if (!formsByToken.has(token)) scan();
    return formsByToken.get(token);
  };

  // --- Submission capture -------------------------------------------------

  const lastCaptureAt = new Map<string, number>();
  const captureSubmission = (form: DetectedLoginForm) => {
    const at = now();
    const previous = lastCaptureAt.get(form.token);
    if (previous !== undefined && at - previous < SUBMIT_DEDUPE_MS) return;
    const current = form.passwords.find((field) => field.role === "currentPassword");
    const fresh = form.passwords.find((field) => field.role === "newPassword");
    const password = current ? readValue(current.element) : "";
    const newPassword = fresh ? readValue(fresh.element) : undefined;
    if (!password && !newPassword) return;
    const username = form.username ? readValue(form.username) : "";
    const tooLong = [username, password, newPassword ?? ""].some(
      (value) => value.length > MAX_SUBMITTED_VALUE_LENGTH,
    );
    if (tooLong) return;
    lastCaptureAt.set(form.token, at);
    const submit: GuestSubmit = {
      formToken: form.token,
      kind: form.kind,
      username,
      password,
      ...(newPassword !== undefined ? { newPassword } : {}),
    };
    ipc.send(PASSWORD_SUBMIT_CHANNEL, submit);
  };

  const formForSubmitControl = (target: EventTarget | null) => {
    let node = target as Element | null;
    for (let depth = 0; node && depth < MAX_CLICK_ANCESTORS; depth += 1) {
      const byButton = formsBySubmitButton.get(node);
      if (byButton) return byButton;
      const control = node as HTMLButtonElement | HTMLInputElement;
      if (
        (node.localName === "button" || node.localName === "input") &&
        control.type === "submit" &&
        control.form
      ) {
        const owner = control.form;
        return forms.find((form) => form.form === owner);
      }
      node = node.parentElement;
    }
    return undefined;
  };

  // --- Focus and keys -----------------------------------------------------

  let focused: FieldEntry | null = null;
  let dropdownOpen = false;

  listen(win, "focusin", (event) => {
    if (!event.isTrusted) return;
    const field = fieldFor(event.target);
    if (!field || !isVisible(field.element)) return;
    focused = field;
    const focus: GuestFieldFocus = {
      formToken: field.form.token,
      fieldToken: field.token,
      rect: rectOf(field.element),
    };
    ipc.send(PASSWORD_FIELD_FOCUS_CHANNEL, focus);
  });

  listen(win, "focusout", (event) => {
    if (!event.isTrusted || !focused || event.target !== focused.element) return;
    ipc.send(PASSWORD_FIELD_BLUR_CHANNEL, {
      formToken: focused.form.token,
      fieldToken: focused.token,
    });
    focused = null;
  });

  listen(win, "keydown", (event) => {
    if (!event.isTrusted) return;
    const key = (event as KeyboardEvent).key as GuestFieldKey["key"];
    if (focused && event.target === focused.element && FORWARDED_KEYS.has(key)) {
      if (key === "ArrowDown" || dropdownOpen) {
        const message: GuestFieldKey = {
          formToken: focused.form.token,
          fieldToken: focused.token,
          key,
        };
        ipc.send(PASSWORD_FIELD_KEY_CHANNEL, message);
      }
      if (dropdownOpen && key !== "Tab") {
        // The list owns these keys while it is open; Enter picks a row, not submit.
        apply(preventDefault, event, []);
        apply(stopImmediatePropagation, event, []);
        return;
      }
    }
    if (key !== "Enter") return;
    const field = fieldFor(event.target);
    if (field && field.role !== "username") captureSubmission(field.form);
  });

  listen(win, "input", (event) => {
    if (!event.isTrusted) return;
    const target = event.target as HTMLInputElement | null;
    if (!target || target.localName !== "input") return;
    const field = fieldsByElement.get(target);
    if (field ? field.role !== "username" : !isUsernameLikeField(target)) {
      if (field) scheduleScan();
      return;
    }
    const value = readValue(target).trim();
    const next =
      value && value.length <= MAX_SUBMITTED_VALUE_LENGTH
        ? value
        : (undefined as string | undefined);
    if (next === typedUsername) return;
    typedUsername = next;
    scheduleScan();
  });

  listen(win, "submit", (event) => {
    if (!event.isTrusted) return;
    const target = event.target;
    let form = forms.find((candidate) => candidate.form === target);
    if (!form) {
      scan();
      form = forms.find((candidate) => candidate.form === target);
    }
    if (form) captureSubmission(form);
  });

  listen(win, "click", (event) => {
    if (!event.isTrusted) return;
    const form = formForSubmitControl(event.target);
    if (form) captureSubmission(form);
  });

  ipc.on(PASSWORD_DROPDOWN_STATE_CHANNEL, (payload) => {
    dropdownOpen = isRecord(payload) && payload.open === true;
  });

  // --- Fill ---------------------------------------------------------------

  const setFieldValue = (input: HTMLInputElement, value: string) => {
    apply(setValue, input, [value]);
    apply(dispatchEvent, input, [
      new InputEventCtor("input", {
        bubbles: true,
        composed: true,
        inputType: "insertReplacementText",
      } as InputEventInit),
    ]);
    apply(dispatchEvent, input, [new EventCtor("change", { bubbles: true })]);
  };

  ipc.on(PASSWORD_FILL_CHANNEL, (payload) => {
    if (!isRecord(payload)) return;
    const { formToken, username, password } = payload;
    if (typeof formToken !== "string" || typeof username !== "string") return;
    if (typeof password !== "string") return;
    const form = formFor(formToken);
    if (!form) return;
    if (form.username && username && isVisible(form.username))
      setFieldValue(form.username, username);
    for (const field of form.passwords) {
      if (field.role === "currentPassword" && isVisible(field.element))
        setFieldValue(field.element, password);
    }
    scheduleScan();
  });

  ipc.on(PASSWORD_SUBMIT_FORM_CHANNEL, (payload) => {
    if (!isRecord(payload) || typeof payload.formToken !== "string") return;
    const form = formFor(payload.formToken);
    if (!form) return;
    if (form.submitButton && isVisible(form.submitButton)) {
      apply(clickElement, form.submitButton, []);
      return;
    }
    if (form.form && requestSubmit) {
      try {
        apply(requestSubmit, form.form, []);
      } catch {
        // The page's own validation refused the submission.
      }
    }
  });

  // --- Frame geometry -----------------------------------------------------

  const frameToken = tokens.nextToken();
  ipc.send(PASSWORD_FRAME_TOKEN_CHANNEL, { token: frameToken });

  if (isChildFrame) {
    // Geometry only: the parent's preload answers with where this frame sits.
    const announce = () => {
      try {
        parentWindow.postMessage({ type: FRAME_MESSAGE_TYPE, token: frameToken }, "*");
      } catch {
        // The parent is gone or detached.
      }
    };
    announce();
    let announcePending = false;
    listen(win, "resize", () => {
      if (announcePending) return;
      announcePending = true;
      later(() => {
        announcePending = false;
        announce();
      }, GEOMETRY_THROTTLE_MS);
    });
    listen(win, "pageshow", announce);
  }

  const childFrames = new Map<string, Element>();
  const lastChildRectKeys = new Map<string, string>();
  const reportChildFrame = (childToken: string, frame: Element) => {
    const outer = apply(getBoundingClientRect, frame, []) as DOMRect;
    const style = apply(getComputedStyle, win, [frame]) as CSSStyleDeclaration;
    const edge = (value: string) => finite(parseFloat(value));
    const left = edge(style.borderLeftWidth) + edge(style.paddingLeft);
    const top = edge(style.borderTopWidth) + edge(style.paddingTop);
    const right = edge(style.borderRightWidth) + edge(style.paddingRight);
    const bottom = edge(style.borderBottomWidth) + edge(style.paddingBottom);
    const rect: GuestRect = {
      x: finite(outer.left + left),
      y: finite(outer.top + top),
      width: Math.max(0, finite(outer.width - left - right)),
      height: Math.max(0, finite(outer.height - top - bottom)),
    };
    const key = stringify(rect);
    if (lastChildRectKeys.get(childToken) === key) return;
    lastChildRectKeys.set(childToken, key);
    const message: GuestChildFrame = { childToken, rect };
    ipc.send(PASSWORD_CHILD_FRAME_CHANNEL, message);
  };

  listen(win, "message", (event) => {
    const message = event as MessageEvent;
    const data: unknown = message.data;
    if (!isRecord(data) || data.type !== FRAME_MESSAGE_TYPE) return;
    const childToken = data.token;
    if (typeof childToken !== "string" || !childToken || childToken.length > MAX_TOKEN_LENGTH)
      return;
    apply(stopImmediatePropagation, event, []);
    if (!contentWindowOf) return;
    const source = message.source;
    const frames = apply(documentQuerySelectorAll, doc, ["iframe"]) as NodeListOf<Element>;
    for (const frame of Array.from(frames)) {
      if (apply(contentWindowOf, frame, []) !== source) continue;
      // A navigated child announces a new token; forget the old one.
      for (const [token, known] of childFrames) {
        if (known === frame && token !== childToken) {
          childFrames.delete(token);
          lastChildRectKeys.delete(token);
        }
      }
      childFrames.set(childToken, frame);
      lastChildRectKeys.delete(childToken);
      reportChildFrame(childToken, frame);
      return;
    }
  });

  let geometryPending = false;
  const scheduleChildGeometry = () => {
    if (geometryPending || childFrames.size === 0) return;
    geometryPending = true;
    later(() => {
      geometryPending = false;
      for (const [token, frame] of childFrames) {
        if (!frame.isConnected) {
          childFrames.delete(token);
          lastChildRectKeys.delete(token);
          continue;
        }
        reportChildFrame(token, frame);
      }
    }, GEOMETRY_THROTTLE_MS);
  };
  listen(win, "scroll", scheduleChildGeometry);
  listen(win, "resize", scheduleChildGeometry);

  // --- Lifecycle ----------------------------------------------------------

  const observer = new MutationObserverCtor(scheduleScan);
  apply(observe, observer, [
    doc,
    { childList: true, subtree: true, attributes: true, attributeFilter: WATCHED_ATTRIBUTES },
  ]);
  listen(doc, "DOMContentLoaded", scan);
  listen(win, "load", scan);
  listen(win, "pageshow", scan);
  if (doc.readyState !== "loading") scheduleScan();

  return { scanNow: scan };
};
