// Electron keeps its custom document origin, so Next HMR must use the HTTP server.
export function getSocketUrl() {
  const origin = new URL(import.meta.env.VITE_DEV_SERVER_URL || window.location.href);
  origin.protocol = origin.protocol === "http:" ? "ws:" : "wss:";
  return origin.origin;
}
