export function isPreviewFocused(): boolean {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return false;
  if (!activeElement.isConnected) return false;
  if (activeElement.tagName.toLowerCase() === "webview") return true;
  // A side chat shares the right panel but is a chat, not a preview.
  if (activeElement.closest("[data-side-chat]") !== null) return false;
  return activeElement.closest("[data-preview-panel-mode]") !== null;
}
