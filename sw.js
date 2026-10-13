// Service worker: syarat agar aplikasi bisa dipasang di layar utama, plus notifikasi push untuk pengingat.
// Sengaja TIDAK menyimpan cache apa pun, supaya login, data, dan versi terbaru selalu dari server.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});

// Push dari server: { title, body, tag, nagId, urgent }
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch {}
  const opts = {
    body: d.body || "",
    tag: d.tag || undefined,      // tag sama = menggantikan notifikasi sebelumnya (ulangan tidak menumpuk)
    renotify: !!d.tag,            // tapi tetap bunyi/getar lagi
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    requireInteraction: !!d.urgent,
    vibrate: d.urgent ? [200, 100, 200, 100, 200] : undefined,
    data: { nagId: d.nagId || null },
  };
  if (d.nagId) opts.actions = [{ action: "ok", title: "Sudah" }, { action: "snz", title: "Tunda 10 mnt" }];
  e.waitUntil(self.registration.showNotification(d.title || "Asistenku", opts));
});

// Ketuk tombol Sudah / Tunda di notifikasi: kabari server (cookie login ikut terkirim). Ketuk biasa: buka aplikasi.
self.addEventListener("notificationclick", (e) => {
  const n = e.notification, d = n.data || {};
  n.close();
  if ((e.action === "ok" || e.action === "snz") && d.nagId) {
    e.waitUntil(fetch("/api/state", {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "nagAck", id: d.nagId, act: e.action }),
    }).catch(() => {}));
    return;
  }
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) if ("focus" in c) return c.focus();
    return self.clients.openWindow("/");
  }));
});
