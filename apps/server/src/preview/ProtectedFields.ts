import { classifyProtectedField, type FieldDescriptor } from "@t3tools/shared/protectedFields";

export {
  classifyProtectedField,
  isSecretEntryField,
  MIN_SCRUBBED_VALUE_LENGTH,
  scrubProtectedValues,
  type FieldDescriptor,
  type ProtectedFieldReason,
} from "@t3tools/shared/protectedFields";

/**
 * Page script: every value currently held by a protected field in this
 * document (open shadow roots included), raw and normalized like accessible
 * text. Includes fields the page draws as dots.
 */
export const PROTECTED_VALUES_SCRIPT = `(() => {
  const classify = ${classifyProtectedField.toString()};
  const labelText = (element) => {
    const parts = [];
    if (element.labels) for (const label of element.labels) parts.push(label.textContent ?? "");
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      for (const id of labelledBy.split(/\\s+/)) {
        const label = element.ownerDocument.getElementById(id);
        if (label) parts.push(label.textContent ?? "");
      }
    }
    return parts;
  };
  const values = [];
  const visit = (root) => {
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) visit(element.shadowRoot);
      const tag = element.localName;
      const field = tag === "input" || tag === "textarea" || tag === "select";
      if (!field && !element.isContentEditable) continue;
      const reason = classify({
        tag,
        type: (element.getAttribute("type") ?? "").toLowerCase(),
        autocomplete: (element.getAttribute("autocomplete") ?? "").toLowerCase(),
        hints: [
          element.getAttribute("name") ?? "",
          element.id ?? "",
          element.getAttribute("placeholder") ?? "",
          element.getAttribute("aria-label") ?? "",
          element.getAttribute("title") ?? "",
          ...labelText(element),
        ],
        textSecurity: getComputedStyle(element).getPropertyValue("-webkit-text-security"),
        contentEditable: element.isContentEditable === true,
      });
      if (reason === null) continue;
      const raw = [];
      if (tag === "select") {
        for (const option of element.selectedOptions ?? []) raw.push(option.value, option.textContent ?? "");
      } else if (field) {
        raw.push(element.value, element.defaultValue);
      } else {
        raw.push(element.textContent ?? "");
      }
      for (const value of raw)
        values.push(value, value.replace(/[\\u200b\\u00ad]/g, "").trim().replace(/\\s+/g, " "));
    }
  };
  visit(document);
  return [...new Set(values.filter((value) => value.trim()))];
})()`;

/** The parts of a DOM element the page function reads. The server has no DOM types. */
interface PageElement {
  readonly localName: string;
  readonly id: string;
  readonly getAttribute: (name: string) => string | null;
  readonly labels?: ArrayLike<{ readonly textContent: string | null }> | null;
  readonly isContentEditable?: boolean;
}

/** Page function (serializable): describe one element for the classifiers above. */
export const describeFieldInPage = (element: PageElement): FieldDescriptor => {
  const labels: string[] = [];
  for (const label of Array.from(element.labels ?? [])) labels.push(label.textContent ?? "");
  const style = (
    globalThis as unknown as {
      getComputedStyle: (target: PageElement) => { getPropertyValue: (name: string) => string };
    }
  ).getComputedStyle(element);
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
      ...labels,
    ],
    textSecurity: style.getPropertyValue("-webkit-text-security"),
    contentEditable: element.isContentEditable === true,
  };
};

export const SECRET_FIELD_REFUSAL =
  "This is a password or one-time-code field, which agents can't type into. Use preview_sign_in so the user signs in.";
