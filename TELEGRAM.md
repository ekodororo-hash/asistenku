# Setup Bot Telegram

File yang dipakai: `api/_lib.js`, `api/_auth.js`, `api/auth.js`, `api/state.js`, `api/telegram.js`, `api/cron.js`, dan `vercel.json` (di folder utama).
`vercel.json` penting: memberi fungsi waktu 60 detik (foto dan voice note butuh lebih dari 10 detik bawaan).

## 1. Buat bot (tiap pengguna bikin sendiri)
1. Di Telegram buka @BotFather, kirim `/newbot`, ikuti langkahnya.
2. Simpan **token** yang diberikan. Jangan dibagikan ke siapa pun.

## 2. Siapkan database (gratis, sekali oleh pemilik server)
Semua data disimpan di Redis.
- Vercel: project > Storage / Marketplace > **Upstash Redis** > Connect ke project.
  Env `UPSTASH_REDIS_REST_URL` dan `UPSTASH_REDIS_REST_TOKEN` (atau `KV_REST_API_URL` / `KV_REST_API_TOKEN`) terisi otomatis.

## 3. Environment Variables di Vercel (pemilik server)
| Nama | Isi |
|---|---|
| `INVITE_CODE` | kode rahasia untuk daftar, dibagikan ke teman/keluarga |
| `SESSION_SECRET` | acak, min. 16 karakter (tanda tangan cookie + enkripsi key/token). Jangan diganti setelah dipakai |
| `OWNER_USERNAME` | username pemilik data lama (opsional) |
| `CRON_SECRET` | karangan sendiri, panjang dan acak |
| `GEMINI_API_KEY` | opsional, cadangan terakhir kalau key pengguna habis/kosong |
| `MORNING_HOUR` | opsional, jam ringkasan pagi WIB (bawaan 7) |
| `CHECKIN_HOUR` | opsional, jam check-in malam WIB (bawaan 21) |
| `RECAP_HOUR` | opsional, jam rekap mingguan Minggu WIB (bawaan 20) |

Lalu **Redeploy**.
(`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET` lama hanya dipakai sampai pemilik memasang bot sendiri di Pengaturan, lalu boleh dihapus. `WEB_PIN` tidak dipakai lagi.)

## 4. Pasang bot (tiap pengguna, di web)
1. Daftar / masuk di web.
2. Buka **Pengaturan > Bot Telegram**, tempel token, klik **Pasang**. Webhook terdaftar otomatis, tidak perlu setWebhook manual.
3. Klik tautan **Hubungkan Telegram**, lalu tekan Start di Telegram. Bot terkunci ke chat itu dan tombol permanen muncul.
4. Ganti akun Telegram: **Ganti chat Telegram** di Pengaturan.

## 5. Pengecek tiap menit (pemilik server, sekali)
Cron bawaan Vercel gratis hanya sekali sehari, jadi pakai cron-job.org:
1. Daftar di cron-job.org.
2. Buat cron baru, URL: `https://<APP>.vercel.app/api/cron?key=<CRON_SECRET>`
3. Jadwal: setiap 1 menit. Kalau ada pilihan timeout, set 60 detik.

Cron ini mengirim pengingat, ringkasan pagi, check-in malam, dan rekap mingguan untuk semua pengguna yang bot-nya sudah terhubung.

## Fitur dan cara pakai
| Fitur | Cara |
|---|---|
| Pengingat | "Ingatkan aku besok jam 8 bayar listrik" |
| Pengingat berulang | "Ingatkan tiap Senin jam 9 rapat", "tiap hari jam 9 minum obat" |
| Lihat / hapus pengingat | `/pengingat`, `/hapus <nomor>` |
| Pengeluaran | "makan siang 25rb", atau kirim foto struk |
| Rekap | tombol Rekap atau `/rekap`; `/hapusbeli` hapus entri terakhir |
| Catatan | "catat: ide konten X", `/catatan`, `/cari kata`, `/hapuscatatan <nomor>` |
| Foto | kirim foto, boleh dengan keterangan |
| Voice note | kirim pesan suara, bot mentranskrip lalu menjawab |
| Cuaca | tombol Cuaca; `/lokasi <kota>` mengganti kota |
| Berita | tombol Berita atau `/berita topik` |
| Curhat | tombol Mode Curhat atau `/curhat`; keluar dengan Mode Asisten atau `/asisten` (ditanya dulu: Hapus & keluar / Simpan dulu / Tetap curhat). Lihat bagian Mode curhat di bawah |
| Ingatan | `/memori` melihat, `/lupakan` menghapus, `/reset` hapus riwayat obrolan mode yang sedang aktif (asisten atau curhat, tidak keduanya) |
| Otomatis | `/atur` melihat status; `/pagi`, `/checkin`, `/rekapauto`, `/salin` diikuti `on` atau `off` |
| Salin obrolan web | Pesan dan balasan dari web ikut dikirim ke Telegram (bawaan aktif). Matikan: `/salin off` |

## Catatan
- Pesan otomatis dikirim paling lambat sekitar 1 menit dari waktunya. Jika cron sempat mati, ringkasan pagi masih dikirim selama masih dalam 3 jam sejak jamnya.
- Tugas, catatan, uang, dan obrolan mode asisten di bot sama persis dengan di web (satu akun, satu data di Redis). Obrolan curhat punya riwayat sendiri (lihat di bawah).
- Cuaca memakai Open-Meteo dan berita memakai RSS Google News, keduanya tanpa API key. Layanan gratis seperti ini bisa berubah sewaktu-waktu.
- Setiap foto atau voice note memakai kuota Gemini gratis (voice note memakai dua panggilan). Kalau muncul error 429, tunggu sebentar.
- Semua pesan dan data tersimpan di Redis milikmu. Jaga token bot dan akun Upstash.

## Mode curhat (dipisah dari asisten)
- **Riwayat terpisah.** Asisten dan curhat punya riwayat sendiri (`u:<id>:hist` dan `u:<id>:hist:curhat`). Saat curhat, Gemini hanya melihat obrolan curhat; saat asisten, hanya obrolan asisten. Prompt curhat juga tidak memuat tugas, catatan, pengingat, atau data uang.
- **Tidak ada pencatatan otomatis.** Di mode curhat tag tugas, pengingat, catatan, uang, dan memori (`INGAT`) tidak diproses, `catat: ...` diperlakukan sebagai obrolan biasa, dan pencarian Google tidak dipakai. Memori yang sudah ada hanya dibaca, tidak pernah ditulis dari curhat.
- **Tidak disalin ke Telegram.** Pesan curhat dari web tidak ikut disalin ke Telegram, apa pun pengaturan `/salin`.
- **Keluar dari curhat ditanya dulu.** `/asisten` (atau tombol Mode Asisten, atau tombol Asisten di web) menampilkan pilihan: *Hapus & keluar* (riwayat curhat dihapus permanen), *Simpan dulu* (keluar, riwayat tetap tersimpan sampai kamu hapus sendiri), atau *Tetap curhat*. Kalau riwayat curhat kosong, langsung pindah tanpa bertanya.
- **Jaring pengaman.** Riwayat curhat yang tidak disimpan terhapus sendiri setelah 6 jam tanpa dipakai (`CURHAT_TTL` di `api/_lib.js`), dan mode ikut kembali ke asisten. Riwayat yang dipilih "Simpan dulu" tidak kedaluwarsa, tapi modenya tetap kembali ke asisten kalau lama tidak dipakai.
- **Hapus manual.** `/reset` (atau tombol Chat baru di web) hanya menghapus riwayat mode yang sedang aktif.
- **Check-in malam** memakai prompt curhat tanpa data tugas/catatan/uang; ringkasan pagi selalu masuk ke riwayat asisten.
