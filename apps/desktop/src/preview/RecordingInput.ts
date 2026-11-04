import { classifyProtectedField, type FieldDescriptor } from "@t3tools/shared/protectedFields";

export interface RecordingInputOptions {
  readonly showKeyPresses: boolean;
  readonly showMousePresses: boolean;
}

export const DEFAULT_RECORDING_INPUT_OPTIONS: RecordingInputOptions = {
  showKeyPresses: false,
  showMousePresses: false,
};

export interface RecordingKeyPress {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

export function recordingKeyLabel(input: RecordingKeyPress, isMac: boolean): string | null {
  if (["Dead", "Process", "Unidentified", ""].includes(input.key)) return null;
  const modifiers = [
    input.ctrlKey || input.key === "Control" ? (isMac ? "⌃" : "Ctrl") : null,
    input.altKey || input.key === "Alt" ? (isMac ? "⌥" : "Alt") : null,
    input.shiftKey || input.key === "Shift" ? (isMac ? "⇧" : "Shift") : null,
    input.metaKey || input.key === "Meta" ? (isMac ? "⌘" : "Win") : null,
  ].filter((value) => value !== null);
  const labels: Record<string, string> = {
    Enter: "↵",
    Tab: "⇥",
    Backspace: "⌫",
    Delete: "⌦",
    Escape: "Esc",
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    " ": "Space",
    Space: "Space",
  };
  if (!["Control", "Alt", "Shift", "Meta"].includes(input.key)) {
    modifiers.push(
      labels[input.key] ?? (input.key.length === 1 ? input.key.toUpperCase() : input.key),
    );
  }
  return modifiers.join(isMac ? "" : " + ");
}

const describeField = (element: Element): FieldDescriptor => {
  const labels = (element as Element & { readonly labels?: ArrayLike<Element> | null }).labels;
  const view = element.ownerDocument?.defaultView;
  return {
    tag: element.localName,
    type: (element.getAttribute("type") ?? "").toLowerCase(),
    autocomplete: (element.getAttribute("autocomplete") ?? "").toLowerCase(),
    hints: [
      element.getAttribute("name") ?? "",
      element.id ?? "",
      element.getAttribute("placeholder") ?? "",
      element.getAttribute("aria-label") ?? "",
      element.getAttribute("title") ?? "",
      ...Array.from(labels ?? [], (label) => label.textContent ?? ""),
    ],
    textSecurity: view?.getComputedStyle(element).getPropertyValue("-webkit-text-security") ?? "",
    contentEditable: (element as HTMLElement).isContentEditable === true,
  };
};

/**
 * Keys typed into any sign-in or contact field (password, username, email,
 * phone, one-time code, card) show masked in recordings. Unknown iframe or
 * closed-shadow focus is masked too, because its field cannot be checked.
 */
export function recordingKeysAreSensitive(document: Document): boolean {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  if (!element) return false;
  if (element.tagName === "IFRAME" || element.tagName.includes("-")) return true;
  if (element.getAttribute("type")?.toLowerCase() === "password") return true;
  try {
    return classifyProtectedField(describeField(element)) !== null;
  } catch {
    // When in doubt, show nothing.
    return true;
  }
}
