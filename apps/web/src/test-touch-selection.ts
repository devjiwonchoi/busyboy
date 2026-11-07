/**
 * Phone text selection for browser tests. Headless Chromium cannot long-press to select, so
 * this replays what iOS Safari and Android Chrome send: a touch pointerdown, then
 * pointercancel and contextmenu as the long-press turns into a selection, then only
 * selectionchange while the handles move. No mouseup ever comes.
 */

function locate(root: Node, text: string): { node: Text; offset: number } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const offset = node.nodeValue?.indexOf(text) ?? -1;
    if (offset >= 0) return { node: node as Text, offset };
  }
  throw new Error(`"${text}" is not in the element`);
}

function touch(type: string, target: Element, x: number, y: number) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      isPrimary: true,
      pointerId: 7,
      pointerType: "touch",
      button: type === "pointermove" || type === "pointercancel" ? -1 : 0,
      clientX: x,
      clientY: y,
    }),
  );
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Long-presses `from`, then drags the end handle to the end of `to` (or keeps the word). */
export async function longPressSelect(root: Element, from: string, to: string = from) {
  const start = locate(root, from);
  const end = locate(root, to);
  const word = document.createRange();
  word.setStart(start.node, start.offset);
  word.setEnd(start.node, start.offset + from.length);
  const box = word.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const target = start.node.parentElement!;

  touch("pointerdown", target, x, y);
  await settle(50);
  touch("pointercancel", target, x, y);
  target.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }),
  );
  const selection = window.getSelection()!;
  selection.setBaseAndExtent(start.node, start.offset, start.node, start.offset + from.length);
  await settle(50);
  // The end handle moves in steps, each firing selectionchange.
  const middle = Math.max(start.offset + from.length, end.offset);
  if (end.node !== start.node || middle !== start.offset + from.length) {
    selection.setBaseAndExtent(start.node, start.offset, end.node, middle);
    await settle(50);
  }
  selection.setBaseAndExtent(start.node, start.offset, end.node, end.offset + to.length);
  // The finger lifts off the handle.
  await settle(50);
}

/**
 * Taps an element. The phone clears the text selection as the tap lands, before the click, so
 * this clears it and waits past the selection settle time first.
 */
export async function tap(element: Element) {
  const box = element.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  touch("pointerdown", element, x, y);
  window.getSelection()?.removeAllRanges();
  await settle(400);
  touch("pointerup", element, x, y);
  (element as HTMLElement).click();
}
