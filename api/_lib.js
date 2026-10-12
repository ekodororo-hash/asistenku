// Fungsi bantu bersama. File berawalan "_" tidak dijadikan endpoint oleh Vercel.

const TZ = "Asia/Jakarta";
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// Jam (WIB) untuk pesan otomatis. Bisa diubah lewat env di Vercel.
const HOURS = {
  morning: Number(process.env.MORNING_HOUR || 7),
  checkin: Number(process.env.CHECKIN_HOUR || 21),
  recap: Number(process.env.RECAP_HOUR || 20),
};

// ---------- Umum ----------
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Cek PIN web (header x-web-pin). Dipakai api/chat.js dan api/state.js supaya
// data pribadi (tugas/catatan/uang/obrolan) tidak bisa diakses sembarang orang.
function requirePin(req, res) {
  const pin = process.env.WEB_PIN;
  if (!pin) {
    res.status(500).json({ error: "WEB_PIN belum diisi di Vercel. Tambahkan dulu lalu redeploy." });
    return false;
  }
  if (req.headers["x-web-pin"] === pin) return true;
  res.status(401).json({ error: "PIN salah." });
  return false;
}

// ---------- Redis (Upstash REST) ----------
async function redis(...cmd) {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error("Redis belum dikonfigurasi (env UPSTASH_REDIS_REST_URL / TOKEN)");
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd.map(String)),
  });
  const d = await r.json();
  if (d.error) throw new Error("Redis: " + d.error);
  return d.result;
}

// ---------- Telegram ----------
// Tombol permanen di bawah kolom ketik
const BTN = {
  remind: "📋 Pengingat",
  plan: "📝 Rencana hari ini",
  weather: "⛅ Cuaca",
  news: "📰 Berita",
  recap: "💰 Rekap",
  notes: "🗒️ Catatan",
  curhat: "💬 Mode Curhat",
  asisten: "🤖 Mode Asisten",
  reset: "🧹 Reset",
};
const KEYBOARD = {
  keyboard: [
    [BTN.remind, BTN.plan],
    [BTN.weather, BTN.news],
    [BTN.recap, BTN.notes],
    [BTN.curhat, BTN.asisten, BTN.reset],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

async function sendTelegram(chatId, text, extra = {}) {
  const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4000), reply_markup: KEYBOARD, ...extra }),
  });
  return r.ok;
}

async function downloadTelegramFile(fileId) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const r = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const d = await r.json();
  if (!d.ok) throw new Error("Gagal mengambil file dari Telegram");
  const f = await fetch(`https://api.telegram.org/file/bot${token}/${d.result.file_path}`);
  if (!f.ok) throw new Error("Gagal mengunduh file dari Telegram");
  const buf = Buffer.from(await f.arrayBuffer());
  return { base64: buf.toString("base64"), path: d.result.file_path };
}

// ---------- Gemini ----------
async function gemini(system, contents) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY belum diisi");
  const model = process.env.GEMINI_MODEL || "gemini-flash-latest";
  const body = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
    }
  );
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || "Gagal memanggil Gemini");
  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
}

// Riwayat harus diawali giliran "user" dan selang-seling
function trimHist(h, n = 30) {
  const c = h.slice(-n);
  while (c.length && c[0].role === "model") c.shift();
  const out = [];
  for (const x of c) {
    const last = out[out.length - 1];
    if (last && last.role === x.role) last.parts = [...last.parts, ...x.parts];
    else out.push({ role: x.role, parts: [...x.parts] });
  }
  return out;
}

async function appendModelToHist(text) {
  const raw = await redis("GET", "hist");
  let hist = [];
  try { hist = raw ? JSON.parse(raw) : []; } catch {}
  hist.push({ role: "model", parts: [{ text }] });
  await redis("SET", "hist", JSON.stringify(hist.slice(-30)));
}

// ---------- Waktu (WIB = UTC+7, tanpa DST) ----------
function fmtWib(ts) {
  return new Date(ts).toLocaleString("id-ID", { timeZone: TZ, dateStyle: "full", timeStyle: "short" }) + " WIB";
}
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString("id-ID", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
}
function fmtDateShort(ts) {
  return new Date(ts).toLocaleDateString("id-ID", { timeZone: TZ, day: "numeric", month: "short" });
}
function wib(ts = Date.now()) {
  const d = new Date(ts + 7 * HOUR);
  const pad = (n) => String(n).padStart(2, "0");
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, day = d.getUTCDate();
  return {
    y, m, d: day,
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay(), // 0 = Minggu
    dateKey: `${y}-${pad(m)}-${pad(day)}`,
    monthKey: `${y}-${pad(m)}`,
  };
}
function startOfDayWib(ts = Date.now()) {
  const d = new Date(ts + 7 * HOUR);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() - 7 * HOUR;
}
function nextRepeat(ts, rule) {
  if (rule === "harian") return ts + DAY;
  if (rule === "mingguan") return ts + 7 * DAY;
  if (rule === "bulanan") {
    const d = new Date(ts);
    d.setUTCMonth(d.getUTCMonth() + 1);
    return d.getTime();
  }
  return null;
}
const rupiah = (n) => "Rp" + Math.round(n).toLocaleString("id-ID");

// ---------- Tugas (dipakai bareng web & Telegram) ----------
async function getTasks() {
  const raw = await redis("GET", "tasks");
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}
async function saveTasks(tasks) {
  await redis("SET", "tasks", JSON.stringify(tasks.slice(-200)));
}
async function addTask(text) {
  const tasks = await getTasks();
  const item = { id: uid(), text: String(text).trim().slice(0, 300), done: false };
  if (!item.text) return null;
  tasks.push(item);
  await saveTasks(tasks);
  return item;
}
async function toggleTask(id) {
  const tasks = await getTasks();
  const t = tasks.find((x) => x.id === id);
  if (!t) return null;
  t.done = !t.done;
  await saveTasks(tasks);
  return t;
}
async function deleteTask(id) {
  const tasks = await getTasks();
  const next = tasks.filter((x) => x.id !== id);
  if (next.length === tasks.length) return false;
  await saveTasks(next);
  return true;
}

// ---------- Catatan (dipakai bareng web & Telegram) ----------
async function getNotes() {
  const rows = await redis("LRANGE", "notes", 0, -1);
  return (rows || []).map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
}
async function addNote(text) {
  const t = String(text).trim().slice(0, 1000);
  if (!t) return null;
  const item = { id: uid(), ts: Date.now(), text: t };
  await redis("RPUSH", "notes", JSON.stringify(item));
  await redis("LTRIM", "notes", -300, -1);
  return item;
}
async function deleteNoteById(id) {
  const all = await getNotes();
  const next = all.filter((n) => n.id !== id);
  if (next.length === all.length) return false;
  await redis("DEL", "notes");
  if (next.length) await redis("RPUSH", "notes", ...next.map((n) => JSON.stringify(n)));
  return true;
}

// ---------- Pengeluaran (dipakai bareng web & Telegram) ----------
async function addExpense(amt, cat, note) {
  const n = Math.round(Number(amt));
  if (!Number.isFinite(n) || n <= 0 || n > 1e10) return null;
  const item = { id: uid(), ts: Date.now(), amt: n, cat: String(cat || "lainnya").toLowerCase().slice(0, 20), note: String(note || "").slice(0, 100) };
  await redis("RPUSH", "exp:" + wib().monthKey, JSON.stringify(item));
  return item;
}
async function getExpenses(monthKey) {
  const rows = await redis("LRANGE", "exp:" + (monthKey || wib().monthKey), 0, -1);
  return (rows || []).map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
}
async function deleteExpenseById(id, monthKey) {
  const mk = monthKey || wib().monthKey;
  const all = await getExpenses(mk);
  const next = all.filter((e) => e.id !== id);
  if (next.length === all.length) return false;
  await redis("DEL", "exp:" + mk);
  if (next.length) await redis("RPUSH", "exp:" + mk, ...next.map((e) => JSON.stringify(e)));
  return true;
}

// ---------- Profil (web) ----------
async function getProfile() {
  const raw = await redis("GET", "profile");
  try { if (raw) return JSON.parse(raw); } catch {}
  return { name: "", assistantName: "Asisten", notes: "" };
}
async function saveProfile(p) {
  const profile = {
    name: String((p || {}).name || "").slice(0, 100),
    assistantName: String((p || {}).assistantName || "Asisten").slice(0, 50),
    notes: String((p || {}).notes || "").slice(0, 1000),
  };
  await redis("SET", "profile", JSON.stringify(profile));
  return profile;
}

// ---------- Mode (dipakai bareng web & Telegram) ----------
async function getMode() {
  const m = await redis("GET", "mode");
  return m === "curhat" ? "curhat" : "asisten";
}
async function setMode(m) {
  const mode = m === "curhat" ? "curhat" : "asisten";
  await redis("SET", "mode", mode);
  return mode;
}

// ---------- Riwayat obrolan (dipakai bareng web & Telegram) ----------
async function getHist() {
  const raw = await redis("GET", "hist");
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}
async function saveHist(hist) {
  await redis("SET", "hist", JSON.stringify(hist.slice(-60)));
}

// ---------- Pengaturan (on/off) ----------
async function cfgOn(key) {
  const v = await redis("HGET", "cfg", key);
  return v !== "off";
}

// ---------- Cuaca (Open-Meteo, tanpa API key) ----------
function wmo(c) {
  if (c === 0) return "cerah";
  if (c === 1) return "cerah berawan";
  if (c === 2) return "berawan sebagian";
  if (c === 3) return "berawan";
  if (c === 45 || c === 48) return "berkabut";
  if (c >= 51 && c <= 57) return "gerimis";
  if (c >= 61 && c <= 67) return "hujan";
  if (c >= 80 && c <= 82) return "hujan deras sesaat";
  if (c >= 95) return "badai petir";
  return "berubah-ubah";
}

async function getLocation() {
  const raw = await redis("GET", "loc");
  try { if (raw) return JSON.parse(raw); } catch {}
  return {
    name: process.env.WEATHER_CITY || "Jakarta",
    lat: Number(process.env.WEATHER_LAT || -6.2088),
    lon: Number(process.env.WEATHER_LON || 106.8456),
  };
}

async function setLocation(name) {
  const r = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=id`
  );
  const d = await r.json();
  const g = d.results && d.results[0];
  if (!g) return null;
  const loc = { name: g.name, lat: g.latitude, lon: g.longitude };
  await redis("SET", "loc", JSON.stringify(loc));
  return loc;
}

async function getWeather() {
  const loc = await getLocation();
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
    `&current=temperature_2m,apparent_temperature,weather_code` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&timezone=Asia%2FJakarta&forecast_days=1`;
  const r = await fetch(url);
  const d = await r.json();
  if (!r.ok || !d.current) throw new Error("Data cuaca tidak tersedia");
  const c = d.current, dy = d.daily;
  return (
    `${loc.name}: sekarang ${wmo(c.weather_code)}, ${Math.round(c.temperature_2m)}°C ` +
    `(terasa ${Math.round(c.apparent_temperature)}°C). ` +
    `Hari ini ${wmo(dy.weather_code[0])}, ${Math.round(dy.temperature_2m_min[0])}-${Math.round(dy.temperature_2m_max[0])}°C, ` +
    `peluang hujan ${dy.precipitation_probability_max[0]}%.`
  );
}

// ---------- Berita (RSS Google News, tanpa API key) ----------
async function getNews(topic) {
  const url = topic
    ? `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=id&gl=ID&ceid=ID:id`
    : "https://news.google.com/rss?hl=id&gl=ID&ceid=ID:id";
  const r = await fetch(url);
  if (!r.ok) throw new Error("Gagal mengambil berita");
  const xml = await r.text();
  const decode = (s) =>
    s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").trim();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 5).map((m) => ({
    title: decode((m[1].match(/<title>([\s\S]*?)<\/title>/) || [])[1] || ""),
    link: decode((m[1].match(/<link>([\s\S]*?)<\/link>/) || [])[1] || ""),
  }));
  if (!items.length) return "Tidak ada berita ditemukan.";
  return (
    (topic ? `Berita: ${topic}\n\n` : "Berita terkini\n\n") +
    items.map((it, i) => `${i + 1}. ${it.title}\n${it.link}`).join("\n\n")
  );
}

// ---------- Pengeluaran ----------
async function expensesSince(fromTs) {
  const keys = new Set([wib(fromTs).monthKey, wib().monthKey]);
  const all = [];
  for (const k of keys) {
    const rows = await redis("LRANGE", "exp:" + k, 0, -1);
    for (const r of rows || []) { try { all.push(JSON.parse(r)); } catch {} }
  }
  return all.filter((e) => e.ts >= fromTs).sort((a, b) => a.ts - b.ts);
}

function breakdown(list) {
  const total = list.reduce((s, e) => s + e.amt, 0);
  const by = {};
  for (const e of list) by[e.cat] = (by[e.cat] || 0) + e.amt;
  const lines = Object.entries(by).sort((a, b) => b[1] - a[1]).map(([c, v]) => `  - ${c}: ${rupiah(v)}`);
  return { total, lines };
}

async function recapText() {
  const now = Date.now();
  const w = wib(now);
  const weekStart = startOfDayWib(now) - ((w.weekday + 6) % 7) * DAY; // Senin
  const monthStart = Date.UTC(w.y, w.m - 1, 1) - 7 * HOUR;
  const all = await expensesSince(Math.min(weekStart, monthStart));
  const week = all.filter((e) => e.ts >= weekStart);
  const month = all.filter((e) => e.ts >= monthStart);
  if (!month.length) {
    return { text: "Belum ada pengeluaran tercatat bulan ini. Coba ketik: makan siang 25rb", weekCount: 0 };
  }
  const bw = breakdown(week), bm = breakdown(month);
  const last = month.slice(-5).map((e) => `  - ${fmtDateShort(e.ts)}: ${e.note || e.cat}, ${rupiah(e.amt)} (${e.cat})`);
  const text =
    `💰 Pengeluaran\n\n` +
    `Minggu ini: ${rupiah(bw.total)} (${week.length} transaksi)\n${bw.lines.join("\n") || "  -"}\n\n` +
    `Bulan ini: ${rupiah(bm.total)} (${month.length} transaksi)\n${bm.lines.join("\n")}\n\n` +
    `Terakhir:\n${last.join("\n")}\n\nSalah catat? /hapusbeli menghapus entri terakhir.`;
  return { text, weekCount: week.length };
}

// ---------- Konteks & prompt ----------
async function loadContext() {
  const [facts, rows] = await Promise.all([
    redis("LRANGE", "facts", 0, -1),
    redis("ZRANGE", "reminders", 0, 9, "WITHSCORES"),
  ]);
  const reminders = [];
  for (let i = 0; i < (rows || []).length; i += 2) {
    let it = {};
    try { it = JSON.parse(rows[i]); } catch {}
    reminders.push({ text: it.text || "?", ts: Number(rows[i + 1]), repeat: it.repeat });
  }
  return { facts: facts || [], reminders };
}

const PERSONA = {
  asisten: `Kamu asisten pribadi sekaligus teman lewat Telegram. Jawab santai dan ringkas dalam bahasa Indonesia.
Kalau pengguna terlihat sedang curhat atau emosional, langsung berubah jadi pendengar yang hangat (dengarkan dulu, jangan buru-buru memberi solusi).`,

  curhat: `Kamu teman dekat yang hangat dan jadi tempat curhat, berbahasa Indonesia santai (aku/kamu).
- Dengarkan dulu. Jangan buru-buru memberi solusi atau daftar saran.
- Akui dan validasi perasaannya, lalu ajukan SATU pertanyaan lembut agar dia mau bercerita lebih jauh.
- Jangan menghakimi, jangan menceramahi, jangan menggurui. Kalimat pendek, hangat, boleh sesekali ringan.
- Beri saran hanya kalau diminta atau terasa dia memang butuh.
- Kamu tidak berpura-pura jadi manusia: kalau ditanya, akui kamu AI, tapi tetap hadir dan peduli.
- Dukung hubungannya dengan teman dan keluarga; jangan membuat dia bergantung hanya padamu.`,
};

const COMMON = `Aturan umum:
- Tulis teks biasa, tanpa markdown (tanpa * atau #). Emoji boleh secukupnya.
- Jangan memberi diagnosis medis.
- Jika ada tanda pengguna ingin menyakiti diri, ingin mengakhiri hidup, atau dalam bahaya: tanggapi dengan tenang dan sungguh-sungguh, tanyakan langsung apakah dia aman sekarang, jangan menghakimi, dorong dia menghubungi orang terdekat yang dipercaya dan layanan darurat/kesehatan jiwa setempat (Indonesia: 112 untuk darurat; 119 ekstensi 8 untuk layanan kesehatan jiwa Kemenkes), dan tetap temani dia bicara. Jangan memberi informasi cara menyakiti diri.

Tag khusus (ditaruh di baris terakhir balasan; pengguna tidak melihatnya):
- Pengingat: [[REMIND: 2026-10-12T08:00:00+07:00 | isi pengingat singkat]]
  Waktu format ISO 8601 dengan +07:00, dihitung dari waktu sekarang (ubah "besok", "lusa", "2 jam lagi" jadi waktu pasti). Jika jam tidak disebut, tanyakan dulu dan jangan buat tag.
  Pengingat berulang: tambahkan bagian ketiga harian / mingguan / bulanan, contoh [[REMIND: 2026-10-13T09:00:00+07:00 | rapat tim | mingguan]]. Waktu = kemunculan pertama.
- Pengeluaran yang sudah terjadi (mis. "makan siang 25rb", "beli bensin 50 ribu", atau foto struk/nota): [[BELI: 25000 | makan | makan siang]]
  Jumlah rupiah angka bulat tanpa titik ("25rb" = 25000, "1,5jt" = 1500000). Kategori satu kata: makan, transport, belanja, tagihan, hiburan, kesehatan, lainnya. Untuk struk cukup satu tag berisi total.
- Tugas/checklist (hal yang perlu dikerjakan, BUKAN pengingat berwaktu): [[TASK: isi tugas singkat]]
- Fakta jangka panjang tentang pengguna (nama, orang penting, kebiasaan, preferensi, hal besar yang sedang dihadapi): [[INGAT: fakta singkat]]. Jangan simpan detail yang sangat sensitif kecuali pengguna memintanya.
- Catatan jika pengguna minta mencatat sesuatu: [[CATAT: isi catatan]]
- Satu tag per hal. Jangan membuat tag kalau tidak perlu. Jika pengguna mengirim foto, lihat isinya dan tanggapi sesuai konteks.
- Pesan yang diawali [Pesan otomatis sistem] adalah instruksi dari sistem untuk menulis pesan proaktif, bukan dari pengguna.`;

function buildSystem(mode, ctx) {
  const persona = mode === "curhat" ? PERSONA.curhat : PERSONA.asisten;
  const rem = ctx.reminders.length
    ? ctx.reminders
        .map((r) => `- ${r.text} (${fmtWib(r.ts)})${r.repeat ? " [berulang: " + r.repeat + "]" : ""}`)
        .join("\n")
    : "(belum ada)";
  return `${persona}

Waktu sekarang: ${fmtWib(Date.now())}. Zona waktu pengguna: WIB (UTC+07:00).

Yang kamu ingat tentang pengguna:
${ctx.facts.length ? ctx.facts.map((f) => "- " + f).join("\n") : "(belum ada)"}

Pengingat mendatang pengguna:
${rem}

${COMMON}`;
}

module.exports = {
  TZ, DAY, HOUR, HOURS, BTN,
  uid, requirePin,
  redis, sendTelegram, downloadTelegramFile, gemini, trimHist, appendModelToHist,
  fmtWib, fmtTime, fmtDateShort, wib, startOfDayWib, nextRepeat, rupiah,
  cfgOn, getLocation, setLocation, getWeather, getNews,
  recapText, loadContext, buildSystem,
  getTasks, addTask, toggleTask, deleteTask,
  getNotes, addNote, deleteNoteById,
  getExpenses, addExpense, deleteExpenseById,
  getProfile, saveProfile,
  getMode, setMode,
  getHist, saveHist,
};
