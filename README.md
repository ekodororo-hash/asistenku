# Asistenku (Gemini + Vercel + Telegram)

Asisten pribadi berbahasa Indonesia, multi-pengguna: web chat (bisa dipasang sebagai PWA), tugas, catatan,
pengeluaran & pemasukan, pengingat, cuaca, berita, mode curhat, dan bot Telegram dengan pesan otomatis.
Tiap akun punya data, API key Gemini, dan bot Telegram sendiri.

## Fitur
- **Chat asisten** dengan Gemini; bisa membuat tugas, catatan, pengingat, dan catatan uang dari obrolan biasa.
- **Panel web:** Tugas, Catatan, Pengingat, Uang, Info (cuaca + berita berfoto).
- **Uang:** pengeluaran per kategori, pemasukan, saldo, rekap; foto struk dibaca lewat Telegram.
- **Pengingat** sekali jalan dan berulang (harian, mingguan, dst).
- **Mochi:** peliharaan virtual yang tumbuh kalau kamu aktif. Misi harian (selesaikan 2 tugas, catat uang, cerita harimu), XP dan level, streak dengan jatah libur, mata mengikuti kursor, bereaksi saat diketuk, efek suara. Data satu untuk web dan Telegram (`/mochi`), pengingat sore lewat cron.
- **Mode curhat** terpisah dari asisten (riwayat sendiri, tidak mencatat apa pun).
- **Bot Telegram** per pengguna: teks, foto, voice note, tombol, perintah `/...`.
- **Pesan otomatis:** ringkasan pagi, check-in malam, rekap mingguan (lewat cron).
- **Hubungkan:** kiriman uang antar pasangan tidak tercatat dobel.
- **Tampilan:** mode warna, warna aksen, wallpaper chat (termasuk foto sendiri), gaya bubble.
- **PWA:** bisa dipasang di layar utama HP.

## Struktur
```
index.html        web utama: login/daftar, chat, panel Tugas/Catatan/Pengingat/Uang/Info
settings.html     Pengaturan: Profil, Tampilan, API key Gemini, Bot Telegram, Hubungkan, Akun
riwayat.html      riwayat pemakaian API key (dengan filter status)
theme.css         gaya dasar bersama
theme.js          mode warna, aksen, wallpaper, bubble (disimpan per perangkat di localStorage)
pw.js             bantuan input password (ikon mata, bar kekuatan, contoh password kuat)
sw.js             service worker minimal (tanpa cache) agar bisa dipasang sebagai PWA
manifest.json     manifest PWA
icon-192.png, icon-512.png, apple-touch-icon.png
vercel.json       durasi maksimum fungsi (telegram & cron 60 dtk, chat & auth 30, state 15)
api/_lib.js       inti bersama: Redis, Gemini (rotasi key/model), Telegram, waktu, prompt, uang, dll.
api/_auth.js      password (scrypt), cookie sesi bertanda tangan, rate limit
api/auth.js       daftar, login, ganti password, logout
api/state.js      state awal & aksi panel web, pengaturan, key, bot, Hubungkan
api/chat.js       chat web -> Gemini
api/info.js       cuaca (Open-Meteo) dan berita (RSS media / Google News)
api/telegram.js   webhook bot Telegram (per pengguna: /api/telegram?u=<userId>)
api/cron.js       pengingat, ringkasan pagi, check-in malam, rekap mingguan
TELEGRAM.md       panduan setup bot Telegram, perintah, dan mode curhat
```

## Deploy (sekali oleh pemilik server)
1. Upload semua file ke repo GitHub (folder `api/` harus tetap ada).
2. vercel.com > Add New > Project > import repo > Deploy.
3. Pasang database: project > Storage / Marketplace > **Upstash Redis** > Connect.
   `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (atau `KV_REST_API_URL` / `KV_REST_API_TOKEN`) terisi otomatis.
4. Isi Environment Variables (tabel di bawah), lalu **Redeploy**.
5. Untuk bot Telegram dan pengingat otomatis, ikuti `TELEGRAM.md` (termasuk cron-job.org tiap 1 menit).

### Environment Variables
| Nama | Wajib | Isi |
|---|---|---|
| `SESSION_SECRET` | ya | acak, min. 16 karakter. Menandatangani cookie login dan mengenkripsi key/token. **Jangan diganti** setelah ada data tersimpan, atau key dan token harus dimasukkan ulang |
| `INVITE_CODE` | ya | kode rahasia untuk mendaftar (bagikan ke teman/keluarga) |
| `CRON_SECRET` | untuk Telegram | karangan sendiri, panjang dan acak; dipakai di URL cron |
| `OWNER_USERNAME` | opsional | username pemilik data lama. Data global lama dipindah ke akun ini saat dia daftar. Kosong = akun pertama yang daftar jadi pemilik |
| `GEMINI_API_KEY` | opsional | cadangan terakhir kalau key pengguna habis/kosong |
| `GEMINI_MODEL` | opsional | nama model bawaan, default `gemini-flash-latest` (tiap pengguna bisa memilih sendiri di Pengaturan) |
| `GEMINI_SEARCH` | opsional | isi `on` untuk mengaktifkan pencarian Google. Bawaan mati karena paket gratis Google tidak menyediakannya untuk model Gemini 3; nyalakan hanya kalau key sudah berbilling |
| `MORNING_HOUR` / `CHECKIN_HOUR` / `RECAP_HOUR` | opsional | jam WIB ringkasan pagi (7), check-in malam (21), rekap mingguan Minggu (20) |
| `WEATHER_CITY` / `WEATHER_LAT` / `WEATHER_LON` | opsional | kota bawaan cuaca (default Jakarta) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET` | tidak | hanya untuk bot lama milik pemilik, sampai dia memasang bot sendiri di Pengaturan; setelah itu boleh dihapus |

`WEB_PIN` sudah tidak dipakai dan boleh dihapus.

## Akun
Login memakai username + password (username: huruf kecil, angka, `_`, 3-20 karakter). Pendaftaran butuh `INVITE_CODE`.
Password di-hash dengan scrypt; sesi berupa cookie bertanda tangan (30 hari). Password bisa diganti di Pengaturan > Akun.

## API key Gemini
Tiap akun bisa menambah maks. 5 API key di Pengaturan. Urutan pakai: key 1 → 5 → `GEMINI_API_KEY` global (cadangan).
Key disimpan terenkripsi (AES-256-GCM, kunci turunan `SESSION_SECRET`).

- Key yang kena limit (429) dilewati 60 detik; key tidak valid dilewati 1 jam lalu dicoba sekali lagi.
- Tiap key punya nama (opsional), status (Belum digunakan, Berfungsi, Kena limit, Tidak valid, Error), waktu terakhir digunakan,
  jumlah pemakaian berhasil "hari ini" menurut hari kuota Google (tengah malam waktu Pasifik), dan tombol **Test** (jeda 5 detik per key).
- Bisa memilih **model utama** dan **model cadangan**; cadangan dipakai bila model utama kena limit di semua key atau tidak ditemukan.
- Batas Google berlaku per project, bukan per key.
- **Riwayat pemakaian** (`/riwayat.html`): waktu, key (4 karakter terakhir), sumber (Web/Telegram/Otomatis/Test), hasil. Isi pesan tidak disimpan.
  Entri lebih tua dari 1 hari dan sisa di atas 50 entri dihapus saat ada entri baru (tanpa cron).

## Bot Telegram per pengguna
Tiap akun memasang bot sendiri di Pengaturan > Bot Telegram: tempel token dari @BotFather, server memvalidasi (`getMe`) dan
mendaftarkan webhook otomatis ke `/api/telegram?u=<userId>` dengan secret unik. Chat dikunci lewat tautan
`t.me/<bot>?start=<kode>` yang muncul di Pengaturan, supaya orang yang menemukan bot tidak bisa merebutnya. Token disimpan terenkripsi.

Cron (`/api/cron`) berjalan untuk semua pengguna yang bot-nya sudah terhubung, memakai bot dan API key masing-masing.
Langkah lengkap, daftar perintah, dan cara kerja mode curhat ada di `TELEGRAM.md`.

## Mode curhat
Asisten dan curhat punya riwayat obrolan sendiri. Curhat tidak membuat tugas/catatan/pengingat/uang, tidak menyimpan memori,
tidak memakai pencarian, dan tidak disalin ke Telegram. Keluar dari curhat menampilkan pilihan Hapus / Simpan dulu / Tetap curhat;
riwayat curhat yang tidak disimpan terhapus sendiri setelah 6 jam tanpa dipakai (`CURHAT_TTL` di `api/_lib.js`).

## Hubungkan (kiriman uang antar pasangan)
Dua akun bisa saling terhubung (Pengaturan > Hubungkan) khusus untuk kiriman uang, supaya "kasih istri 5jt" di satu akun dan
"dapet 5jt dari suami" di akun lain tidak tercatat dobel. Tugas, catatan, pengeluaran harian, dan obrolan tetap terpisah.

- **Menghubungkan:** satu pihak menekan **Buat kode** (6 karakter, sekali pakai, berlaku 10 menit), pihak lain memasukkannya di
  **Punya kode?** lalu **Hubungkan**. Salah satu bisa **Putuskan** kapan saja. Satu akun hanya bisa punya satu pasangan.
- **Kirim:** dicatat sebagai pengeluaran pengirim (kategori `transfer`). Penerima mendapat kabar di Telegram dengan tombol
  **Catat / Tidak** (tanpa bot: kartu konfirmasi di tab Uang dan di Pengaturan > Hubungkan). Pemasukan baru masuk setelah dikonfirmasi.
- **Terima:** kalau penerima mengetik sendiri "dapet 5jt dari suami" dan kiriman masih menunggu konfirmasi, dicatat satu kali.
  Kalau sudah tercatat (nominal sama, pasangan sama, dalam 3 hari), bot bertanya "mau tambah lagi sebagai pemasukan terpisah?".

## Tag Gemini
Gemini menandai aksi dengan tag yang diproses server lalu dibuang dari balasan:
`[[TASK]]`, `[[REMIND]]`, `[[CATAT]]`, `[[INGAT]]`, `[[BELI]]`, `[[MASUK]]`, `[[SALDO]]`, `[[SALDO_LAIN]]`, `[[HAPUS_PENGINGAT]]`,
dan (hanya jika akun terhubung) `[[KIRIM]]`, `[[PASANGAN_MASUK]]`. Di mode curhat semua tag ini tidak diproses.

## Data di Redis
Semua kunci per pengguna diawali `u:<id>:`.

| Kunci | Isi |
|---|---|
| `tasks`, `notes`, `reminders`, `profile`, `loc`, `facts`, `cfg` | data utama dan pengaturan |
| `hist`, `hist:curhat` | riwayat obrolan asisten / curhat (curhat ber-TTL) |
| `mode`, `curhatkeep`, `exitcurhat` | mode aktif, penanda "Simpan dulu", pertanyaan keluar curhat (5 menit) |
| `exp:<YYYY-MM>`, `inc:<YYYY-MM>`, `saldo` | pengeluaran, pemasukan, saldo |
| `gkeys`, `gstat`, `ghist` | key Gemini terenkripsi, status per key, riwayat pemakaian |
| `bot` | token bot terenkripsi dan status chat |
| `link`, `linkcode`, `xferin`, `dupmasuk` | Hubungkan; global: `linkcode:<kode>` (10 menit), `xfer:<id>` (7 hari) |

## PWA
Android (Chrome): menu ⋮ > Instal aplikasi / Tambahkan ke layar utama. iPhone (Safari): Bagikan > Tambahkan ke Layar Utama.
`sw.js` sengaja tidak menyimpan cache, jadi data dan login selalu terbaru.

## Coba lokal
```
npm i -g vercel
vercel dev
```
Buat `.env` berisi minimal `SESSION_SECRET`, `INVITE_CODE`, dan kredensial Redis (jangan di-commit; `.env` sudah ada di `.gitignore`).

## Catatan
- Paket gratis Gemini punya batas permintaan; kalau error 429, tunggu sebentar atau tambah key.
- Error "model not found": pilih model lain di Pengaturan atau isi `GEMINI_MODEL`.
- Cuaca (Open-Meteo) dan berita (RSS) tanpa API key; layanan gratis bisa berubah sewaktu-waktu.
- Jangan membagikan API key, token bot, dan akun Upstash.
