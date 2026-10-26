// Mobile browsers (iOS Home Screen apps, Android Chrome) can only show
// notifications through a service worker. This one opens the thread when a
// notification is tapped. It has no fetch handler, so it never intercepts requests.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url ?? "/", self.location.origin).href;

  // Reuse the open window so the app routes in place; otherwise open the thread.
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
      const open = windows[0];
      if (open === undefined) {
        await self.clients.openWindow(url);
        return;
      }
      await open.focus();
      open.postMessage({ type: "busyboy:open-url", url });
    }),
  );
});
