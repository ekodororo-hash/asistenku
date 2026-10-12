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

// Semua data pengguna disimpan dengan awalan u:<userId>:
const key = (u, name) => {
  if (!u) throw new Error("userId wajib");
  return `u:${u}:${name}`;
};

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

// ---------- Bot Telegram per pengguna ----------
// Disimpan di u:<id>:bot = {tokenEnc, username, secret, linkCode, chatId}
// Bot lama (env TELEGRAM_*) tetap dilayani untuk pemilik data lama sampai dia memasang bot sendiri.
async function getBot(u) {
  const raw = await redis("GET", key(u, "bot"));
  try {
    if (raw) {
      const b = JSON.parse(raw);
      return { ...b, token: decrypt(b.tokenEnc) };
    }
  } catch {}
  if (process.env.TELEGRAM_BOT_TOKEN && (await redis("GET", "legacy:owner")) === u) {
    return {
      legacy: true,
      token: process.env.TELEGRAM_BOT_TOKEN,
      secret: process.env.TELEGRAM_WEBHOOK_SECRET || "",
      chatId: process.env.TELEGRAM_CHAT_ID || null,
    };
  }
  return null;
}
async function saveBot(u, b) {
  const { token, legacy, ...rest } = b;
  await redis("SET", key(u, "bot"), JSON.stringify(rest));
}

async function tg(token, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return r.json().catch(() => ({ ok: false }));
}

const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");

// Pasang bot: validasi token, daftarkan webhook otomatis ke /api/telegram?u=<id>
async function setupBot(u, tokenIn, baseUrl) {
  const token = String(tokenIn || "").trim();
  if (!/^\d{6,12}:[\w-]{30,50}$/.test(token)) throw new Error("Format token bot tidak valid (ambil dari @BotFather).");
  const me = await tg(token, "getMe");
  if (!me.ok) throw new Error("Token ditolak Telegram. Cek lagi token-nya.");

  const h = sha(token);
  const owner = await redis("GET", "bottoken:" + h);
  if (owner && owner !== u) throw new Error("Bot ini sudah dipakai akun lain.");

  const old = await redis("GET", key(u, "bot"));
  let prev = null;
  try { prev = old ? JSON.parse(old) : null; } catch {}
  if (prev) await removeBot(u); // lepas bot sebelumnya dulu

  const secret = crypto.randomBytes(24).toString("hex");
  const linkCode = crypto.randomBytes(6).toString("hex");
  const wh = await tg(token, "setWebhook", {
    url: `${baseUrl}/api/telegram?u=${u}`,
    secret_token: secret,
    allowed_updates: ["message"],
    drop_pending_updates: true,
  });
  if (!wh.ok) throw new Error("Gagal mendaftarkan webhook: " + (wh.description || "tidak diketahui"));

  await saveBot(u, { tokenEnc: encrypt(token), username: me.result.username, name: me.result.first_name || "", secret, linkCode, chatId: null });
  await redis("SET", "bottoken:" + h, u);
  await redis("SADD", "bots", u);
  return botStatus(u);
}

async function removeBot(u) {
  const raw = await redis("GET", key(u, "bot"));
  if (!raw) return botStatus(u);
  try {
    const b = JSON.parse(raw);
    const token = decrypt(b.tokenEnc);
    await tg(token, "deleteWebhook", {});
    await redis("DEL", "bottoken:" + sha(token));
  } catch {}
  await redis("DEL", key(u, "bot"));
  await redis("SREM", "bots", u);
  return botStatus(u);
}

// Kunci chat dilepas, kode tautan baru dibuat (mis. ganti akun Telegram)
async function relinkBot(u) {
  const raw = await redis("GET", key(u, "bot"));
  if (!raw) throw new Error("Belum ada bot terpasang.");
  const b = JSON.parse(raw);
  b.chatId = null;
  b.linkCode = crypto.randomBytes(6).toString("hex");
  await redis("SET", key(u, "bot"), JSON.stringify(b));
  return botStatus(u);
}

async function botStatus(u) {
  const bot = await getBot(u);
  if (!bot) return { installed: false, legacy: false };

  // Nama bot dan akun Telegram yang terhubung, diambil langsung dari Telegram
  let me = {}, chat = {};
  try { me = (await tg(bot.token, "getMe")).result || {}; } catch {}
  if (bot.chatId) {
    try { chat = (await tg(bot.token, "getChat", { chat_id: bot.chatId })).result || {}; } catch {}
  }
  const username = me.username || bot.username || "";
  return {
    installed: !bot.legacy,
    legacy: !!bot.legacy,
    username,
    name: me.first_name || bot.name || "",
    linked: !!bot.chatId,
    chatId: bot.chatId ? String(bot.chatId) : null,
    chatName: [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.title || "",
    chatUsername: chat.username || "",
    linkUrl: !bot.legacy && !bot.chatId && username ? `https://t.me/${username}?start=${bot.linkCode}` : null,
  };
}

// Semua pengguna yang punya bot aktif (untuk cron)
async function botUsers() {
  const ids = new Set((await redis("SMEMBERS", "bots")) || []);
  const owner = await redis("GET", "legacy:owner");
  if (owner && process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) ids.add(owner);
  return [...ids];
}

async function sendTelegram(u, chatId, text, extra = {}) {
  const bot = await getBot(u);
  if (!bot) return false;
  const r = await tg(bot.token, "sendMessage", { chat_id: chatId, text: String(text).slice(0, 4000), reply_markup: KEYBOARD, ...extra });
  return !!r.ok;
}

async function downloadTelegramFile(u, fileId) {
  const bot = await getBot(u);
  if (!bot) throw new Error("Bot belum terpasang");
  const token = bot.token;
  const r = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const d = await r.json();
  if (!d.ok) throw new Error("Gagal mengambil file dari Telegram");
  const f = await fetch(`https://api.telegram.org/file/bot${token}/${d.result.file_path}`);
  if (!f.ok) throw new Error("Gagal mengunduh file dari Telegram");
  const buf = Buffer.from(await f.arrayBuffer());
  return { base64: buf.toString("base64"), path: d.result.file_path };
}

// ---------- Gemini (multi API key per pengguna + rotasi) ----------
const crypto = require("crypto");
const MAX_KEYS = 5;
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

// Kunci API disimpan terenkripsi (AES-256-GCM) dengan kunci turunan SESSION_SECRET
function encKey() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new Error("SESSION_SECRET belum diisi");
  return crypto.createHash("sha256").update("gkeys:" + s).digest();
}
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", encKey(), iv);
  const enc = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64")).join(".");
}
function decrypt(str) {
  const [iv, tag, enc] = String(str).split(".").map((x) => Buffer.from(x, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", encKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

async function loadKeyRecords(u) {
  const raw = await redis("GET", key(u, "gkeys"));
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}
async function saveKeyRecords(u, list) {
  await redis("SET", key(u, "gkeys"), JSON.stringify(list));
}

// Status per key + riwayat pemakaian (hapus saat menulis: umur maks. 1 hari, maks. 50 entri)
const HIST_MAX = 50;
const HIST_TTL = DAY;
const COOLDOWN_SEC = 60;
const HIST_SHOW = 20; // jumlah yang ditampilkan awal di UI

async function loadKeyStats(u) {
  const rows = await redis("HGETALL", key(u, "gstat"));
  const out = {};
  for (let i = 0; i < (rows || []).length; i += 2) {
    try { out[rows[i]] = JSON.parse(rows[i + 1]); } catch {}
  }
  return out;
}

// Daftar untuk UI: tanpa nilai key utuh
async function listGeminiKeys(u) {
  const [list, st] = await Promise.all([loadKeyRecords(u), loadKeyStats(u)]);
  return list.map((k) => {
    const s = st[k.id] || {};
    return { id: k.id, last4: k.last4, status: s.status || "unused", lastUsed: s.lastUsed || null, until: s.until || null, error: s.error || "" };
  });
}

// limit = 429 (pulih sendiri), invalid = key salah/dicabut, error = lainnya (mis. gangguan server Google)
function classifyGemini(status, msg) {
  if (status === 429) return "limit";
  if (status === 401 || status === 403 || (status === 400 && /api key|api_key/i.test(msg || ""))) return "invalid";
  return "error";
}

// Catat satu pemakaian: perbarui status key + tambah riwayat, lalu hapus entri lama (hapus saat menulis)
async function recordKeyUse(u, c, outcome) {
  try {
    const now = Date.now();
    const status = outcome.ok ? "ok" : classifyGemini(outcome.http, outcome.message);
    const error = outcome.ok ? "" : String(outcome.message || "").replace(/\s+/g, " ").slice(0, 120);
    if (c.id) {
      await redis("HSET", key(u, "gstat"), c.id, JSON.stringify({
        status, lastUsed: now, error,
        until: status === "limit" ? now + COOLDOWN_SEC * 1000 : null,
      }));
    }
    await redis("ZADD", key(u, "ghist"), now, JSON.stringify({
      id: uid(), ts: now, k: c.id ? c.last4 : "server", src: outcome.src || "web", st: status, err: error,
    }));
    await redis("ZREMRANGEBYSCORE", key(u, "ghist"), "-inf", now - HIST_TTL); // buang yang lebih tua dari 1 hari
    await redis("ZREMRANGEBYRANK", key(u, "ghist"), 0, -(HIST_MAX + 1));      // sisakan 50 terbaru
  } catch {} // pencatatan tidak boleh menggagalkan chat
}

async function getKeyHistory(u) {
  const rows = await redis("ZREVRANGE", key(u, "ghist"), 0, HIST_MAX - 1);
  const min = Date.now() - HIST_TTL; // sembunyikan yang sudah lewat 1 hari walau belum sempat terhapus
  return (rows || []).map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter((x) => x && x.ts >= min);
}

async function clearKeyHistory(u) {
  await redis("DEL", key(u, "ghist"));
}

// Satu paket untuk UI Pengaturan
async function keyState(u) {
  const [keys, history] = await Promise.all([listGeminiKeys(u), getKeyHistory(u)]);
  return { keys, history };
}

// Uji satu key dengan permintaan kecil sungguhan (status hasilnya langsung tercatat)
async function testGeminiKey(u, id) {
  const list = await loadKeyRecords(u);
  const rec = list.find((x) => x.id === id);
  if (!rec) throw new Error("Key tidak ditemukan.");
  const gate = await redis("SET", key(u, "gtest:" + id), "1", "NX", "EX", "5");
  if (gate !== "OK") throw new Error("Tunggu beberapa detik sebelum menguji lagi.");
  const model = process.env.GEMINI_MODEL || "gemini-flash-latest";
  const r = await fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": decrypt(rec.enc) },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: 5 } }),
  });
  const data = await r.json().catch(() => ({}));
  await recordKeyUse(u, { id, last4: rec.last4 }, { ok: r.ok, http: r.status, message: data?.error?.message, src: "uji" });
  if (r.status === 429) await redis("SET", key(u, "gcool:" + id), "1", "EX", String(COOLDOWN_SEC));
  return keyState(u);
}

async function checkGeminiKey(k) {
  const r = await fetch(`${GEMINI_BASE}/models?pageSize=1`, { headers: { "x-goog-api-key": k } });
  if (r.ok || r.status === 429) return true; // 429 = key valid tapi sedang kena limit
  return false;
}

async function addGeminiKey(u, value) {
  const k = String(value || "").trim();
  if (!/^[\w.\-]{20,200}$/.test(k)) throw new Error("Format API key tidak valid."); // key baru memakai titik (AQ.xxx), key lama AIza...
  const list = await loadKeyRecords(u);
  if (list.length >= MAX_KEYS) throw new Error(`Maksimal ${MAX_KEYS} API key.`);
  if (list.some((x) => decrypt(x.enc) === k)) throw new Error("API key ini sudah ada.");
  if (!(await checkGeminiKey(k))) throw new Error("API key ditolak Google. Cek lagi key-nya.");
  list.push({ id: uid(), enc: encrypt(k), last4: k.slice(-4) });
  await saveKeyRecords(u, list);
  return keyState(u);
}

async function deleteGeminiKey(u, id) {
  const list = await loadKeyRecords(u);
  await saveKeyRecords(u, list.filter((x) => x.id !== id));
  await redis("DEL", key(u, "gcool:" + id));
  await redis("HDEL", key(u, "gstat"), id);
  return keyState(u);
}

async function moveGeminiKey(u, id, dir) {
  const list = await loadKeyRecords(u);
  const i = list.findIndex((x) => x.id === id);
  const j = i + (dir === "up" ? -1 : 1);
  if (i < 0 || j < 0 || j >= list.length) return keyState(u);
  [list[i], list[j]] = [list[j], list[i]];
  await saveKeyRecords(u, list);
  return keyState(u);
}

// Urutan: key pengguna 1..5, lalu GEMINI_API_KEY global sebagai cadangan terakhir
async function geminiCandidates(u) {
  const out = [];
  for (const r of await loadKeyRecords(u)) {
    try { out.push({ id: r.id, last4: r.last4, key: decrypt(r.enc) }); } catch {}
  }
  if (process.env.GEMINI_API_KEY) out.push({ id: null, key: process.env.GEMINI_API_KEY });
  return out;
}

// Error yang layak dicoba dengan key berikutnya
const rotatable = (status) => status === 429 || status === 403 || status === 401 || status === 400 || status >= 500;

async function geminiRaw(u, body, src) {
  const model = process.env.GEMINI_MODEL || "gemini-flash-latest";
  const cands = await geminiCandidates(u);
  if (!cands.length) {
    const e = new Error("Belum ada API key Gemini. Tambahkan di Pengaturan.");
    e.status = 400;
    throw e;
  }
  // Lewati key yang baru kena limit (cooldown), kecuali semuanya sedang cooldown
  const cooled = await Promise.all(cands.map(async (c) => (c.id ? (await redis("EXISTS", key(u, "gcool:" + c.id))) === 1 : false)));
  let order = cands.filter((_, i) => !cooled[i]);
  if (!order.length) order = cands;

  let lastErr;
  for (const c of order) {
    const r = await fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": c.key },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    await recordKeyUse(u, c, { ok: r.ok, http: r.status, message: data?.error?.message, src });
    if (r.ok) return data;
    lastErr = new Error(data?.error?.message || "Gagal memanggil Gemini");
    lastErr.status = r.status === 429 ? 429 : 502; // jangan 401: web mengira sesi habis
    if (r.status === 429 && c.id) await redis("SET", key(u, "gcool:" + c.id), "1", "EX", "60");
    if (!rotatable(r.status)) break;
  }
  throw lastErr;
}

async function gemini(u, system, contents, src = "telegram") {
  const body = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const data = await geminiRaw(u, body, src);
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

async function appendModelToHist(u, text) {
  const raw = await redis("GET", key(u, "hist"));
  let hist = [];
  try { hist = raw ? JSON.parse(raw) : []; } catch {}
  hist.push({ role: "model", parts: [{ text }], ts: Date.now() });
  await redis("SET", key(u, "hist"), JSON.stringify(hist.slice(-30)));
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
async function getTasks(u) {
  const raw = await redis("GET", key(u, "tasks"));
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}
async function saveTasks(u, tasks) {
  await redis("SET", key(u, "tasks"), JSON.stringify(tasks.slice(-200)));
}
async function addTask(u, text) {
  const tasks = await getTasks(u);
  const item = { id: uid(), text: String(text).trim().slice(0, 300), done: false };
  if (!item.text) return null;
  tasks.push(item);
  await saveTasks(u, tasks);
  return item;
}
async function toggleTask(u, id) {
  const tasks = await getTasks(u);
  const t = tasks.find((x) => x.id === id);
  if (!t) return null;
  t.done = !t.done;
  await saveTasks(u, tasks);
  return t;
}
async function deleteTask(u, id) {
  const tasks = await getTasks(u);
  const next = tasks.filter((x) => x.id !== id);
  if (next.length === tasks.length) return false;
  await saveTasks(u, next);
  return true;
}

// ---------- Catatan (dipakai bareng web & Telegram) ----------
async function getNotes(u) {
  const rows = await redis("LRANGE", key(u, "notes"), 0, -1);
  return (rows || []).map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
}
async function addNote(u, text) {
  const t = String(text).trim().slice(0, 1000);
  if (!t) return null;
  const item = { id: uid(), ts: Date.now(), text: t };
  await redis("RPUSH", key(u, "notes"), JSON.stringify(item));
  await redis("LTRIM", key(u, "notes"), -300, -1);
  return item;
}
async function deleteNoteById(u, id) {
  const all = await getNotes(u);
  const next = all.filter((n) => n.id !== id);
  if (next.length === all.length) return false;
  await redis("DEL", key(u, "notes"));
  if (next.length) await redis("RPUSH", key(u, "notes"), ...next.map((n) => JSON.stringify(n)));
  return true;
}

// ---------- Pengeluaran (dipakai bareng web & Telegram) ----------
async function addExpense(u, amt, cat, note) {
  const n = Math.round(Number(amt));
  if (!Number.isFinite(n) || n <= 0 || n > 1e10) return null;
  const item = { id: uid(), ts: Date.now(), amt: n, cat: String(cat || "lainnya").toLowerCase().slice(0, 20), note: String(note || "").slice(0, 100) };
  await redis("RPUSH", key(u, "exp:" + wib().monthKey), JSON.stringify(item));
  return item;
}
async function getExpenses(u, monthKey) {
  const rows = await redis("LRANGE", key(u, "exp:" + (monthKey || wib().monthKey)), 0, -1);
  return (rows || []).map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
}
async function deleteExpenseById(u, id, monthKey) {
  const mk = monthKey || wib().monthKey;
  const all = await getExpenses(u, mk);
  const next = all.filter((e) => e.id !== id);
  if (next.length === all.length) return false;
  await redis("DEL", key(u, "exp:" + mk));
  if (next.length) await redis("RPUSH", key(u, "exp:" + mk), ...next.map((e) => JSON.stringify(e)));
  return true;
}

// ---------- Pengingat (dipakai bareng web & Telegram; dikirim lewat Telegram oleh cron) ----------
const REPEATS = ["harian", "mingguan", "bulanan"];
async function getReminders(u) {
  const rows = await redis("ZRANGE", key(u, "reminders"), 0, -1, "WITHSCORES");
  const out = [];
  for (let i = 0; i < (rows || []).length; i += 2) {
    let it = {};
    try { it = JSON.parse(rows[i]); } catch {}
    const ts = Number(rows[i + 1]);
    out.push({ id: it.id || "t" + ts, text: it.text || "?", ts, repeat: it.repeat || null });
  }
  return out;
}
async function addReminder(u, text, ts, repeat) {
  const t = String(text || "").trim().slice(0, 200);
  const when = Number(ts);
  if (!t || !Number.isFinite(when) || when <= Date.now()) return null;
  const item = { id: uid(), text: t };
  if (REPEATS.includes(repeat)) item.repeat = repeat;
  await redis("ZADD", key(u, "reminders"), when, JSON.stringify(item));
  return { id: item.id, text: item.text, ts: when, repeat: item.repeat || null };
}
async function deleteReminderById(u, id) {
  const rows = await redis("ZRANGE", key(u, "reminders"), 0, -1, "WITHSCORES");
  for (let i = 0; i < (rows || []).length; i += 2) {
    let it = {};
    try { it = JSON.parse(rows[i]); } catch {}
    if ((it.id || "t" + Number(rows[i + 1])) === id) {
      await redis("ZREM", key(u, "reminders"), rows[i]);
      return true;
    }
  }
  return false;
}

// ---------- Profil (web) ----------
async function getProfile(u) {
  const raw = await redis("GET", key(u, "profile"));
  try { if (raw) return JSON.parse(raw); } catch {}
  return { name: "", assistantName: "Asisten", notes: "" };
}
async function saveProfile(u, p) {
  const profile = {
    name: String((p || {}).name || "").slice(0, 100),
    assistantName: String((p || {}).assistantName || "Asisten").slice(0, 50),
    notes: String((p || {}).notes || "").slice(0, 1000),
  };
  await redis("SET", key(u, "profile"), JSON.stringify(profile));
  return profile;
}

// ---------- Mode (dipakai bareng web & Telegram) ----------
async function getMode(u) {
  const m = await redis("GET", key(u, "mode"));
  return m === "curhat" ? "curhat" : "asisten";
}
async function setMode(u, m) {
  const mode = m === "curhat" ? "curhat" : "asisten";
  await redis("SET", key(u, "mode"), mode);
  return mode;
}

// ---------- Riwayat obrolan (dipakai bareng web & Telegram) ----------
async function getHist(u) {
  const raw = await redis("GET", key(u, "hist"));
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}
async function saveHist(u, hist) {
  await redis("SET", key(u, "hist"), JSON.stringify(hist.slice(-60)));
}

// ---------- Pengaturan (on/off) ----------
async function cfgOn(u, name) {
  const v = await redis("HGET", key(u, "cfg"), name);
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

async function getLocation(u) {
  const raw = await redis("GET", key(u, "loc"));
  try { if (raw) return JSON.parse(raw); } catch {}
  return {
    name: process.env.WEATHER_CITY || "Jakarta",
    lat: Number(process.env.WEATHER_LAT || -6.2088),
    lon: Number(process.env.WEATHER_LON || 106.8456),
  };
}

async function setLocation(u, name) {
  const r = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=id`
  );
  const d = await r.json();
  const g = d.results && d.results[0];
  if (!g) return null;
  const loc = { name: g.name, lat: g.latitude, lon: g.longitude };
  await redis("SET", key(u, "loc"), JSON.stringify(loc));
  return loc;
}

async function getWeather(u) {
  const loc = await getLocation(u);
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
async function expensesSince(u, fromTs) {
  const keys = new Set([wib(fromTs).monthKey, wib().monthKey]);
  const all = [];
  for (const k of keys) {
    const rows = await redis("LRANGE", key(u, "exp:" + k), 0, -1);
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

async function recapText(u) {
  const now = Date.now();
  const w = wib(now);
  const weekStart = startOfDayWib(now) - ((w.weekday + 6) % 7) * DAY; // Senin
  const monthStart = Date.UTC(w.y, w.m - 1, 1) - 7 * HOUR;
  const all = await expensesSince(u, Math.min(weekStart, monthStart));
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
async function loadContext(u) {
  const [facts, rows] = await Promise.all([
    redis("LRANGE", key(u, "facts"), 0, -1),
    redis("ZRANGE", key(u, "reminders"), 0, 9, "WITHSCORES"),
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
  uid, key, MAX_KEYS, getBot, saveBot, setupBot, removeBot, relinkBot, botStatus, botUsers, listGeminiKeys, keyState, getKeyHistory, clearKeyHistory, testGeminiKey, HIST_SHOW, addGeminiKey, deleteGeminiKey, moveGeminiKey,
  redis, sendTelegram, downloadTelegramFile, gemini, geminiRaw, trimHist, appendModelToHist,
  fmtWib, fmtTime, fmtDateShort, wib, startOfDayWib, nextRepeat, rupiah,
  cfgOn, getLocation, setLocation, getWeather, getNews,
  recapText, loadContext, buildSystem,
  getTasks, addTask, toggleTask, deleteTask,
  getNotes, addNote, deleteNoteById,
  getExpenses, addExpense, deleteExpenseById,
  getProfile, saveProfile,
  getMode, setMode,
  getHist, saveHist,
  getReminders, addReminder, deleteReminderById,
};
