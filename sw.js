// Service worker minimal: syarat agar aplikasi bisa dipasang di layar utama.
// Sengaja TIDAK menyimpan cache apa pun, supaya login, data, dan versi terbaru selalu dari server.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
