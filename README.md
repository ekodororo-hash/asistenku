# Asisten Pribadi (Gemini + Vercel + Telegram)

Asisten pribadi berbahasa Indonesia: web chat, daftar tugas, catatan, pengeluaran, cuaca, berita,
mode curhat, dan bot Telegram dengan pengingat otomatis.

## Struktur
```
index.html        web (chat + panel Tugas/Catatan/Uang/Info), ramah HP
vercel.json       memberi fungsi waktu 60 detik
api/chat.js       chat web -> Gemini
api/info.js       cuaca (Open-Meteo) dan berita (Google News RSS)
api/telegram.js   webhook bot Telegram
api/cron.js       pengingat, ringkasan pagi, check-in malam, rekap mingguan
api/_lib.js       fungsi bantu bersama (Redis, Telegram, Gemini, waktu)
TELEGRAM.md       langkah setup bot Telegram
```

## Deploy web (5 menit)
1. Upload semua file ke repo GitHub (folder `api/` harus tetap ada).
2. vercel.com > Add New > Project > import repo > Deploy.
3. Settings > Environment Variables:
   - `GEMINI_API_KEY` = key dari Google AI Studio
   - `GEMINI_MODEL`   = (opsional) nama model persis dari AI Studio, bawaan `gemini-flash-latest`
4. Redeploy. Web sudah jalan.

## Bot Telegram (opsional)
Ikuti `TELEGRAM.md`. Butuh tambahan: bot dari @BotFather, Upstash Redis (gratis), dan cron-job.org.

## Coba lokal
```
npm i -g vercel
vercel dev
```
Buat `.env` berisi `GEMINI_API_KEY=isi_key_kamu` (jangan di-commit).

## Catatan
- Paket gratis Gemini punya batas permintaan; kalau error 429, tunggu sebentar.
- Error "model not found": isi `GEMINI_MODEL` dengan nama model yang benar.
- Jangan membagikan API key, token bot, dan akun Upstash.

## Akun (Tahap 1)

Login memakai username + password; pendaftaran butuh kode undangan. Env var di Vercel:

- `INVITE_CODE` — kode rahasia untuk daftar (bagikan ke teman/keluarga)
- `SESSION_SECRET` — string acak min. 16 karakter untuk menandatangani cookie login
- `OWNER_USERNAME` — (opsional) username pemilik data lama. Data global yang sudah ada otomatis dipindah ke akun ini saat dia daftar. Kalau kosong, akun pertama yang daftar jadi pemilik.
- `WEB_PIN` tidak dipakai lagi (boleh dihapus).

Sementara (sampai Tahap 3), bot Telegram dan cron masih memakai `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, dan `GEMINI_API_KEY` global, dan melayani akun pemilik saja.

## API key Gemini (Tahap 2)

Tiap akun bisa menambah maks. 5 API key di Pengaturan. Urutan pakai: key 1 → 5 → `GEMINI_API_KEY` global (cadangan). Key yang kena limit (429) dilewati 60 detik. Key disimpan terenkripsi (AES-256-GCM, kunci turunan `SESSION_SECRET`) — jangan ganti `SESSION_SECRET` setelah ada key tersimpan, atau key harus dimasukkan ulang.

## Bot Telegram per pengguna (Tahap 3)

Tiap akun memasang bot sendiri di Pengaturan: tempel token dari @BotFather, server memvalidasi (`getMe`) dan mendaftarkan webhook otomatis ke `/api/<telegram>?u=<userId>` dengan secret unik. Chat dikunci lewat tautan `t.me/<bot>?start=<kode>` yang muncul di Pengaturan (bukan "siapa saja yang chat duluan", supaya orang yang menemukan bot tidak bisa merebutnya). Token disimpan terenkripsi.

Cron (`/api/cron`) sekarang berjalan untuk semua pengguna yang bot-nya sudah terhubung, memakai bot dan API key Gemini masing-masing.

Env `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET` hanya dipakai sebagai bot lama pemilik sampai dia memasang bot sendiri; setelah itu boleh dihapus. Yang tetap dipakai: `CRON_SECRET`, `INVITE_CODE`, `SESSION_SECRET`, `OWNER_USERNAME`, dan (opsional) `GEMINI_API_KEY`.

## Status key & riwayat pemakaian

Tiap key di Pengaturan punya nama (opsional, bisa diganti lewat ✎ Nama), status (Belum digunakan, Berfungsi, Kena limit, Tidak valid, Error), waktu "terakhir digunakan", dan tombol **Test** (permintaan kecil sungguhan, jeda 5 detik per key). Riwayat pemakaian mencatat waktu, key (4 karakter terakhir), sumber (Web/Telegram/Otomatis/Test), dan hasil. Isi pesan tidak disimpan.

Riwayat dihapus saat menulis: setiap entri baru memicu penghapusan entri lebih tua dari 1 hari dan sisa di atas 50 entri (tanpa cron). Key bertanda tidak valid dilewati 1 jam saat rotasi (lalu dicoba lagi sekali), dan tiap key menampilkan jumlah pemakaian berhasil "hari ini" menurut hari kuota Google (tengah malam waktu Pasifik). Di Pengaturan bisa dipilih model utama dan model cadangan; model cadangan dipakai bila model utama kena limit di semua key atau tidak ditemukan. Batas Google berlaku per project, bukan per key.

Riwayat dilihat di halaman terpisah `/riwayat.html` (tautannya di bawah daftar key di Pengaturan), lengkap dengan filter status. Data di Redis: `u:<id>:gstat` (status per key) dan `u:<id>:ghist` (riwayat).

## Mode curhat terpisah

Asisten dan curhat punya riwayat obrolan sendiri; curhat tidak membuat tugas/catatan/pengingat/uang, tidak menyimpan memori, tidak memakai pencarian, dan tidak disalin ke Telegram. Keluar dari curhat menampilkan pilihan Hapus / Simpan dulu / Tetap curhat, dan riwayat curhat yang tidak disimpan terhapus sendiri setelah 6 jam tanpa dipakai. Detail di `TELEGRAM.md` (bagian Mode curhat).

Data di Redis: `u:<id>:hist` (asisten), `u:<id>:hist:curhat` (curhat, ber-TTL), `u:<id>:curhatkeep` (penanda "Simpan dulu"), `u:<id>:exitcurhat` (pertanyaan keluar curhat yang menunggu jawaban, 5 menit). Riwayat lama (`u:<id>:hist`) otomatis dianggap milik mode asisten.

## Pasang di layar utama HP (PWA)

Buka web di HP, lalu: Android (Chrome) menu ⋮ > Instal aplikasi / Tambahkan ke layar utama; iPhone (Safari) tombol Bagikan > Tambahkan ke Layar Utama. Aplikasi terbuka tanpa bar browser. `sw.js` sengaja tidak menyimpan cache, jadi data dan login tetap selalu terbaru; `manifest.json` dan ikon (`icon-192.png`, `icon-512.png`, `apple-touch-icon.png`) ada di root.
