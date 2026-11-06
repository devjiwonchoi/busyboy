/**
 * The previewed page's half of the element picker. react-grab reads React's internals, which
 * exist only in the page's own JavaScript world, while the picker preload runs isolated from
 * the page. scripts/build-preview-main-world.mjs bundles this file into one self-contained
 * function (PreviewMainWorld.generated.ts) that the preload installs in the page's world at
 * document start, so react-grab's DevTools hook is in place before React loads.
 *
 * Everything returned here comes from the page and is untrusted; the preload checks its shape.
 */
import { getElementContext } from "react-grab/primitives";

import { PREVIEW_ELEMENT_CONTEXT_KEY } from "./GuestProtocol.ts";

const optionalString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;
const optionalNumber = (value: unknown): number | null =>
  typeof value === "number" ? value : null;

const readElementContext = async (element: unknown) => {
  if (!(element instanceof Element)) return null;
  const context = await getElementContext(element);
  return {
    selector: optionalString(context.selector),
    htmlPreview: optionalString(context.htmlPreview) ?? "",
    componentName: optionalString(context.componentName),
    styles: optionalString(context.styles) ?? "",
    stack: (context.stack ?? []).map((frame) => ({
      functionName: optionalString(frame.functionName),
      fileName: optionalString(frame.fileName),
      lineNumber: optionalNumber(frame.lineNumber),
      columnNumber: optionalNumber(frame.columnNumber),
    })),
  };
};

Object.defineProperty(globalThis, Symbol.for(PREVIEW_ELEMENT_CONTEXT_KEY), {
  value: readElementContext,
  configurable: false,
  enumerable: false,
  writable: false,
});
