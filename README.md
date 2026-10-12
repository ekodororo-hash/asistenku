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
- Data web tersimpan di browser (localStorage); data bot Telegram di Redis. Keduanya tidak sinkron.
- Paket gratis Gemini punya batas permintaan; kalau error 429, tunggu sebentar.
- Error "model not found": isi `GEMINI_MODEL` dengan nama model yang benar.
- Jangan membagikan API key, token bot, dan akun Upstash.
