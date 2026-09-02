/* Home Manager — push-only service worker.
 *
 * This file deliberately does NOT cache anything and does NOT intercept
 * page requests. There is no `fetch` handler below, which means every page
 * load still goes straight to the network exactly as it did before.
 * A deploy can therefore never be masked by a stale cached copy.
 *
 * Its only job is to receive a push message and show it.
 */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("push", event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch { d = {}; }

  const title = d.title || "Home Manager";
  const body  = d.body  || "";

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "./icon-192.png",
      badge: "./icon-192.png",
      dir: "rtl",
      lang: "he",
      tag: d.tag || "home-manager",   // same tag replaces, never stacks up
      renotify: true,
      data: { url: d.url || "./" }
    })
  );
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "./";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      // Focus an already-open window rather than opening a second one
      for (const c of list) {
        if ("focus" in c) return c.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
