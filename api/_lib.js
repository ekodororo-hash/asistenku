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
  tasks: "✅ Tugas",
  recap: "💰 Uang",
  notes: "🗒️ Catatan",
  curhat: "💬 Mode Curhat",
  asisten: "🤖 Mode Asisten",
  reset: "🧹 Reset",
};
const KEYBOARD = {
  keyboard: [
    [BTN.tasks, BTN.remind],
    [BTN.notes, BTN.recap],
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
    allowed_updates: ["message", "callback_query"],
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
const INVALID_SKIP_MS = HOUR;      // key "tidak valid" dilewati selama 1 jam sejak terakhir dicoba
const MODEL_FIELD = "_model";      // pengaturan model disimpan di hash gstat yang sama (hemat perintah Redis)
const DEFAULT_MODEL = () => process.env.GEMINI_MODEL || "gemini-flash-latest";

// Kuota harian Gemini direset tengah malam waktu Pasifik, jadi hitungan "hari ini" mengikutinya
function quotaDay() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}
async function loadUseToday(u) {
  const rows = await redis("HGETALL", key(u, "guse:" + quotaDay()));
  const out = {};
  for (let i = 0; i < (rows || []).length; i += 2) out[rows[i]] = Number(rows[i + 1]) || 0;
  return out;
}

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
  const [list, st, use] = await Promise.all([loadKeyRecords(u), loadKeyStats(u), loadUseToday(u)]);
  return list.map((k) => {
    const s = st[k.id] || {};
    return { id: k.id, last4: k.last4, name: k.name || "", status: s.status || "unused", lastUsed: s.lastUsed || null, until: s.until || null, error: s.error || "", today: use[k.id] || 0 };
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
      id: uid(), ts: now, k: c.id ? c.last4 : "server", n: c.id ? (c.name || "") : "", m: outcome.model || "", src: outcome.src || "web", st: status, err: error,
    }));
    if (outcome.ok) {
      const hk = key(u, "guse:" + quotaDay());
      const n = await redis("HINCRBY", hk, c.id || "server", 1);
      if (Number(n) === 1) await redis("EXPIRE", hk, String(3 * 86400));
    }
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

// Kuota gratis per hari per project (dari halaman Rate limits AI Studio, Okt 2026). 0 = tidak ada kuota gratis / tidak diketahui.
function modelDailyLimit(m) {
  const n = String(m || "").toLowerCase();
  if (/image|tts|veo|imagen|embed|live|audio|aqa|robotics|computer-use|omni|banana|lyria|transcribe|translate|deep-research/.test(n)) return 0;
  if (/gemini-1\.|gemini-2\.0|gemini-exp/.test(n) || /pro/.test(n)) return 0;
  if (/gemma-4/.test(n)) return 14400;
  const v = parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1]);
  if (/flash-lite/.test(n)) return (isNaN(v) || v >= 3) ? 500 : 20;
  if (/flash/.test(n)) return 20;
  return 0;
}

// Perkiraan sisa kuota gratis hari ini: batas model utama x jumlah key, dikurangi total pemakaian hari ini.
// Hanya perkiraan: key dari project yang sama berbagi kuota, dan hitungan mencakup model cadangan juga.
async function quotaStatus(u) {
  try {
    const [recs, st, use] = await Promise.all([loadKeyRecords(u), loadKeyStats(u), loadUseToday(u)]);
    const model = (st[MODEL_FIELD] || {}).model || DEFAULT_MODEL();
    const limit = modelDailyLimit(model);
    const n = recs.length + (process.env.GEMINI_API_KEY ? 1 : 0);
    if (!limit || !n) return null;
    const used = Object.values(use).reduce((a, b) => a + b, 0);
    const total = limit * n;
    return { model, used, total, left: Math.max(0, total - used) };
  } catch { return null; }
}

// Uji satu key dengan permintaan kecil sungguhan (status hasilnya langsung tercatat)
async function testGeminiKey(u, id) {
  const list = await loadKeyRecords(u);
  const rec = list.find((x) => x.id === id);
  if (!rec) throw new Error("Key tidak ditemukan.");
  const gate = await redis("SET", key(u, "gtest:" + id), "1", "NX", "EX", "5");
  if (gate !== "OK") throw new Error("Tunggu beberapa detik sebelum test lagi.");
  const model = ((await loadKeyStats(u))[MODEL_FIELD] || {}).model || DEFAULT_MODEL();
  const r = await fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": decrypt(rec.enc) },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }], generationConfig: { maxOutputTokens: 5 } }),
  });
  const data = await r.json().catch(() => ({}));
  await recordKeyUse(u, { id, last4: rec.last4, name: rec.name }, { ok: r.ok, http: r.status, message: data?.error?.message, src: "uji", model });
  return keyState(u);
}

async function checkGeminiKey(k) {
  const r = await fetch(`${GEMINI_BASE}/models?pageSize=1`, { headers: { "x-goog-api-key": k } });
  if (r.ok || r.status === 429) return true; // 429 = key valid tapi sedang kena limit
  return false;
}

const cleanName = (n) => String(n || "").replace(/\s+/g, " ").trim().slice(0, 40);

async function addGeminiKey(u, value, name) {
  const k = String(value || "").trim();
  if (!/^[\w.\-]{20,200}$/.test(k)) throw new Error("Format API key tidak valid."); // key baru memakai titik (AQ.xxx), key lama AIza...
  const list = await loadKeyRecords(u);
  if (list.length >= MAX_KEYS) throw new Error(`Maksimal ${MAX_KEYS} API key.`);
  if (list.some((x) => decrypt(x.enc) === k)) throw new Error("API key ini sudah ada.");
  if (!(await checkGeminiKey(k))) throw new Error("API key ditolak Google. Cek lagi key-nya.");
  list.push({ id: uid(), enc: encrypt(k), last4: k.slice(-4), name: cleanName(name) });
  await saveKeyRecords(u, list);
  return keyState(u);
}

async function renameGeminiKey(u, id, name) {
  const list = await loadKeyRecords(u);
  const r = list.find((x) => x.id === id);
  if (!r) throw new Error("Key tidak ditemukan.");
  r.name = cleanName(name);
  await saveKeyRecords(u, list);
  return keyState(u);
}

async function deleteGeminiKey(u, id) {
  const list = await loadKeyRecords(u);
  await saveKeyRecords(u, list.filter((x) => x.id !== id));
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

// ---- Pilihan model per pengguna: utama + cadangan (opsional) ----
const cleanModel = (m) => String(m || "").trim().replace(/^models\//, "");

async function getModelCfg(u) {
  const c = (await loadKeyStats(u))[MODEL_FIELD] || {};
  return { model: c.model || "", fallback: c.fallback || "", default: DEFAULT_MODEL() };
}

async function saveModelCfg(u, model, fallback) {
  const m = cleanModel(model);
  let f = cleanModel(fallback);
  if (f === m) f = "";
  for (const x of [m, f]) if (x && !/^[\w.\-]{3,80}$/.test(x)) throw new Error("Nama model tidak valid.");
  const cands = await geminiCandidates(u);
  if (cands.length) { // cek ke Google; hanya "tidak ditemukan" yang menolak
    for (const x of [m, f]) {
      if (!x) continue;
      const r = await fetch(`${GEMINI_BASE}/models/${x}`, { headers: { "x-goog-api-key": cands[0].key } }).catch(() => null);
      if (r && r.status === 404) throw new Error(`Model "${x}" tidak ditemukan di Google. Pilih dari daftar model.`);
    }
  }
  await redis("HSET", key(u, "gstat"), MODEL_FIELD, JSON.stringify({ model: m, fallback: f }));
  return getModelCfg(u);
}

async function listGeminiModels(u) {
  const cands = await geminiCandidates(u);
  if (!cands.length) throw new Error("Tambahkan API key dulu supaya daftar model bisa dimuat.");
  const r = await fetch(`${GEMINI_BASE}/models?pageSize=200`, { headers: { "x-goog-api-key": cands[0].key } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || "Gagal memuat daftar model.");
  return (d.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => cleanModel(m.name))
    .sort();
}

// Urutan: key pengguna 1..5, lalu GEMINI_API_KEY global sebagai cadangan terakhir
async function geminiCandidates(u) {
  const out = [];
  for (const r of await loadKeyRecords(u)) {
    try { out.push({ id: r.id, last4: r.last4, name: r.name || "", key: decrypt(r.enc) }); } catch {}
  }
  if (process.env.GEMINI_API_KEY) out.push({ id: null, key: process.env.GEMINI_API_KEY });
  return out;
}

// Error yang layak dicoba dengan key berikutnya
const rotatable = (status) => status === 429 || status === 403 || status === 401 || status === 400 || status >= 500;

async function geminiRaw(u, body, src) {
  const cands = await geminiCandidates(u);
  if (!cands.length) {
    const e = new Error("Belum ada API key Gemini. Tambahkan di Pengaturan.");
    e.status = 400;
    throw e;
  }
  const st = await loadKeyStats(u); // status key + pilihan model, satu perintah Redis
  const cfg = st[MODEL_FIELD] || {};
  const models = [cfg.model || DEFAULT_MODEL()];
  if (cfg.fallback && cfg.fallback !== models[0]) models.push(cfg.fallback);
  const now = Date.now();

  // Key yang baru ditolak Google (tidak valid) dilewati 1 jam; setelah itu dicoba sekali lagi
  const usable = cands.filter((c) => {
    const s = c.id && st[c.id];
    return !(s && s.status === "invalid" && s.lastUsed && now - s.lastUsed < INVALID_SKIP_MS);
  });
  if (!usable.length) {
    const e = new Error("Semua API key ditolak Google (tidak valid). Cek di Pengaturan: tekan Test pada tiap key atau ganti key-nya.");
    e.status = 502;
    throw e;
  }

  let lastErr, modelMissing = null;
  const codes = [];
  for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi];
    // Cooldown limit berlaku per key hanya untuk model utama; model cadangan punya kuota sendiri
    let order = mi === 0 ? usable.filter((c) => !(c.id && st[c.id] && st[c.id].status === "limit" && st[c.id].until > now)) : usable;
    if (!order.length) order = usable;

    for (const c of order) {
      const r = await fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": c.key },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      await recordKeyUse(u, c, { ok: r.ok, http: r.status, message: data?.error?.message, src, model });
      if (r.ok) return data;
      codes.push(r.status);
      lastErr = new Error(data?.error?.message || "Gagal memanggil Gemini");
      lastErr.status = r.status === 429 ? 429 : 502; // jangan 401: web mengira sesi habis
      if (r.status === 404) { modelMissing = model; break; } // nama model salah: key lain pasti sama
      if (!rotatable(r.status)) break;
    }
  }

  if (modelMissing) {
    const e = new Error(`Model "${modelMissing}" tidak ditemukan. Ganti nama model di Pengaturan.`);
    e.status = 502;
    throw e;
  }
  if (codes.length && codes.every((x) => x === 429)) {
    const e = new Error("Semua API key sedang kena limit" + (models.length > 1 ? " (model cadangan juga)" : "") +
      ". Coba lagi sebentar lagi. Kalau terus begini, kuota harian mungkin habis (reset sekitar pukul 14.00 WIB); tambah key dari project lain atau ganti model di Pengaturan." +
      (lastErr && lastErr.message ? " [Pesan Google: " + String(lastErr.message).replace(/\s+/g, " ").slice(0, 200) + "]" : ""));
    e.status = 429;
    throw e;
  }
  throw lastErr;
}

async function gemini(u, system, contents, src = "telegram") {
  const body = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const data = await geminiRaw(u, body, src);
  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
}


// Obrolan dengan pencarian Google: Gemini sendiri yang memutuskan kapan perlu mencari.
// Kalau pencarian gagal/tidak didukung model, diulang tanpa pencarian supaya obrolan tetap jalan.
// Pencarian MATI secara bawaan (paket gratis Google tidak menyediakan pencarian untuk model Gemini 3).
// Nyalakan dengan env GEMINI_SEARCH=on kalau API key-nya sudah berbilling.
async function geminiSearch(u, system, contents, src = "telegram") {
  if (process.env.GEMINI_SEARCH !== "on") {
    const sys = (system || "").replace(
      /- Kamu punya akses pencarian Google\.[^\n]*\n- Pertanyaan info[^\n]*\n/,
      "- Kamu TIDAK punya akses internet/pencarian. Untuk info terkini (jadwal pertandingan, skor, kurs, harga, berita, cuaca), bilang jujur kamu tidak bisa mengeceknya dan sarankan pengguna cek di Google atau aplikasi terkait. Jangan mengarang angka, dan jangan membuat pengingat atau tugas untuk \"mengecek nanti\".\n"
    );
    return { text: await gemini(u, sys, contents, src), sources: [], searchError: "" };
  }
  const body = { contents, tools: [{ google_search: {} }] };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  let data, searchError = "";
  const NOSEARCH = "\n\n[CATATAN SISTEM: pencarian Google sedang TIDAK tersedia (kena limit/gagal). Untuk info terkini, bilang jujur bahwa pencarian lagi bermasalah dan jawaban dari pengetahuanmu mungkin tidak terbaru. JANGAN membuat pengingat atau tugas untuk \"mengecek nanti\".]";
  // Setelah pencarian gagal, berhenti mencoba 30 menit supaya tidak boros waktu/kuota di tiap pesan
  const off = await redis("GET", key(u, "searchoff")).catch(() => null);
  if (off) {
    delete body.tools;
    body.systemInstruction = { parts: [{ text: (system || "") + NOSEARCH }] };
    data = await geminiRaw(u, body, src);
  } else {
    try {
      data = await geminiRaw(u, body, src);
    } catch (e) {
      const full = String(e.message || "gagal").replace(/\s+/g, " ");
      const g = full.match(/\[Pesan Google: (.*)\]/); // tampilkan pesan asli Google kalau ada
      searchError = (g ? g[1] : full).slice(0, 200);
      await redis("SET", key(u, "searchoff"), "1", "EX", "1800").catch(() => {});
      delete body.tools;
      body.systemInstruction = { parts: [{ text: (system || "") + NOSEARCH }] };
      data = await geminiRaw(u, body, src);
    }
  }
  const cand = data.candidates?.[0] || {};
  const text = (cand.content?.parts || []).map((p) => p.text || "").join("");
  const seen = new Set();
  const sources = [];
  for (const c of cand.groundingMetadata?.groundingChunks || []) {
    const name = c.web && (c.web.title || "").trim();
    if (name && !seen.has(name.toLowerCase())) { seen.add(name.toLowerCase()); sources.push(name); }
  }
  return { text, sources: sources.slice(0, 3), searchError };
}
// Pengingat hanya dibuat kalau pesan pengguna memang menyiratkan waktu/permintaan diingatkan.
// Mencegah AI membuat pengingat sendiri (mis. "cek kurs") untuk pertanyaan biasa.
const REMIND_INTENT = /ing[ae]t|remind|tanggal\s*\d|tgl\.?\s*\d|alarm|bangun|jangan lupa|pengingat|notif|kabari|kasih tau|kasih tahu|tiap|setiap|\bjam\b|\d{1,2}[:.]\d{2}|menit lagi|detik lagi|besok|lusa|nanti|minggu depan|bulan depan/i;
// Pengingat hanya dihapus kalau pesan pengguna memang meminta menghapus/membatalkan.
const DELETE_INTENT = /hapus|batal|cancel|buang|hilangkan|g[ae]k usah|nggak usah|ga usah|tidak usah|tak usah/i;
const sourceLine = (sources, searchError) =>
  searchError ? "⚠️ Pencarian Google lagi gagal, jadi jawaban ini tanpa pencarian. Dicoba lagi otomatis 30 menit lagi.\nAlasan: " + searchError
  : sources && sources.length ? "🔎 Sumber: " + sources.join(", ") : "";

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

async function appendModelToHist(u, text, mode = "asisten") {
  const hist = await getHist(u, mode);
  hist.push({ role: "model", parts: [{ text }], ts: Date.now() });
  await saveHist(u, hist, mode);
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
// Waktu dari Gemini/web: kalau tidak ada offset zona, anggap WIB (server Vercel berjalan di UTC)
function parseWib(str) {
  let t = String(str || "").trim();
  if (!t) return NaN;
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(t)) t += "+07:00";
  return Date.parse(t);
}
function fmtDue(ts) {
  return new Date(ts).toLocaleString("id-ID", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) + " WIB";
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
// Tugas boleh punya jam (ts). Kalau ada, dibuat pengingat yang terhubung (reminder.tid = task.id, task.rid = reminder.id).
async function addTask(u, text, ts) {
  const tasks = await getTasks(u);
  const item = { id: uid(), text: String(text).trim().slice(0, 300), done: false };
  if (!item.text) return null;
  const when = Number(ts);
  if (ts && Number.isFinite(when) && when > Date.now()) {
    const r = await addReminder(u, item.text, when, null, item.id);
    if (r) { item.due = when; item.rid = r.id; }
  }
  tasks.push(item);
  await saveTasks(u, tasks);
  return item;
}
async function toggleTask(u, id) {
  const tasks = await getTasks(u);
  const t = tasks.find((x) => x.id === id);
  if (!t) return null;
  t.done = !t.done;
  if (t.done) {
    if (t.rid) { await deleteReminderById(u, t.rid, false); t.rid = null; } // selesai: pengingat dibatalkan
  } else if (t.due && t.due > Date.now()) {
    const r = await addReminder(u, t.text, t.due, null, t.id);             // dibuka lagi & jamnya belum lewat
    t.rid = r ? r.id : null;
  }
  await saveTasks(u, tasks);
  return t;
}
async function deleteTask(u, id) {
  const tasks = await getTasks(u);
  const t = tasks.find((x) => x.id === id);
  if (!t) return false;
  if (t.rid) await deleteReminderById(u, t.rid, false);
  await saveTasks(u, tasks.filter((x) => x.id !== id));
  return true;
}
// Pengingat tugas dihapus langsung (bukan lewat tugas): lepas tautan di tugasnya
async function unlinkTaskReminder(u, tid) {
  const tasks = await getTasks(u);
  const t = tasks.find((x) => x.id === tid);
  if (t && (t.rid || t.due)) { delete t.rid; delete t.due; await saveTasks(u, tasks); }
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
// Hapus satu entri dengan LREM (atomik): tidak lagi "hapus semua lalu tulis ulang", jadi entri baru yang masuk bersamaan aman.
async function removeFromList(k, pred) {
  const rows = (await redis("LRANGE", k, 0, -1)) || [];
  const raw = rows.find((r) => { try { return pred(JSON.parse(r)); } catch { return false; } });
  if (raw === undefined) return false;
  return Number(await redis("LREM", k, "1", raw)) > 0;
}
async function deleteNoteById(u, id) {
  return removeFromList(key(u, "notes"), (n) => n.id === id);
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
  return removeFromList(key(u, "exp:" + (monthKey || wib().monthKey)), (e) => e.id === id);
}

// ---------- Pemasukan (dipakai bareng web & Telegram) ----------
async function addIncome(u, amt, cat, note) {
  const n = Math.round(Number(amt));
  if (!Number.isFinite(n) || n <= 0 || n > 1e12) return null;
  const item = { id: uid(), ts: Date.now(), amt: n, cat: String(cat || "lainnya").toLowerCase().slice(0, 20), note: String(note || "").slice(0, 100) };
  await redis("RPUSH", key(u, "inc:" + wib().monthKey), JSON.stringify(item));
  return item;
}
async function getIncomes(u, monthKey) {
  const rows = await redis("LRANGE", key(u, "inc:" + (monthKey || wib().monthKey)), 0, -1);
  return (rows || []).map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
}
async function deleteIncomeById(u, id, monthKey) {
  return removeFromList(key(u, "inc:" + (monthKey || wib().monthKey)), (e) => e.id === id);
}
async function incomesSince(u, fromTs) {
  const keys = new Set([wib(fromTs).monthKey, wib().monthKey]);
  const all = [];
  for (const k of keys) {
    const rows = await redis("LRANGE", key(u, "inc:" + k), 0, -1);
    for (const r of rows || []) { try { all.push(JSON.parse(r)); } catch {} }
  }
  return all.filter((e) => e.ts >= fromTs).sort((a, b) => a.ts - b.ts);
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
    out.push({ id: it.id || "t" + ts, text: it.text || "?", ts, repeat: it.repeat || null, tid: it.tid || null });
  }
  return out;
}
async function addReminder(u, text, ts, repeat, tid) {
  const t = String(text || "").trim().slice(0, 200);
  const when = Number(ts);
  if (!t || !Number.isFinite(when) || when <= Date.now()) return null;
  const item = { id: uid(), text: t };
  if (REPEATS.includes(repeat)) item.repeat = repeat;
  if (tid) item.tid = tid;
  await redis("ZADD", key(u, "reminders"), when, JSON.stringify(item));
  return { id: item.id, text: item.text, ts: when, repeat: item.repeat || null };
}
async function deleteReminderById(u, id, unlink = true) {
  const rows = await redis("ZRANGE", key(u, "reminders"), 0, -1, "WITHSCORES");
  for (let i = 0; i < (rows || []).length; i += 2) {
    let it = {};
    try { it = JSON.parse(rows[i]); } catch {}
    if ((it.id || "t" + Number(rows[i + 1])) === id) {
      await redis("ZREM", key(u, "reminders"), rows[i]);
      if (unlink && it.tid) await unlinkTaskReminder(u, it.tid);
      return true;
    }
  }
  return false;
}

// Hapus pengingat berdasarkan nomor di daftar (urutan sama dengan /pengingat dan panel). Mengembalikan teksnya, atau null.
async function deleteReminderNumber(u, n) {
  const list = await getReminders(u);
  const r = list[Number(n) - 1];
  if (!r) return null;
  return (await deleteReminderById(u, r.id)) ? r : null;
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
// Mode curhat otomatis kembali ke asisten kalau tidak dipakai CURHAT_TTL detik (kuncinya diberi kedaluwarsa).
const CURHAT_TTL = 6 * 3600;
async function getMode(u) {
  const m = await redis("GET", key(u, "mode"));
  return m === "curhat" ? "curhat" : "asisten";
}
async function setMode(u, m) {
  const mode = m === "curhat" ? "curhat" : "asisten";
  if (mode === "curhat") {
    await redis("SET", key(u, "mode"), mode, "EX", String(CURHAT_TTL));
    await redis("SET", key(u, "curhatflag"), "1"); // penanda tanpa kedaluwarsa: kalau mode hilang tapi penanda ada, berarti kedaluwarsa sendiri
  } else {
    await redis("SET", key(u, "mode"), mode);
    await redis("DEL", key(u, "curhatflag")); // keluar dengan sengaja: tidak perlu pemberitahuan
  }
  return mode;
}

// Dipanggil saat ada pesan di mode asisten. Kalau mode curhat baru saja kedaluwarsa sendiri, kembalikan pemberitahuan (sekali saja).
async function takeCurhatExpiredNotice(u) {
  if (!(await redis("GET", key(u, "curhatflag")))) return "";
  await redis("DEL", key(u, "curhatflag"));
  const kept = await hasHist(u, "curhat");
  return "ℹ️ Mode curhat sudah berakhir karena lama tidak dipakai, jadi pesanmu barusan kuanggap pesan asisten." +
    (kept ? " Obrolan curhat yang kamu simpan masih ada." : "") + " Ketik /curhat kalau mau lanjut curhat.";
}

// ---------- Riwayat obrolan: satu riwayat per mode ----------
// asisten -> u:<id>:hist (dipakai bareng web & Telegram)
// curhat  -> u:<id>:hist:curhat (otomatis terhapus kalau tidak dipakai CURHAT_TTL, kecuali pengguna memilih "Simpan dulu")
const histKey = (u, mode) => key(u, mode === "curhat" ? "hist:curhat" : "hist");
async function getHist(u, mode = "asisten") {
  const raw = await redis("GET", histKey(u, mode));
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}
async function saveHist(u, hist, mode = "asisten") {
  const val = JSON.stringify(hist.slice(-60));
  if (mode !== "curhat") { await redis("SET", histKey(u, mode), val); return; }
  const keep = await redis("GET", key(u, "curhatkeep"));
  if (keep) await redis("SET", histKey(u, mode), val);                       // sengaja disimpan: tanpa kedaluwarsa
  else await redis("SET", histKey(u, mode), val, "EX", String(CURHAT_TTL));  // jaring pengaman: hilang sendiri
  await redis("EXPIRE", key(u, "mode"), String(CURHAT_TTL));                 // mode curhat kembali ke asisten kalau lama tidak dipakai
}
async function hasHist(u, mode) {
  return Number(await redis("EXISTS", histKey(u, mode))) > 0;
}
async function clearHist(u, mode) {
  await redis("DEL", histKey(u, mode));
  if (mode === "curhat") await redis("DEL", key(u, "curhatkeep"));
}

// Pindah mode. Keluar dari curhat yang masih punya riwayat butuh keputusan: action = "delete" | "keep".
// Tanpa action, tidak ada yang berubah dan hasilnya {needConfirm: true}.
async function switchMode(u, to, action) {
  const target = to === "curhat" ? "curhat" : "asisten";
  const cur = await getMode(u);
  if (cur === "curhat" && target === "asisten") {
    const has = await hasHist(u, "curhat");
    if (has && action !== "delete" && action !== "keep") return { needConfirm: true, mode: cur };
    if (action === "delete") await clearHist(u, "curhat");
    else if (action === "keep" && has) {
      await redis("SET", key(u, "curhatkeep"), "1");
      await redis("PERSIST", histKey(u, "curhat"));
    }
  }
  const resumed = target === "curhat" && cur !== "curhat" && (await hasHist(u, "curhat"));
  await setMode(u, target);
  return { mode: target, resumed, changed: cur !== target, deleted: action === "delete" };
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

async function recapText(u, interactive = false) {
  const now = Date.now();
  const w = wib(now);
  const weekStart = startOfDayWib(now) - ((w.weekday + 6) % 7) * DAY; // Senin
  const monthStart = Date.UTC(w.y, w.m - 1, 1) - 7 * HOUR;
  const all = await expensesSince(u, Math.min(weekStart, monthStart));
  const week = all.filter((e) => e.ts >= weekStart);
  const month = all.filter((e) => e.ts >= monthStart);
  const incMonth = (await incomesSince(u, monthStart)).filter((e) => e.ts >= monthStart);
  if (!month.length && !incMonth.length) {
    return { text: "💰 Uang\n\nBelum ada pemasukan atau pengeluaran tercatat bulan ini.\n\nCara mencatat, ketik:\n  makan siang 25rb\n  bensin 50rb\n  gajian 3jt", weekCount: 0, monthCount: 0 };
  }
  const sg = (n) => (n < 0 ? "-" : "") + rupiah(Math.abs(n));
  const incTotal = incMonth.reduce((t, e) => t + e.amt, 0);
  const bw = breakdown(week), bm = breakdown(month);
  const remaining = (await moneySummary(u)).remaining;

  const parts = [];
  parts.push("💰 Uang bulan ini");
  parts.push(
    `💵 Pemasukan: ${rupiah(incTotal)} (${incMonth.length})\n` +
    `💸 Pengeluaran: ${rupiah(bm.total)} (${month.length})\n` +
    `⚖️ Selisih: ${sg(incTotal - bm.total)}` +
    (remaining != null ? `\n👛 Sisa uang: ${sg(remaining)}` : "")
  );
  if (month.length) {
    parts.push("📊 Pengeluaran per kategori\n" + bm.lines.map((l) => l.replace(/^\s*-\s*/, "• ")).join("\n"));
    if (week.length) parts.push(`📅 Minggu ini: ${rupiah(bw.total)} (${week.length} transaksi)`);
    const base = Math.max(0, month.length - 8); // nomor = urutan di bulan ini, dipakai /hapusbeli N
    const last = month.slice(-8).map((e, i) => `${base + i + 1}. ${fmtDateShort(e.ts)} · ${e.note || e.cat} · ${rupiah(e.amt)}`);
    parts.push("🧾 Pengeluaran terakhir\n" + last.join("\n"));
  }
  if (incMonth.length) {
    const lastIn = incMonth.slice(-3).map((e) => `• ${fmtDateShort(e.ts)} · ${e.note || e.cat} · ${rupiah(e.amt)}`);
    parts.push("💵 Pemasukan terakhir\n" + lastIn.join("\n"));
  }
  const hint = [];
  if (month.length) hint.push(interactive ? "Hapus pengeluaran: balas nomornya (contoh: 2)." : "Hapus pengeluaran: ketik /rekap, lalu balas nomornya.");
  if (incMonth.length) hint.push("Lihat atau hapus pemasukan: /masuk.");
  if (interactive && month.length) hint.push("Batal: /batal");
  if (hint.length) parts.push(hint.join("\n"));
  return { text: parts.join("\n\n"), weekCount: week.length, monthCount: month.length };
}

// Hapus pengeluaran bulan ini berdasarkan nomor di daftar /rekap (n kosong = yang terakhir)
async function deleteExpenseNumber(u, n) {
  const w = wib();
  const month = await expensesSince(u, Date.UTC(w.y, w.m - 1, 1) - 7 * HOUR);
  if (!month.length) return { empty: true };
  const idx = n ? n - 1 : month.length - 1;
  if (idx < 0 || idx >= month.length) return { range: month.length };
  const item = month[idx];
  return (await deleteExpenseById(u, item.id)) ? { item } : { fail: true };
}

// Daftar pemasukan bulan ini, bernomor (dipakai /masuk, /hapusmasuk, dan balasan angka setelah /masuk)
async function incomeListText(u, interactive = false) {
  const w = wib();
  const monthStart = Date.UTC(w.y, w.m - 1, 1) - 7 * HOUR;
  const month = (await incomesSince(u, monthStart)).filter((e) => e.ts >= monthStart);
  if (!month.length) {
    return { text: "💵 Pemasukan\n\nBelum ada pemasukan tercatat bulan ini.\n\nCara mencatat, ketik:\n  gajian 3jt\n  dapat bonus 500rb", count: 0 };
  }
  const total = month.reduce((s, e) => s + e.amt, 0);
  const base = Math.max(0, month.length - 10);
  const last = month.slice(-10).map((e, i) => `  ${base + i + 1}. ${fmtDateShort(e.ts)}: ${e.note || e.cat}, ${rupiah(e.amt)} (${e.cat})`);
  const text =
    `💵 Pemasukan\n\nBulan ini: ${rupiah(total)} (${month.length} transaksi)\n\n${last.join("\n")}\n\n` +
    (interactive
      ? "Ada yang salah catat? Balas dengan nomornya saja (contoh: 2) untuk menghapus entri itu. Batal: /batal"
      : "Salah catat? Ketik /masuk, lalu balas dengan nomor entri yang mau dihapus.");
  return { text, count: month.length };
}

// Hapus pemasukan bulan ini berdasarkan nomor di daftar /masuk (n kosong = yang terakhir)
async function deleteIncomeNumber(u, n) {
  const w = wib();
  const monthStart = Date.UTC(w.y, w.m - 1, 1) - 7 * HOUR;
  const month = (await incomesSince(u, monthStart)).filter((e) => e.ts >= monthStart);
  if (!month.length) return { empty: true };
  const idx = n ? n - 1 : month.length - 1;
  if (idx < 0 || idx >= month.length) return { range: month.length };
  const item = month[idx];
  return (await deleteIncomeById(u, item.id)) ? { item } : { fail: true };
}

// ---------- Saldo & ringkasan uang untuk Gemini ----------
// Saldo = angka terakhir yang disebut pengguna; sisa = saldo + pemasukan - pengeluaran tercatat sejak saat itu.
async function getSaldo(u) {
  const raw = await redis("GET", key(u, "saldo"));
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}
async function setSaldo(u, amt) {
  const n = Math.round(Number(amt));
  if (!Number.isFinite(n) || n < 0 || n > 1e12) return null;
  const item = { amt: n, ts: Date.now() };
  await redis("SET", key(u, "saldo"), JSON.stringify(item));
  return item;
}
async function moneySummary(u) {
  const [exp, inc, saldo] = await Promise.all([getExpenses(u), getIncomes(u), getSaldo(u)]);
  const expense = exp.reduce((s, e) => s + e.amt, 0);
  const income = inc.reduce((s, e) => s + e.amt, 0);
  let remaining = null;
  if (saldo) {
    const [e2, i2] = await Promise.all([expensesSince(u, saldo.ts), incomesSince(u, saldo.ts)]);
    remaining = saldo.amt + i2.reduce((s, e) => s + e.amt, 0) - e2.reduce((s, e) => s + e.amt, 0);
  }
  return { income, expense, net: income - expense, saldo: saldo ? saldo.amt : null, saldoTs: saldo ? saldo.ts : null, remaining };
}
async function moneyContext(u) {
  const [month, incs, saldo] = await Promise.all([getExpenses(u), getIncomes(u), getSaldo(u)]);
  let out;
  if (!month.length) out = "Belum ada pengeluaran tercatat bulan ini.";
  else {
    const b = breakdown(month);
    const cats = b.lines.map((l) => l.replace(/^\s*-\s*/, "")).join(", ");
    const last = month.slice(-5).map((e) => (e.note || e.cat) + " " + rupiah(e.amt)).join("; ");
    out = `Bulan ini total ${rupiah(b.total)} (${month.length} transaksi). Per kategori: ${cats}. Terakhir: ${last}.`;
  }
  const expTotal = month.reduce((s, e) => s + e.amt, 0);
  if (incs.length) {
    const it = incs.reduce((s, e) => s + e.amt, 0);
    const lastIn = incs.slice(-5).map((e) => (e.note || e.cat) + " " + rupiah(e.amt)).join("; ");
    const net = it - expTotal;
    out += `\nPemasukan bulan ini: ${rupiah(it)} (${incs.length} transaksi). Terakhir: ${lastIn}. Selisih pemasukan - pengeluaran bulan ini: ${net < 0 ? "-" : ""}${rupiah(Math.abs(net))}.`;
  } else {
    out += "\nBelum ada pemasukan tercatat bulan ini.";
  }
  if (saldo) {
    const [e2, i2] = await Promise.all([expensesSince(u, saldo.ts), incomesSince(u, saldo.ts)]);
    const spent = e2.reduce((s, e) => s + e.amt, 0), got = i2.reduce((s, e) => s + e.amt, 0);
    out += `\nSaldo yang diberitahu pengguna: ${rupiah(saldo.amt)} (dicatat ${fmtWib(saldo.ts)}). ` +
      `Sejak itu pemasukan tercatat ${rupiah(got)} dan pengeluaran tercatat ${rupiah(spent)}. Perkiraan sisa uang: ${rupiah(saldo.amt + got - spent)} ` +
      `(kalau pengguna menyebut saldo terbaru, catat ulang dengan tag SALDO).`;
  } else {
    out += "\nSaldo awal pengguna BELUM diketahui. Jangan menebak sisa uang; kalau ditanya sisa uang, minta pengguna menyebut uangnya sekarang, lalu catat dengan tag SALDO.";
  }
  return out;
}

// ---------- Konteks & prompt ----------
async function loadContext(u) {
  const [facts, rows, profile, tasks, notes, money] = await Promise.all([
    redis("LRANGE", key(u, "facts"), 0, -1),
    redis("ZRANGE", key(u, "reminders"), 0, 9, "WITHSCORES"),
    getProfile(u), getTasks(u), getNotes(u), moneyContext(u),
  ]);
  const reminders = [];
  for (let i = 0; i < (rows || []).length; i += 2) {
    let it = {};
    try { it = JSON.parse(rows[i]); } catch {}
    reminders.push({ text: it.text || "?", ts: Number(rows[i + 1]), repeat: it.repeat });
  }
  return { facts: facts || [], reminders, profile, tasks, notes, money };
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
  Waktu format ISO 8601 dengan +07:00, dihitung dari waktu sekarang (ubah "besok", "lusa", "2 jam lagi" jadi waktu pasti). Jika pengguna menyebut hari/tanggal tanpa jam (mis. bayar wifi tanggal 10), pakai jam 08:00. Kalau cuma tanggal tanpa bulan, pakai tanggal itu yang terdekat dan belum lewat. Tagihan/cicilan/langganan atau kata tiap bulan dibuat bulanan. Kalau waktunya benar-benar tidak jelas (tanpa jam DAN tanpa hari), tanyakan dulu dan jangan buat tag. Jangan pernah bilang akan mengingatkan kalau kamu tidak membuat tag REMIND.
  Pengingat berulang: tambahkan bagian ketiga harian / mingguan / bulanan, contoh [[REMIND: 2026-10-13T09:00:00+07:00 | rapat tim | mingguan]]. Waktu = kemunculan pertama.
- Pengeluaran yang sudah terjadi (mis. "makan siang 25rb", "beli bensin 50 ribu", atau foto struk/nota): [[BELI: 25000 | makan | makan siang]]
  Jumlah rupiah angka bulat tanpa titik ("25rb" = 25000, "1,5jt" = 1500000). Kategori satu kata: makan, transport, belanja, tagihan, hiburan, kesehatan, lainnya. Untuk struk cukup satu tag berisi total.
- Pemasukan / uang masuk yang sudah terjadi (mis. "gajian 3jt", "dapat bonus 500rb", "dikasih ortu 200rb"): [[MASUK: 3000000 | gaji | gajian]]
  Format angka sama seperti BELI. Kategori satu kata: gaji, bonus, usaha, hadiah, lainnya. Jangan pakai MASUK untuk pengeluaran, dan jangan pakai SALDO untuk uang masuk baru (SALDO hanya untuk saat pengguna menyebut total uangnya sekarang).
- Saldo/uang yang dimiliki pengguna sekarang (mis. \"uangku sekarang 500rb\", \"saldo 1,2jt\"): [[SALDO: 500000]]. Angka bulat tanpa titik. Sisa uang dihitung dari saldo dikurangi pengeluaran yang tercatat setelahnya.
- Tugas/checklist (pekerjaan yang perlu dikerjakan): [[TASK: isi tugas singkat]]
  Kalau pengguna menyebut jam/hari untuk tugas itu (mis. "nyuci piring besok jam 7"), tambahkan waktu: [[TASK: nyuci piring | 2026-10-13T07:00:00+07:00]]. Tugas berjam otomatis jadi pengingat yang bunyi tepat waktu dan dibatalkan kalau tugasnya dicentang selesai. Jangan buat TASK dan REMIND sekaligus untuk hal yang sama.
  Pakai REMIND hanya untuk pengingat murni yang bukan tugas (minum obat, rapat, tagihan) atau yang berulang.
- Fakta jangka panjang tentang pengguna (nama, orang penting, kebiasaan, preferensi, hal besar yang sedang dihadapi): [[INGAT: fakta singkat]]. Jangan simpan detail yang sangat sensitif kecuali pengguna memintanya.
- Catatan jika pengguna minta mencatat sesuatu: [[CATAT: isi catatan]]
  JANGAN buat CATAT atau TASK untuk permintaan menghapus/menyelesaikan. Kata seperti "hapus" bukan isi catatan.
- Pengingat BISA dihapus lewat tag [[HAPUS_PENGINGAT: N]] (N = nomor di daftar Pengingat mendatang). Buat tag ini hanya kalau pengguna jelas minta menghapus/membatalkan dan jelas pengingat yang mana; kalau belum jelas, tanyakan dulu. Jangan pernah bilang sudah dihapus tanpa tag ini: sistem menulis baris 🗑️ kalau berhasil.
- Kamu TIDAK bisa menghapus catatan, tugas, pengeluaran, atau pemasukan. Jika pengguna minta menghapus, jangan bilang sudah dihapus dan jangan buat tag apa pun; arahkan: catatan -> ketik /hapuscatatan lalu balas nomornya; pengeluaran -> /rekap lalu balas nomornya (atau ketik "hapus pengeluaran 3"); pemasukan -> /masuk lalu balas nomornya (atau ketik "hapus pemasukan 3"); tugas -> /hapustugas lalu balas nomornya (menandai selesai: /tugasdone); pengingat -> /hapus N.
- Kamu punya akses pencarian Google. Untuk hal yang terkini atau bisa berubah (jadwal pertandingan, skor, harga, berita, cuaca, hasil, tanggal rilis), cari dulu lalu jawab; jangan bilang kamu tidak bisa browsing. Jawab ringkas dan sebut waktu/tanggal datanya kalau penting. Hasil pencarian tidak perlu dicatat kecuali pengguna minta.
- Pertanyaan info (kurs, jadwal, harga, berita, dll) dijawab SEKARANG dalam balasan yang sama. Jangan bilang "sebentar aku cek" lalu membuat pengingat atau tugas; REMIND hanya kalau pengguna jelas minta diingatkan.
- Buat tag HANYA untuk permintaan di pesan pengguna yang TERBARU. Permintaan di pesan-pesan sebelumnya sudah diproses; jangan mengulang tagnya. Baris berawalan ⏰ ✅ 🗒️ 💰 💵 🗑️ di akhir balasanmu sebelumnya ditulis otomatis oleh sistem setelah tag berhasil diproses; itu tandanya permintaan tersebut SUDAH SELESAI. Jangan menulis baris seperti itu sendiri.
- Satu tag per hal. Jangan membuat tag kalau tidak perlu. Jika pengguna mengirim foto, lihat isinya dan tanggapi sesuai konteks.
- Pesan yang diawali [Pesan otomatis sistem] adalah instruksi dari sistem untuk menulis pesan proaktif, bukan dari pengguna.`;

function buildSystem(mode, ctx) {
  const tasks = (ctx.tasks || []).length
    ? ctx.tasks.slice(-40).map((t, i) => `${i + 1}. ${t.done ? "[selesai]" : "[belum]"} ${t.text}${t.due ? " (jam " + fmtWib(t.due) + ")" : ""}`).join("\n")
    : "(kosong)";
  const notes = (ctx.notes || []).length ? ctx.notes.slice(-20).map((n) => "- " + n.text).join("\n") : "(kosong)";
  const persona = mode === "curhat" ? PERSONA.curhat : PERSONA.asisten;
  const rem = ctx.reminders.length
    ? ctx.reminders
        .map((r, i) => `${i + 1}. ${r.text} (${fmtWib(r.ts)})${r.repeat ? " [berulang: " + r.repeat + "]" : ""}`)
        .join("\n")
    : "(belum ada)";
  return `${persona}

Waktu sekarang: ${fmtWib(Date.now())}. Zona waktu pengguna: WIB (UTC+07:00).

Nama kamu: ${(ctx.profile && ctx.profile.assistantName) || "Asisten"}. Pengguna bernama: ${(ctx.profile && ctx.profile.name) || "(belum diisi)"}.
Catatan tentang pengguna: ${(ctx.profile && ctx.profile.notes) || "(belum ada)"}.

Yang kamu ingat tentang pengguna:
${ctx.facts.length ? ctx.facts.map((f) => "- " + f).join("\n") : "(belum ada)"}

Pengingat mendatang pengguna:
${rem}

Daftar tugas pengguna:
${tasks}

Catatan pengguna (terbaru):
${notes}

Uang pengguna (jawab pertanyaan soal uang hanya dari data ini, jangan mengarang angka):
${ctx.money || "(tidak ada data)"}

${COMMON}`;
}

// ---------- Mode curhat: prompt & konteks sendiri ----------
// Sengaja TIDAK memuat tugas, catatan, pengingat, uang, dan petunjuk tag, supaya balasan tidak berasa asisten kerja
// dan tidak ada yang tercatat otomatis dari isi curhat. Memori jangka panjang hanya dibaca, tidak pernah ditulis.
const CURHAT_RULES = `Aturan:
- Tulis teks biasa, tanpa markdown (tanpa * atau #). Emoji boleh secukupnya.
- Jangan memberi diagnosis medis.
- Jika ada tanda pengguna ingin menyakiti diri, ingin mengakhiri hidup, atau dalam bahaya: tanggapi dengan tenang dan sungguh-sungguh, tanyakan langsung apakah dia aman sekarang, jangan menghakimi, dorong dia menghubungi orang terdekat yang dipercaya dan layanan darurat/kesehatan jiwa setempat (Indonesia: 112 untuk darurat; 119 ekstensi 8 untuk layanan kesehatan jiwa Kemenkes), dan tetap temani dia bicara. Jangan memberi informasi cara menyakiti diri.
- Di mode curhat tidak ada pencatatan apa pun: kamu tidak membuat tugas, pengingat, catatan, pengeluaran, atau ingatan baru. Jangan menulis tag atau kode dalam kurung siku ganda. Kalau pengguna minta dicatat atau diingatkan sesuatu, bilang dengan ramah bahwa itu bisa dilakukan setelah pindah ke mode asisten.
- Kamu tidak punya akses internet. Jangan mengarang info terkini.
- Obrolan curhat ini terpisah dari mode asisten dan tidak ikut disimpan ke tempat lain. Kalau ditanya, begitu penjelasannya.`;

async function loadCurhatContext(u) {
  const [facts, profile] = await Promise.all([redis("LRANGE", key(u, "facts"), 0, -1), getProfile(u)]);
  return { facts: facts || [], profile };
}

function buildCurhatSystem(ctx) {
  const p = (ctx && ctx.profile) || {};
  const facts = (ctx && ctx.facts) || [];
  return `${PERSONA.curhat}

Waktu sekarang: ${fmtWib(Date.now())}.

Nama kamu: ${p.assistantName || "Asisten"}. Pengguna bernama: ${p.name || "(belum diisi)"}.
Catatan tentang pengguna: ${p.notes || "(belum ada)"}.

Hal yang kamu ingat tentang pengguna (hanya untuk membuatmu nyambung, jangan disebut-sebut kalau tidak relevan):
${facts.length ? facts.map((f) => "- " + f).join("\n") : "(belum ada)"}

${CURHAT_RULES}`;
}

// Buang tag [[...]] kalau model nekat menulisnya; di mode curhat tag tidak pernah diproses
const stripTags = (t) => String(t || "").replace(/\[\[[A-Z_]+:[\s\S]*?\]\]/g, "").trim();

module.exports = {
  TZ, DAY, HOUR, HOURS, BTN,
  uid, key, MAX_KEYS, getBot, saveBot, setupBot, removeBot, relinkBot, botStatus, botUsers, listGeminiKeys, getModelCfg, saveModelCfg, listGeminiModels, keyState, quotaStatus, getKeyHistory, clearKeyHistory, testGeminiKey, addGeminiKey, renameGeminiKey, deleteGeminiKey, moveGeminiKey,
  redis, tg, sendTelegram, downloadTelegramFile, gemini, geminiRaw, geminiSearch, sourceLine, REMIND_INTENT, trimHist, appendModelToHist,
  fmtWib, fmtTime, fmtDateShort, wib, startOfDayWib, nextRepeat, rupiah,
  cfgOn, getLocation, setLocation, getWeather, getNews,
  recapText, deleteExpenseNumber, loadContext, buildSystem, loadCurhatContext, buildCurhatSystem, stripTags,
  getTasks, addTask, toggleTask, deleteTask, unlinkTaskReminder, parseWib, fmtDue,
  getNotes, addNote, deleteNoteById,
  getExpenses, addExpense, deleteExpenseById, getSaldo, setSaldo, moneyContext,
  getIncomes, addIncome, deleteIncomeById, incomesSince, moneySummary, incomeListText, deleteIncomeNumber,
  getProfile, saveProfile,
  getMode, setMode, switchMode, takeCurhatExpiredNotice, CURHAT_TTL,
  getHist, saveHist, hasHist, clearHist,
  getReminders, addReminder, deleteReminderById, deleteReminderNumber, DELETE_INTENT,
};
