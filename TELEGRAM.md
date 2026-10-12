# Setup Bot Telegram

File yang dipakai: `api/_lib.js`, `api/telegram.js`, `api/cron.js`, dan `vercel.json` (di folder utama).
`vercel.json` penting: memberi fungsi waktu 60 detik (foto dan voice note butuh lebih dari 10 detik bawaan).

## 1. Buat bot
1. Di Telegram buka @BotFather, kirim `/newbot`, ikuti langkahnya.
2. Simpan **token** yang diberikan. Jangan dibagikan ke siapa pun.

## 2. Siapkan database (gratis)
Pengingat, catatan, pengeluaran, dan ingatan disimpan di Redis.
- Vercel: project > Storage / Marketplace > **Upstash Redis** > Connect ke project.
  Env `UPSTASH_REDIS_REST_URL` dan `UPSTASH_REDIS_REST_TOKEN` (atau `KV_REST_API_URL` / `KV_REST_API_TOKEN`) terisi otomatis.
- Atau buat di upstash.com, lalu salin REST URL dan token ke env manual.

## 3. Environment Variables di Vercel
| Nama | Isi |
|---|---|
| `GEMINI_API_KEY` | sudah ada |
| `TELEGRAM_BOT_TOKEN` | token dari BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | karangan sendiri: huruf, angka, `_` atau `-` |
| `CRON_SECRET` | karangan sendiri, panjang dan acak |
| `TELEGRAM_CHAT_ID` | diisi di langkah 5 |
| `MORNING_HOUR` | opsional, jam ringkasan pagi WIB (bawaan 7) |
| `CHECKIN_HOUR` | opsional, jam check-in malam WIB (bawaan 21) |
| `RECAP_HOUR` | opsional, jam rekap mingguan Minggu WIB (bawaan 20) |

Lalu **Redeploy**.

## 4. Pasang webhook
Buka di browser (ganti 3 bagian):
```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<APP>.vercel.app/api/telegram&secret_token=<WEBHOOK_SECRET>
```
Harus muncul `"ok":true`.

## 5. Kunci bot ke akunmu
1. Kirim `/id` ke bot, dia membalas chat ID-mu.
2. Isi angka itu ke env `TELEGRAM_CHAT_ID`, lalu Redeploy.
3. Kirim `/start` agar tombol permanen muncul.

## 6. Pengecek tiap menit
Cron bawaan Vercel gratis hanya sekali sehari, jadi pakai cron-job.org:
1. Daftar di cron-job.org.
2. Buat cron baru, URL: `https://<APP>.vercel.app/api/cron?key=<CRON_SECRET>`
3. Jadwal: setiap 1 menit. Kalau ada pilihan timeout, set 60 detik.

Cron ini yang mengirim pengingat, ringkasan pagi, check-in malam, dan rekap mingguan.

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
| Curhat | tombol Mode Curhat; kembali dengan Mode Asisten |
| Ingatan | `/memori` melihat, `/lupakan` menghapus, `/reset` hapus riwayat chat |
| Otomatis | `/atur` melihat status; `/pagi`, `/checkin`, `/rekapauto` diikuti `on` atau `off` |

## Catatan
- Pesan otomatis dikirim paling lambat sekitar 1 menit dari waktunya. Jika cron sempat mati, ringkasan pagi masih dikirim selama masih dalam 3 jam sejak jamnya.
- Data bot (Redis) terpisah dari web (localStorage).
- Cuaca memakai Open-Meteo dan berita memakai RSS Google News, keduanya tanpa API key. Layanan gratis seperti ini bisa berubah sewaktu-waktu.
- Setiap foto atau voice note memakai kuota Gemini gratis (voice note memakai dua panggilan). Kalau muncul error 429, tunggu sebentar.
- Semua pesan dan data tersimpan di Redis milikmu. Jaga token bot dan akun Upstash.
