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

// Baca balasan streaming (SSE) dari Gemini; onText dipanggil tiap ada potongan teks baru.
// Hasil digabung ke bentuk yang sama dengan respons biasa supaya pemanggil lain tidak perlu berubah.
async function readGeminiStream(r, onText) {
  const dec = new TextDecoder();
  let buf = "", text = "", grounding = null, finish = "";
  const handle = (line) => {
    if (!line.startsWith("data:")) return;
    const raw = line.slice(5).trim();
    if (!raw) return;
    let j; try { j = JSON.parse(raw); } catch { return; }
    if (j.error) { const e = new Error(j.error.message || "Gagal memanggil Gemini"); e.status = 502; throw e; }
    const cand = (j.candidates || [])[0] || {};
    const piece = ((cand.content || {}).parts || []).map((p) => p.text || "").join("");
    if (cand.groundingMetadata) grounding = cand.groundingMetadata;
    if (cand.finishReason) finish = cand.finishReason;
    if (piece) { text += piece; onText(piece); }
  };
  try {
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.search(/\r?\n/)) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(buf[i] === "\r" && buf[i + 1] === "\n" ? i + 2 : i + 1);
        handle(line);
      }
    }
    buf += dec.decode();
    if (buf) handle(buf);
  } catch (e) {
    e.partial = text.length > 0; // sebagian teks sudah terkirim ke pengguna: jangan diulang dengan key lain
    if (!e.status) e.status = 502;
    throw e;
  }
  const cand = { content: { parts: [{ text }] }, finishReason: finish };
  if (grounding) cand.groundingMetadata = grounding;
  return { candidates: [cand] };
}

async function geminiRaw(u, body, src, onText) {
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
      const streaming = typeof onText === "function";
      const r = await fetch(`${GEMINI_BASE}/models/${model}:${streaming ? "streamGenerateContent?alt=sse" : "generateContent"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": c.key },
        body: JSON.stringify(body),
      });
      if (streaming && r.ok) { // koneksi berhasil: catat pemakaian lalu alirkan teksnya
        await recordKeyUse(u, c, { ok: true, http: r.status, message: "", src, model });
        return readGeminiStream(r, onText);
      }
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

async function gemini(u, system, contents, src = "telegram", onText) {
  const body = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const data = await geminiRaw(u, body, src, onText);
  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
}


// Obrolan dengan pencarian Google: Gemini sendiri yang memutuskan kapan perlu mencari.
// Kalau pencarian gagal/tidak didukung model, diulang tanpa pencarian supaya obrolan tetap jalan.
// Pencarian MATI secara bawaan (paket gratis Google tidak menyediakan pencarian untuk model Gemini 3).
// Nyalakan dengan env GEMINI_SEARCH=on kalau API key-nya sudah berbilling.
async function geminiSearch(u, system, contents, src = "telegram", onText) {
  if (process.env.GEMINI_SEARCH !== "on") {
    const sys = (system || "").replace(
      /- Kamu punya akses pencarian Google\.[^\n]*\n- Pertanyaan info[^\n]*\n/,
      "- Kamu TIDAK punya akses internet/pencarian. Untuk info terkini (jadwal pertandingan, skor, kurs, harga, berita, cuaca), bilang jujur kamu tidak bisa mengeceknya dan sarankan pengguna cek di Google atau aplikasi terkait. Jangan mengarang angka, dan jangan membuat pengingat atau tugas untuk \"mengecek nanti\".\n"
    );
    return { text: await gemini(u, sys, contents, src, onText), sources: [], searchError: "" };
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
    data = await geminiRaw(u, body, src, onText);
  } else {
    try {
      data = await geminiRaw(u, body, src, onText);
    } catch (e) {
      if (e.partial) throw e; // teks sudah sebagian tampil; mengulang akan menggandakan jawaban
      const full = String(e.message || "gagal").replace(/\s+/g, " ");
      const g = full.match(/\[Pesan Google: (.*)\]/); // tampilkan pesan asli Google kalau ada
      searchError = (g ? g[1] : full).slice(0, 200);
      await redis("SET", key(u, "searchoff"), "1", "EX", "1800").catch(() => {});
      delete body.tools;
      body.systemInstruction = { parts: [{ text: (system || "") + NOSEARCH }] };
      data = await geminiRaw(u, body, src, onText);
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
const DELETE_INTENT = /hapus|batal|cancel|buang|hilangkan|g[ae]k usah|nggak usah|ga usah|tidak usah|tak usah|(?:ng)?g[ae]k jadi|(?:ng)?ga jadi|tidak jadi|tak jadi|salah (?:catat|input|nulis|ketik)|keliru/i;
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
// Aturan interval ditulis "<menit>m", mis. "5m" = tiap 5 menit (dibuat dari "tiap 5 menit" / "tiap 2 jam")
function parseRepeat(str) {
  const t = String(str || "").trim().toLowerCase();
  if (["harian", "mingguan", "bulanan"].includes(t)) return t;
  const m = t.match(/^(?:tiap|setiap|every)?\s*(\d+)\s*(menit|mnt|m|jam|j|h)$/);
  if (!m) return null;
  const mins = Number(m[1]) * (/^(jam|j|h)$/.test(m[2]) ? 60 : 1);
  return mins >= 1 && mins <= 1440 ? mins + "m" : null;
}
function repeatLabel(rule) {
  if (rule === "harian") return "tiap hari";
  if (rule === "mingguan") return "tiap minggu";
  if (rule === "bulanan") return "tiap bulan";
  const m = /^(\d+)m$/.exec(rule || "");
  if (!m) return "berulang";
  const n = Number(m[1]);
  return n % 60 === 0 ? `tiap ${n / 60} jam` : `tiap ${n} menit`;
}
function nextRepeat(ts, rule) {
  const iv = /^(\d+)m$/.exec(rule || "");
  if (iv) return ts + Number(iv[1]) * 60 * 1000;
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
// Deteksi kemungkinan dobel catat (mis. sama-sama lewat web & Telegram, atau pesan ke-klik/terkirim 2x):
// nominal & kategori sama, dalam jarak DUP_WINDOW. Tidak memblokir, cuma ngasih tanda supaya pengguna sadar.
const DUP_WINDOW = 3 * 60 * 1000;
async function isLikelyDuplicate(u, listName, amt, cat) {
  const rows = await redis("LRANGE", key(u, listName), -5, -1);
  const now = Date.now();
  for (const r of rows || []) {
    let it; try { it = JSON.parse(r); } catch { continue; }
    if (it.amt === amt && it.cat === cat && now - it.ts < DUP_WINDOW) return true;
  }
  return false;
}

async function addExpense(u, amt, cat, note) {
  const n = Math.round(Number(amt));
  if (!Number.isFinite(n) || n <= 0 || n > 1e10) return null;
  const c = String(cat || "lainnya").toLowerCase().slice(0, 20);
  const item = { id: uid(), ts: Date.now(), amt: n, cat: c, note: String(note || "").slice(0, 100) };
  const dup = await isLikelyDuplicate(u, "exp:" + wib().monthKey, n, c);
  await redis("RPUSH", key(u, "exp:" + wib().monthKey), JSON.stringify(item));
  await mochiProgress(u, "spend");
  return { ...item, dup };
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
  const c = String(cat || "lainnya").toLowerCase().slice(0, 20);
  const item = { id: uid(), ts: Date.now(), amt: n, cat: c, note: String(note || "").slice(0, 100) };
  const dup = await isLikelyDuplicate(u, "inc:" + wib().monthKey, n, c);
  await redis("RPUSH", key(u, "inc:" + wib().monthKey), JSON.stringify(item));
  await mochiProgress(u, "spend");
  return { ...item, dup };
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
async function getReminders(u) {
  const rows = await redis("ZRANGE", key(u, "reminders"), 0, -1, "WITHSCORES");
  const out = [];
  for (let i = 0; i < (rows || []).length; i += 2) {
    let it = {};
    try { it = JSON.parse(rows[i]); } catch {}
    const ts = Number(rows[i + 1]);
    out.push({ id: it.id || "t" + ts, text: it.text || "?", ts, repeat: it.repeat || null, until: it.until || null, tid: it.tid || null });
  }
  return out;
}
// Pengingat berulang dengan teks dan pola sama (mis. pesan "ulangi" dari pengguna) menggantikan yang lama, bukan menambah dobel
async function dropDuplicateReminders(u, text, rule) {
  if (!rule) return;
  const norm = (x) => String(x || "").trim().toLowerCase();
  const rows = await redis("ZRANGE", key(u, "reminders"), 0, -1);
  for (const member of rows || []) {
    let it = {};
    try { it = JSON.parse(member); } catch { continue; }
    if (!it.tid && it.repeat === rule && norm(it.text) === norm(text)) await redis("ZREM", key(u, "reminders"), member);
  }
}
async function addReminder(u, text, ts, repeat, tid, until) {
  const t = String(text || "").trim().slice(0, 200);
  const when = Number(ts);
  if (!t || !Number.isFinite(when) || when <= Date.now()) return null;
  const item = { id: uid(), text: t };
  const rule = parseRepeat(repeat);
  if (rule) item.repeat = rule;
  if (rule && Number.isFinite(Number(until)) && Number(until) > when) item.until = Number(until);
  if (!tid) await dropDuplicateReminders(u, t, rule);
  if (tid) item.tid = tid;
  await redis("ZADD", key(u, "reminders"), when, JSON.stringify(item));
  await mochiProgress(u, "remind");
  return { id: item.id, text: item.text, ts: when, repeat: item.repeat || null, until: item.until || null };
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

// Geser jam pengingat berdasarkan nomor di daftar (mis. "geser yang bayar wifi jadi besok"), tanpa hapus+buat ulang.
// Teks, pola berulang, dan tautan ke tugas (kalau ada) dipertahankan; cuma jamnya yang berubah.
async function rescheduleReminderNumber(u, n, newTs) {
  const list = await getReminders(u);
  const r = list[Number(n) - 1];
  if (!r) return null;
  const when = Number(newTs);
  if (!Number.isFinite(when) || when <= Date.now()) return null;
  const removed = await deleteReminderById(u, r.id, false); // false: jangan lepas tautan tugas, kita update manual di bawah
  if (!removed) return null;
  const item = { id: r.id, text: r.text };
  if (r.repeat) item.repeat = r.repeat;
  if (r.until) item.until = r.until;
  if (r.tid) item.tid = r.tid;
  await redis("ZADD", key(u, "reminders"), when, JSON.stringify(item));
  if (r.tid) {
    const tasks = await getTasks(u);
    const t = tasks.find((x) => x.id === r.tid);
    if (t) { t.due = when; await saveTasks(u, tasks); }
  }
  return { id: r.id, text: r.text, ts: when, repeat: r.repeat || null, until: r.until || null };
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

// ---------- Fakta jangka panjang / memori (dipakai bareng web & Telegram) ----------
async function getFacts(u) {
  return (await redis("LRANGE", key(u, "facts"), 0, -1)) || [];
}
async function addFacts(u, arr) {
  const list = (arr || []).map((f) => String(f).trim().slice(0, 300)).filter(Boolean);
  if (!list.length) return;
  for (const f of list) await redis("RPUSH", key(u, "facts"), f);
  await redis("LTRIM", key(u, "facts"), -40, -1);
}
async function clearFacts(u) {
  await redis("DEL", key(u, "facts"));
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

  // Insight: bandingkan pace pengeluaran bulan ini vs bulan lalu, di periode hari yang sama (month-to-date)
  let insight = "";
  if (month.length >= 3) {
    let py = w.y, pm = w.m - 1;
    if (pm < 1) { pm = 12; py -= 1; }
    const prevKey = `${py}-${String(pm).padStart(2, "0")}`;
    const prevMtd = (await getExpenses(u, prevKey)).filter((e) => wib(e.ts).d <= w.d);
    const prevTotal = prevMtd.reduce((s, e) => s + e.amt, 0);
    if (prevMtd.length >= 3 && prevTotal > 0) {
      const pct = Math.round(((bm.total - prevTotal) / prevTotal) * 100);
      if (Math.abs(pct) >= 15) {
        const curByCat = {}, prevByCat = {};
        for (const e of month) curByCat[e.cat] = (curByCat[e.cat] || 0) + e.amt;
        for (const e of prevMtd) prevByCat[e.cat] = (prevByCat[e.cat] || 0) + e.amt;
        let topCat = null, topInc = 0;
        for (const c of Object.keys(curByCat)) {
          const inc = curByCat[c] - (prevByCat[c] || 0);
          if (inc > topInc) { topInc = inc; topCat = c; }
        }
        insight = pct > 0
          ? `📈 Pengeluaran sejauh ini ${pct}% lebih tinggi dari bulan lalu di periode yang sama` + (topCat ? `, paling banyak naik di kategori ${topCat} (+${rupiah(topInc)})` : "") + "."
          : `📉 Pengeluaran sejauh ini ${Math.abs(pct)}% lebih rendah dari bulan lalu di periode yang sama. Mantap!`;
      }
    }
  }

  const parts = [];
  parts.push("💰 Uang bulan ini");
  parts.push(
    `💵 Pemasukan: ${rupiah(incTotal)} (${incMonth.length})\n` +
    `💸 Pengeluaran: ${rupiah(bm.total)} (${month.length})\n` +
    `⚖️ Selisih: ${sg(incTotal - bm.total)}` +
    (remaining != null ? `\n👛 Sisa uang: ${sg(remaining)}` : "")
  );
  if (insight) parts.push(insight);
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
  // Belum ada saldo: perkiraan dari pemasukan - pengeluaran bulan ini (tandai estimated), jangan dibiarkan kosong
  const estimated = !saldo && (inc.length > 0 || exp.length > 0);
  if (estimated) remaining = income - expense;
  return { income, expense, net: income - expense, saldo: saldo ? saldo.amt : null, saldoTs: saldo ? saldo.ts : null, remaining, estimated };
}
// Uang lain di luar catatan (mis. "aku punya 65rb sebelum dikasih"): ditambahkan ke sisa uang sekarang, bukan menimpanya
async function addOutsideMoney(u, amt) {
  const n = Math.round(Number(amt));
  if (!Number.isFinite(n) || n < 0 || n > 1e12) return null;
  const sm = await moneySummary(u);
  const sd = await setSaldo(u, (sm.remaining || 0) + n);
  return sd ? { saldo: sd, base: sm.remaining || 0, extra: n } : null;
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
    const list = (arr) => arr.length ? arr.slice(-15).map((e) => (e.note || e.cat) + " " + rupiah(e.amt)).join("; ") : "tidak ada";
    out += `\nSaldo yang diberitahu pengguna: ${rupiah(saldo.amt)} (dicatat ${fmtWib(saldo.ts)}). ` +
      `Sejak itu ada ${i2.length} pemasukan, total ${rupiah(got)} (${list(i2)}), dan ${e2.length} pengeluaran, total ${rupiah(spent)} (${list(e2)}). ` +
      `PERKIRAAN SISA UANG: ${rupiah(saldo.amt + got - spent)}. Kalau ditanya sisa uang, pakai angka PERKIRAAN SISA UANG ini persis, jangan hitung ulang, ` +
      `dan kalau menjelaskan rinciannya sebutkan SEMUA pemasukan di atas (termasuk kiriman dari pasangan), bukan hanya satu. ` +
      `(Kalau pengguna menyebut saldo terbaru, catat ulang dengan tag SALDO.)`;
  } else {
    const expT = month.reduce((s, e) => s + e.amt, 0), incT = incs.reduce((s, e) => s + e.amt, 0);
    if (incs.length || month.length) {
      out += `\nSaldo awal pengguna BELUM diketahui. PERKIRAAN SISA UANG dari catatan bulan ini saja: ${incT - expT < 0 ? "-" : ""}${rupiah(Math.abs(incT - expT))} (semua pemasukan dikurangi semua pengeluaran di atas). ` +
        `Kalau ditanya sisa uang, jawab angka itu sebagai perkiraan dan sebutkan SEMUA pemasukan dan pengeluarannya, lalu tanya SATU kali apakah ada uang lain di luar catatan. ` +
        `Kalau ada, pengguna cukup menyebut jumlah uang lain itu saja (bukan total); catat dengan tag SALDO_LAIN, jangan SALDO, supaya pemasukan yang sudah tercatat tidak hilang.`;
    } else {
      out += "\nSaldo awal pengguna BELUM diketahui dan belum ada pemasukan/pengeluaran. Kalau ditanya sisa uang, minta pengguna menyebut uangnya sekarang, lalu catat dengan tag SALDO.";
    }
  }
  return out;
}

// ---------- Konteks & prompt ----------
async function loadContext(u) {
  const [facts, rows, profile, tasks, notes, money, partner] = await Promise.all([
    getFacts(u),
    redis("ZRANGE", key(u, "reminders"), 0, 9, "WITHSCORES"),
    getProfile(u), getTasks(u), getNotes(u), moneyContext(u), partnerContext(u).catch(() => ""),
  ]);
  const reminders = [];
  for (let i = 0; i < (rows || []).length; i += 2) {
    let it = {};
    try { it = JSON.parse(rows[i]); } catch {}
    reminders.push({ text: it.text || "?", ts: Number(rows[i + 1]), repeat: it.repeat, until: it.until });
  }
  return { facts: facts || [], reminders, profile, tasks, notes, money, partner };
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
  Pengingat berulang: tambahkan bagian ketiga harian / mingguan / bulanan, atau interval seperti "tiap 5 menit" / "tiap 2 jam" (minimal 1 menit). Contoh: [[REMIND: 2026-10-13T09:00:00+07:00 | rapat tim | mingguan]]. Waktu = kemunculan pertama.
  Kalau pengguna minta berulang SAMPAI jam tertentu (mis. "tiap 5 menit sampai jam 10"), tambahkan bagian keempat berisi waktu berhenti (ISO, +07:00; kalau jam itu sudah lewat hari ini berarti besok). Waktu pertama = sekarang + interval. Contoh: [[REMIND: 2026-10-12T22:10:00+07:00 | waktunya minum | tiap 5 menit | 2026-10-12T22:30:00+07:00]]. Jangan pernah memakai harian untuk permintaan interval menit/jam, dan jangan mengubah isi pengingat dengan menambah jam atau menit.
- Pengeluaran yang sudah terjadi (mis. "makan siang 25rb", "beli bensin 50 ribu", atau foto struk/nota): [[BELI: 25000 | makan | makan siang]]
  Jumlah rupiah angka bulat tanpa titik ("25rb" = 25000, "1,5jt" = 1500000). Kategori satu kata: makan, transport, belanja, tagihan, hiburan, kesehatan, lainnya. Untuk struk cukup satu tag berisi total.
- Pemasukan / uang masuk yang sudah terjadi (mis. "gajian 3jt", "dapat bonus 500rb", "dikasih ortu 200rb"): [[MASUK: 3000000 | gaji | gajian]]
  Format angka sama seperti BELI. Kategori satu kata: gaji, bonus, usaha, hadiah, lainnya. Jangan pakai MASUK untuk pengeluaran, dan jangan pakai SALDO untuk uang masuk baru (SALDO hanya untuk saat pengguna menyebut total uangnya sekarang).
- Saldo/uang yang dimiliki pengguna sekarang (mis. \"uangku sekarang 500rb\", \"saldo 1,2jt\"): [[SALDO: 500000]]. Angka bulat tanpa titik. Sisa uang dihitung dari saldo dikurangi pengeluaran yang tercatat setelahnya.
  PENTING: SALDO menimpa semua perhitungan sebelumnya. Kalau pengguna menyebut uang tambahan di luar catatan (mis. \"aku punya 65rb di luar itu\"), pakai [[SALDO_LAIN: 65000]]: sistem menambahkannya ke sisa uang dari catatan. Kalau belum jelas angkanya total atau tambahan sementara ada pemasukan tercatat, tanyakan dulu sebelum membuat tag.
- Tugas/checklist (pekerjaan yang perlu dikerjakan): [[TASK: isi tugas singkat]]
  Kalau pengguna menyebut jam/hari untuk tugas itu (mis. "nyuci piring besok jam 7"), tambahkan waktu: [[TASK: nyuci piring | 2026-10-13T07:00:00+07:00]]. Tugas berjam otomatis jadi pengingat yang bunyi tepat waktu dan dibatalkan kalau tugasnya dicentang selesai. Jangan buat TASK dan REMIND sekaligus untuk hal yang sama.
  Pakai REMIND hanya untuk pengingat murni yang bukan tugas (minum obat, rapat, tagihan) atau yang berulang.
- Fakta jangka panjang tentang pengguna (nama, orang penting, kebiasaan, preferensi, hal besar yang sedang dihadapi): [[INGAT: fakta singkat]]. Jangan simpan detail yang sangat sensitif kecuali pengguna memintanya.
- Catatan jika pengguna minta mencatat sesuatu: [[CATAT: isi catatan]]
  JANGAN buat CATAT atau TASK untuk permintaan menghapus/menyelesaikan. Kata seperti "hapus" bukan isi catatan.
- Pengingat juga bisa dihapus lewat tag lama [[HAPUS_PENGINGAT: N]] (N = nomor di daftar Pengingat mendatang); sama seperti [[HAPUS: ...]] di bawah, sistem tetap minta konfirmasi dulu.
- Pengingat BISA digeser jamnya lewat tag [[GESER_PENGINGAT: N | waktu_baru]] (N = nomor di daftar Pengingat mendatang, waktu_baru format ISO 8601 +07:00 seperti REMIND). Pakai ini kalau pengguna minta mengubah/menggeser/memajukan/memundurkan jam pengingat yang sudah ada (mis. "geser yang bayar wifi jadi besok jam 9", "pengingat nomor 2 majuin jam 7 aja"), BUKAN [[HAPUS_PENGINGAT]] lalu [[REMIND]] baru. Kalau tidak jelas pengingat yang mana atau jam barunya, tanyakan dulu. Pola berulang dan tautan ke tugas (kalau ada) tetap dipertahankan otomatis.
- Menghapus tugas, catatan, pengeluaran, pemasukan, atau pengingat: pakai tag [[HAPUS: jenis | kata kunci]]. Jenis salah satu: tugas, catatan, beli (pengeluaran), masuk (pemasukan), pengingat. Kata kunci = isi item seperti disebut pengguna, mis. "hapus beli makan 5rb" -> [[HAPUS: beli | makan 5rb]]. Untuk "yang barusan/terakhir/tadi" pakai kata kunci TERAKHIR dan tentukan jenisnya dari baris ✅ ⏰ 🗒️ 💰 💵 terakhir di balasanmu sebelumnya (✅ tugas, ⏰ pengingat, 🗒️ catatan, 💰 beli, 💵 masuk); kalau jenisnya tidak jelas, tanyakan dulu. Penghapusan TIDAK langsung: sistem mencari item lalu menampilkan tombol konfirmasi. Jadi balas singkat saja (mis. "Oke, konfirmasi dulu ya.") dan JANGAN bilang sudah dihapus. Hapus massal ("hapus semua ...") tidak didukung: tolak dengan sopan dan sarankan hapus satu per satu.
  Kalau pengguna membatalkan hal yang BARU dicatat ("eh ga jadi", "salah catat", "batal yang tadi", "salah input"), anggap itu permintaan hapus: pakai [[HAPUS: jenis | TERAKHIR]] sesuai jenis baris ✅ ⏰ 🗒️ 💰 💵 terakhir di balasanmu. JANGAN bilang "tidak jadi dicatat" tanpa tag ini, karena datanya sudah tersimpan.
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
        .map((r, i) => `${i + 1}. ${r.text} (${fmtWib(r.ts)})${r.repeat ? " [berulang: " + repeatLabel(r.repeat) + "]" : ""}`)
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

${ctx.partner ? ctx.partner + "\n\n" : ""}${COMMON}`;
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
  const [facts, profile] = await Promise.all([getFacts(u), getProfile(u)]);
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

// ---------- Hubungkan akun (kiriman uang antar dua akun) ----------
// Data di Redis:
//   u:<id>:link      = {pid, ts}            pasangan yang terhubung (dua arah)
//   linkcode:<KODE>  = id pembuat kode      sekali pakai, berlaku 10 menit
//   u:<id>:linkcode  = kode aktif milik pembuat (supaya bisa ditampilkan lagi)
//   xfer:<id>        = {id, from, to, amt, note, ts, status: pending|accepted|declined, incId}
//   u:<penerima>:xferin = ZSET id kiriman (skor = waktu)
//   u:<id>:dupmasuk  = pertanyaan "tambah lagi?" yang menunggu jawaban (5 menit)
// Galat untuk pengguna (pesan tampil apa adanya, status 400)
const userErr = (m) => Object.assign(new Error(m), { status: 400 });
const LINK_CODE_TTL = 600;
const XFER_TTL = 7 * 24 * 3600;
const XFER_WINDOW = 3 * DAY; // kiriman dianggap sama kalau nominalnya sama dan masih dalam rentang ini
const XFER_MAX_PENDING = 20;
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// Nama yang ditampilkan ke pasangan: nama di Profil kalau diisi, kalau tidak baru username
async function usernameOf(u) {
  try {
    const p = await getProfile(u);
    const n = String((p && p.name) || "").trim();
    if (n) return n;
  } catch {}
  return (await redis("GET", "uid:" + u)) || "pasangan";
}
async function getLink(u) {
  const raw = await redis("GET", key(u, "link"));
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}
async function notifyUser(u, text, extra) {
  try {
    const bot = await getBot(u);
    if (bot && bot.chatId) return await sendTelegram(u, String(bot.chatId), text, extra || {});
  } catch {}
  return false;
}

async function getXfer(id) {
  const raw = await redis("GET", "xfer:" + id);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}
async function saveXfer(x) { await redis("SET", "xfer:" + x.id, JSON.stringify(x), "EX", String(XFER_TTL)); }

// Kiriman yang masuk ke u (terbaru dulu). onlyPending: hanya yang belum dijawab.
async function xferList(u, onlyPending) {
  const ids = (await redis("ZRANGE", key(u, "xferin"), -50, -1)) || [];
  const out = [];
  for (const id of ids) {
    const x = await getXfer(id);
    if (!x) { await redis("ZREM", key(u, "xferin"), id); continue; }
    if (x.to === u && (!onlyPending || x.status === "pending")) out.push(x);
  }
  return out.sort((a, b) => b.ts - a.ts);
}
async function incomeStillThere(u, x) {
  if (!x.incId) return false;
  return (await incomesSince(u, x.accTs || x.ts)).some((e) => e.id === x.incId);
}

async function incomingTransfers(u) {
  const l = await getLink(u);
  if (!l) return [];
  const name = await usernameOf(l.pid);
  return (await xferList(u, true)).filter((x) => x.from === l.pid).map((x) => ({ id: x.id, amt: x.amt, note: x.note, ts: x.ts, from: name }));
}

async function linkStatus(u) {
  const l = await getLink(u);
  if (l) return { linked: true, partner: await usernameOf(l.pid), since: l.ts, incoming: await incomingTransfers(u) };
  const code = await redis("GET", key(u, "linkcode"));
  const ttl = code ? Number(await redis("TTL", key(u, "linkcode"))) || 0 : 0;
  return { linked: false, code: code && ttl > 0 ? code : null, codeTtl: ttl > 0 ? ttl : 0 };
}

async function makeLinkCode(u) {
  if (await getLink(u)) throw userErr("Akun ini sudah terhubung. Putuskan dulu kalau mau menghubungkan ke akun lain.");
  const old = await redis("GET", key(u, "linkcode"));
  if (old) await redis("DEL", "linkcode:" + old);
  let code = "";
  for (const b of crypto.randomBytes(6)) code += CODE_CHARS[b % CODE_CHARS.length];
  await redis("SET", "linkcode:" + code, u, "EX", String(LINK_CODE_TTL));
  await redis("SET", key(u, "linkcode"), code, "EX", String(LINK_CODE_TTL));
  return linkStatus(u);
}

// Memasukkan kode dari pasangan = menyetujui hubungan (kode dibuat satu pihak, dimasukkan pihak lain)
async function useLinkCode(u, input) {
  const code = String(input || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== 6) throw userErr("Kode terdiri dari 6 karakter.");
  const rk = key(u, "rl:link");
  const n = Number(await redis("INCR", rk));
  if (n === 1) await redis("EXPIRE", rk, "900");
  if (n > 10) throw userErr("Terlalu banyak percobaan. Coba lagi 15 menit lagi.");
  if (await getLink(u)) throw userErr("Akun ini sudah terhubung. Putuskan dulu kalau mau menghubungkan ke akun lain.");
  const o = await redis("GET", "linkcode:" + code);
  if (!o) throw userErr("Kode tidak ditemukan atau sudah kedaluwarsa.");
  if (o === u) throw userErr("Itu kodemu sendiri. Berikan kode ini ke pasanganmu, lalu dia yang memasukkannya.");
  if (await getLink(o)) throw userErr("Pemilik kode sudah terhubung dengan akun lain.");
  if (Number(await redis("DEL", "linkcode:" + code)) !== 1) throw userErr("Kode tidak ditemukan atau sudah kedaluwarsa."); // klaim atomik: sekali pakai
  await redis("DEL", key(o, "linkcode"));
  const ts = Date.now();
  await redis("SET", key(u, "link"), JSON.stringify({ pid: o, ts }));
  await redis("SET", key(o, "link"), JSON.stringify({ pid: u, ts }));
  await redis("DEL", key(u, "unlinked"), key(o, "unlinked"));
  await notifyUser(o, "🔗 " + (await usernameOf(u)) + " sekarang terhubung denganmu. Kiriman uang antar kalian akan saling dikabari.");
  return linkStatus(u);
}

async function unlinkPartner(u) {
  const l = await getLink(u);
  if (l) {
    await redis("DEL", key(u, "link"), key(u, "dupmasuk"));
    const back = await getLink(l.pid);
    if (back && back.pid === u) await redis("DEL", key(l.pid, "link"), key(l.pid, "dupmasuk"));
    // Catat bekas hubungan supaya asisten tahu sudah putus (riwayat obrolan masih menyebut "terhubung")
    const [meName, otherName] = [await usernameOf(u), await usernameOf(l.pid)];
    const stamp = (name) => JSON.stringify({ name, ts: Date.now() });
    await redis("SET", key(u, "unlinked"), stamp(otherName), "EX", String(30 * DAY / 1000));
    await redis("SET", key(l.pid, "unlinked"), stamp(meName), "EX", String(30 * DAY / 1000));
    await notifyUser(l.pid, "🔌 " + (await usernameOf(u)) + " memutus hubungan akun. Kiriman uang tidak lagi saling dikabari.");
  }
  return linkStatus(u);
}

// Pesan pengguna menyebut nominal uang? Gemini kadang mengulang tag BELI/MASUK dari riwayat obrolan
// (mis. saat pengguna cuma bilang "boros banget" atau kirim emoji), jadi pengeluaran tercatat dobel.
// Tag BELI/MASUK hanya diproses kalau pesan itu sendiri menyebut angka.
function mentionsAmount(text) {
  return /\d|\b(seribu|ribu|rb|juta|jt|setengah|sejuta|goceng|ceban|gopek|cepek)\b/i.test(String(text || ""));
}

// Keterangan kiriman dari Gemini sering cuma mengulang kalimat pengguna ("kirim ke risma").
// Itu dibuang: sudah tercantum otomatis ("kirim ke <nama>" di pengirim, "dari <nama>" di penerima),
// dan kalau dibiarkan jadi dobel di pengirim dan menyesatkan di sisi penerima. Yang disimpan hanya info tambahan (mis. "uang jajan").
function cleanTransferNote(note, toName, fromName) {
  let t = String(note || "").trim();
  if (!t) return "";
  const esc = (x) => String(x || "").trim().split(/\s+/)[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const names = [esc(toName), esc(fromName)].filter(Boolean).join("|");
  const verb = "(?:tolong\\s+)?(?:kirim(?:kan)?|transfer|tf|kasih|bayar(?:kan)?|setor|dikirim|ditransfer)(?:\\s+uang)?";
  // "kirim ke risma", "transfer ke risma", "kirim uang ke pasangan", "dari eko"
  const only = new RegExp("^(?:" + verb + "\\s+(?:ke|buat|untuk)|dari|ke)\\s+(?:" + (names ? names + "|" : "") + "pasangan|istri|suami|teman)\\w*\\s*$", "i");
  if (only.test(t)) return "";
  const lead = new RegExp("^" + verb + "\\s+(?:ke|buat|untuk)\\s+(?:" + (names ? names + "|" : "") + "pasangan|istri|suami|teman)\\w*\\s*[-,:]?\\s*", "i");
  t = t.replace(lead, "").trim();
  return t.slice(0, 100);
}

// u mengirim uang ke pasangan: tercatat sebagai pengeluaran u, pasangan diminta konfirmasi (tidak otomatis masuk ke akunnya)
async function sendTransfer(u, amt, note) {
  const n = Math.round(Number(amt));
  const l = await getLink(u);
  if (!l || !Number.isFinite(n) || n <= 0 || n > 1e12) return null;
  const pending = (await xferList(l.pid, true)).filter((x) => x.from === u);
  if (pending.length >= XFER_MAX_PENDING) return { error: "Terlalu banyak kiriman yang belum dikonfirmasi pasanganmu. Tunggu dia menjawab dulu." };
  const name = await usernameOf(l.pid);
  const cleanNote = cleanTransferNote(note, name, await usernameOf(u));
  const exp = await addExpense(u, n, "transfer", ("kirim ke " + name + (cleanNote ? " - " + cleanNote : "")).slice(0, 100));
  const x = { id: uid(), from: u, to: l.pid, amt: n, note: cleanNote, ts: Date.now(), status: "pending", expId: exp ? exp.id : null };
  await saveXfer(x);
  await redis("ZADD", key(l.pid, "xferin"), String(x.ts), x.id);
  await redis("ZREMRANGEBYSCORE", key(l.pid, "xferin"), "-inf", String(Date.now() - XFER_TTL * 1000));
  const notified = await notifyUser(
    l.pid,
    "💸 " + (await usernameOf(u)) + " mengirim " + rupiah(n) + (cleanNote ? " (" + cleanNote + ")" : "") + ". Catat sebagai pemasukan?",
    { reply_markup: { inline_keyboard: [[{ text: "✅ Catat", callback_data: "xf:ok:" + x.id }, { text: "❌ Tidak", callback_data: "xf:no:" + x.id }]] } }
  );
  return { x, name, notified };
}

// Catat kiriman sebagai pemasukan u (sekali saja). null = sudah/ sedang diproses.
async function recordTransferIncome(u, x) {
  const lock = "xferlock:" + x.id; // hanya mencegah dua permintaan bersamaan (klik ganda); dilepas setelah selesai
  if ((await redis("SET", lock, "1", "NX", "EX", "15")) !== "OK") return null;
  try {
    const fromName = await usernameOf(x.from);
    const inc = await addIncome(u, x.amt, "transfer", ("dari " + fromName + (x.note ? " - " + x.note : "")).slice(0, 100));
    if (!inc) return null;
    x.status = "accepted"; x.incId = inc.id; x.accTs = Date.now();
    await saveXfer(x);
    await notifyUser(x.from, "✅ " + (await usernameOf(u)) + " sudah mencatat kiriman " + rupiah(x.amt) + " sebagai pemasukan.");
    return inc;
  } finally {
    await redis("DEL", lock);
  }
}

async function acceptTransfer(u, id) {
  const x = await getXfer(String(id || ""));
  if (!x || x.to !== u) return { error: "Kiriman tidak ditemukan atau sudah kedaluwarsa." };
  const l = await getLink(u);
  if (!l || l.pid !== x.from) return { error: "Akun ini sudah tidak terhubung dengan pengirim." };
  const name = await usernameOf(x.from);
  if (x.status === "accepted" && (await incomeStillThere(u, x))) return { already: true, x, name };
  const inc = await recordTransferIncome(u, x);
  return inc ? { x, inc, name } : { already: true, x, name };
}

async function declineTransfer(u, id) {
  const x = await getXfer(String(id || ""));
  if (!x || x.to !== u) return { error: "Kiriman tidak ditemukan atau sudah kedaluwarsa." };
  if (x.status !== "pending") return { already: true, x };
  x.status = "declined";
  await saveXfer(x);
  await notifyUser(x.from, "❌ " + (await usernameOf(u)) + " tidak mencatat kiriman " + rupiah(x.amt) + " (mungkin nominalnya beda). Pengeluaranmu tetap tercatat; kalau salah, hapus lewat /rekap.");
  return { x };
}

// u bilang "dapat Rp X dari pasangan": cocokkan dengan kiriman yang sudah dikabari supaya tidak dobel.
async function handlePartnerIncome(u, amt, note) {
  const n = Math.round(Number(amt));
  if (!Number.isFinite(n) || n <= 0 || n > 1e12) return null;
  const l = await getLink(u);
  const name = l ? await usernameOf(l.pid) : "pasangan";
  const desc = ("dari " + name + (note ? " - " + note : "")).slice(0, 100);
  if (l) {
    const cands = (await xferList(u, false)).filter((x) => x.from === l.pid && x.amt === n && x.ts >= Date.now() - XFER_WINDOW);
    let open = null, done = null;
    for (const x of cands) {
      const recorded = x.status === "accepted" && (await incomeStillThere(u, x));
      if (recorded) done = done || x; else open = open || x;
    }
    if (open) {
      const inc = await recordTransferIncome(u, open);
      return inc
        ? "💵 Pemasukan dicatat: " + rupiah(n) + " dari " + name + ". Ini cocok dengan kiriman " + name + " tadi, jadi tidak dicatat dobel."
        : "ℹ️ Kiriman " + rupiah(n) + " dari " + name + " sedang diproses, jadi tidak kucatat dobel.";
    }
    if (done) {
      await redis("SET", key(u, "dupmasuk"), JSON.stringify({ amt: n, desc }), "EX", "300");
      return "ℹ️ Itu sudah tercatat tadi: " + rupiah(n) + " dari " + name + " (" + fmtDateShort(done.accTs || done.ts) + "). Mau tambah lagi sebagai pemasukan terpisah? (ya / tidak)";
    }
  }
  const inc = await addIncome(u, n, "transfer", desc);
  return inc ? "💵 Pemasukan dicatat: " + rupiah(inc.amt) + " (transfer) - " + desc : null;
}

// Jawaban "ya / tidak" untuk pertanyaan "tambah lagi?". null = pesan ini bukan jawaban, lanjut seperti biasa.
async function answerDupMasuk(u, text) {
  const raw = await redis("GET", key(u, "dupmasuk"));
  if (!raw) return null;
  await redis("DEL", key(u, "dupmasuk"));
  let d = null;
  try { d = JSON.parse(raw); } catch {}
  const t = String(text || "").trim().toLowerCase().replace(/[.!\s]+$/, "");
  if (d && /^(ya|iya|iy|y|yup|yap|ok|oke|boleh|gas|tambah|tambahkan|lanjut)$/.test(t)) {
    const inc = await addIncome(u, d.amt, "transfer", d.desc);
    return inc ? "💵 Sudah ditambahkan: " + rupiah(inc.amt) + " (" + d.desc + "). Mau menambah lagi? Ketik saja pemasukannya." : null;
  }
  if (/^(tidak|ga|gak|nggak|enggak|engga|g|n|no|batal|jangan|skip|cukup)$/.test(t)) return "Oke, tidak kutambah.";
  return null;
}

// Petunjuk untuk Gemini soal pasangan (tag KIRIM / PASANGAN_MASUK hanya muncul kalau akun sudah terhubung)
async function partnerContext(u) {
  const l = await getLink(u);
  if (!l) {
    let was = null;
    try { was = JSON.parse(await redis("GET", key(u, "unlinked"))); } catch {}
    if (was && was.name) {
      return "Pasangan: hubungan akun dengan " + was.name + " SUDAH DIPUTUS pada " + fmtWib(was.ts) + ", jadi sekarang tidak ada akun yang terhubung. Abaikan riwayat obrolan yang menyebut kalian terhubung atau kiriman \"sudah dikabari\". Kalau pengguna mengirim uang ke / menerima uang dari " + was.name + " atau pasangan/teman, catat seperti biasa (BELI / MASUK) dan katakan singkat di balasanmu bahwa hubungannya sudah putus, sehingga " + was.name + " TIDAK dikabari dan tidak ada pencocokan otomatis. Tawarkan untuk menghubungkan lagi lewat Pengaturan > Hubungkan (ulangi tawaran ini hanya sekali).";
    }
    return "Pasangan: belum ada akun pasangan yang terhubung. Kalau pengguna mencatat uang ke/dari pasangan, catat seperti biasa (BELI / MASUK). Boleh sebut SEKALI dan singkat bahwa di Pengaturan > Hubungkan, akun pasangan atau teman bisa dihubungkan supaya kiriman uang tidak tercatat dobel; jangan diulang kalau sudah pernah kamu sebut di obrolan.";
  }
  const name = await usernameOf(l.pid);
  return `Akun terhubung (pasangan atau teman): ${name}. Kalau pengguna menyebut suami/istri/pasangan/teman/ayah/bunda atau nama itu, yang dimaksud dia.
- Pengguna MENGIRIM uang ke pasangan (mis. "kasih istri 5jt", "transfer ke suami 200rb"): [[KIRIM: 5000000 | keterangan singkat]]  (keterangan HANYA untuk info tambahan seperti "uang jajan"; JANGAN diisi "kirim ke <nama>" atau nama penerima, kosongkan kalau tidak ada info tambahan)
  Sistem mencatatnya sebagai pengeluaran pengguna dan mengabari pasangan untuk konfirmasi. Jangan buat BELI untuk ini.
- Pengguna MENERIMA uang dari pasangan (mis. "dapet 5jt dari suami", "istri transfer 1jt"): [[PASANGAN_MASUK: 5000000 | keterangan singkat]]
  Pakai ini, bukan MASUK. Sistem mengecek apakah kiriman itu sudah tercatat supaya tidak dobel. Format angka sama seperti BELI.
- Untuk dua tag di atas, JANGAN menulis kalimat "sudah dicatat" atau menanyakan "mau tambah lagi" sendiri: sistem yang menulis hasilnya di baris bawah balasanmu.`;
}

// Buang tag [[...]] kalau model nekat menulisnya; di mode curhat tag tidak pernah diproses
// ---------- Hapus lewat chat: cari kandidat -> tombol konfirmasi -> baru dihapus ----------
const DEL_KINDS = { tugas: "task", task: "task", catatan: "note", note: "note", beli: "exp", pengeluaran: "exp", keluar: "exp", masuk: "inc", pemasukan: "inc", pengingat: "rem", reminder: "rem" };
const KIND_LABEL = { task: "tugas", note: "catatan", exp: "pengeluaran", inc: "pemasukan", rem: "pengingat" };
const DEL_STOP = new Set(["yang", "tadi", "barusan", "itu", "ini", "dong", "deh", "aja", "saja", "tolong", "nya", "di", "ke", "untuk", "dari", "lagi", "tersebut"]);
const delNorm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ");
const delTokens = (s) => delNorm(s).split(/\s+/).filter((t) => t && !DEL_STOP.has(t));
function delAmount(q) { // "5rb", "1,5jt", "5.000", "5000" -> nominal rupiah + sisa kata
  const m = q.match(/(\d+(?:[.,]\d+)?)\s*(rb|ribu|k|jt|juta)\b/i);
  if (m) {
    const mul = /^(jt|juta)$/i.test(m[2]) ? 1e6 : 1e3;
    return { amt: Math.round(parseFloat(m[1].replace(",", ".")) * mul), rest: q.replace(m[0], " ") };
  }
  const p = q.match(/\b\d{1,3}(?:\.\d{3})+\b|\b\d{4,}\b/);
  if (p) return { amt: Number(p[0].replace(/\./g, "")), rest: q.replace(p[0], " ") };
  return { amt: null, rest: q };
}
const idTime = (id) => (/^[0-9a-z]{14}$/.test(String(id)) ? parseInt(String(id).slice(0, 8), 36) || 0 : 0); // uid() diawali waktu buat
function delItem(kind, it) {
  let label;
  if (kind === "task") label = it.text + (it.due ? " · " + fmtWib(it.due) : "");
  else if (kind === "note") label = String(it.text).slice(0, 70);
  else if (kind === "rem") label = it.text + " · " + fmtWib(it.ts);
  else label = (it.note || it.cat) + " " + rupiah(it.amt) + " · " + fmtDateShort(it.ts);
  return { kind, id: it.id, label: label.slice(0, 120) };
}
async function loadDelList(u, kind) {
  if (kind === "task") return (await getTasks(u)).map((x, i) => ({ ...x, _o: i }));
  if (kind === "note") return (await getNotes(u)).map((x, i) => ({ ...x, _o: i }));
  if (kind === "exp") return (await getExpenses(u)).map((x, i) => ({ ...x, _o: i }));
  if (kind === "inc") return (await getIncomes(u)).map((x, i) => ({ ...x, _o: i }));
  return (await getReminders(u)).map((x) => ({ ...x, _o: idTime(x.id) || -1 }));
}
// Kembalikan maksimal 5 kandidat (terbaru dulu). Tidak pernah menghapus apa pun.
async function findDeleteTargets(u, kindWord, query) {
  const kind = DEL_KINDS[String(kindWord || "").trim().toLowerCase()];
  if (!kind) return { kind: null, items: [] };
  const list = await loadDelList(u, kind);
  const newest = (a) => a.slice().sort((x, y) => y._o - x._o || (y.ts || 0) - (x.ts || 0));
  const q = String(query || "").trim();
  if (!q || /^(terakhir|barusan|baru saja|tadi|yang terakhir|yang barusan|last)$/i.test(q)) {
    const top = newest(list).slice(0, kind === "rem" && !list.some((x) => x._o > 0) ? 3 : 1);
    return { kind, items: top.map((x) => delItem(kind, x)) };
  }
  const money = kind === "exp" || kind === "inc";
  const { amt, rest } = money ? delAmount(q) : { amt: null, rest: q };
  const toks = delTokens(rest);
  const hay = (x) => delNorm(money ? (x.note || "") + " " + x.cat : x.text);
  const ok = (x, all, useAmt) => (!useAmt || amt == null || x.amt === amt) && (all ? toks.every((t) => hay(x).includes(t)) : toks.some((t) => hay(x).includes(t)));
  let hit = [];
  if (toks.length || amt != null) {
    hit = list.filter((x) => ok(x, true, true));
    if (!hit.length && toks.length) hit = list.filter((x) => ok(x, false, true));
    if (!hit.length && toks.length && amt != null) hit = list.filter((x) => ok(x, false, false));
  }
  return { kind, items: newest(hit).slice(0, 5).map((x) => delItem(kind, x)) };
}
// Baca tag [[HAPUS: jenis | kata kunci]] (dan [[HAPUS_PENGINGAT: N]] versi lama), simpan sebagai permintaan menunggu konfirmasi.
async function planDeletes(u, reply) {
  const items = [], misses = [], seen = new Set();
  const add = (it) => { const k = it.kind + ":" + it.id; if (!seen.has(k)) { seen.add(k); items.push(it); } };
  for (const m of reply.matchAll(/\[\[HAPUS:\s*([^|\]]+?)\s*(?:\|\s*([^\]]*?)\s*)?\]\]/g)) {
    const r = await findDeleteTargets(u, m[1], m[2] || "");
    if (!r.kind) { misses.push("⚠️ Jenis yang mau dihapus belum jelas (tugas, catatan, pengeluaran, pemasukan, atau pengingat?)."); continue; }
    if (!r.items.length) misses.push("⚠️ Tidak menemukan " + KIND_LABEL[r.kind] + (m[2] ? ' yang cocok dengan "' + m[2].trim() + '"' : "") + ".");
    r.items.forEach(add);
  }
  const nums = [...new Set([...reply.matchAll(/\[\[HAPUS_PENGINGAT:\s*(\d+)\s*\]\]/g)].map((m) => Number(m[1])))];
  if (nums.length) {
    const rems = await getReminders(u);
    for (const n of nums) { const r = rems[n - 1]; if (r) add(delItem("rem", r)); else misses.push("⚠️ Pengingat nomor " + n + " tidak ditemukan."); }
  }
  let pending = null;
  if (items.length) pending = await setPendingDelete(u, items.slice(0, 5));
  return { pending, misses };
}
async function setPendingDelete(u, items) {
  const p = { id: Math.random().toString(36).slice(2, 8), items, ts: Date.now() };
  await redis("SET", key(u, "pdel"), JSON.stringify(p), "EX", "600");
  return p;
}
async function getPendingDelete(u) {
  const raw = await redis("GET", key(u, "pdel"));
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function deleteQuestion(p) {
  if (p.items.length === 1) return "🗑️ Hapus " + KIND_LABEL[p.items[0].kind] + " ini?\n" + p.items[0].label;
  return "🗑️ Ketemu " + p.items.length + " yang cocok. Mana yang mau dihapus?\n" + p.items.map((it, i) => (i + 1) + ". " + it.label).join("\n");
}
function deleteKeyboard(p) { // untuk Telegram
  const cut = (s) => (s.length > 40 ? s.slice(0, 39) + "…" : s);
  const rows = p.items.length === 1
    ? [[{ text: "🗑️ Hapus", callback_data: "del:" + p.id + ":0" }, { text: "Batal", callback_data: "del:" + p.id + ":no" }]]
    : [...p.items.map((it, i) => [{ text: "🗑️ " + (i + 1) + ". " + cut(it.label), callback_data: "del:" + p.id + ":" + i }]), [{ text: "Batal", callback_data: "del:" + p.id + ":no" }]];
  return { inline_keyboard: rows };
}
// pick: nomor urut item, atau "no" untuk batal. Sekali pakai: kalau sudah diproses di web/Telegram, yang kedua dapat pesan kedaluwarsa.
async function resolvePendingDelete(u, id, pick) {
  const p = await getPendingDelete(u);
  if (!p || p.id !== String(id)) return { error: "Permintaan hapus ini sudah diproses atau kedaluwarsa." };
  await redis("DEL", key(u, "pdel"));
  if (pick === "no") return { cancelled: true };
  const it = p.items[Number(pick)];
  if (!it) return { error: "Pilihan tidak valid." };
  let ok = false;
  if (it.kind === "task") ok = await deleteTask(u, it.id);
  else if (it.kind === "note") ok = await deleteNoteById(u, it.id);
  else if (it.kind === "exp") ok = await deleteExpenseById(u, it.id);
  else if (it.kind === "inc") ok = await deleteIncomeById(u, it.id);
  else if (it.kind === "rem") ok = await deleteReminderById(u, it.id);
  return ok ? { item: it } : { error: "Gagal menghapus (mungkin sudah terhapus)." };
}

// ---------- Pengingat ulang (nag): kalau pengingat sekali jalan tidak ditanggapi ----------
// Setelah pengingat terkirim: ulang pertama 5 menit kemudian, lalu tiap 1 menit, total NAG_MAX kali, lalu berhenti.
// Berhenti lebih awal kalau pengguna menekan "Sudah" / "Tunda" (di Telegram atau di notifikasi web) atau tugasnya selesai.
const NAG_FIRST = 5 * 60 * 1000 - 15000; // dikurangi 15 dtk karena cron berjalan per menit
const NAG_STEP = 60 * 1000 - 15000;
const NAG_MAX = 5;
const NAG_SNOOZE = 10 * 60 * 1000;
const NAG_TTL = "21600"; // tombol di pesan lama masih bisa dipakai sampai 6 jam
async function createNag(u, text, tid, schedule) {
  const id = uid();
  await redis("SET", key(u, "nag:" + id), JSON.stringify({ text: String(text).slice(0, 200), tid: tid || null, n: 0 }), "EX", NAG_TTL);
  if (schedule) await redis("ZADD", key(u, "nags"), Date.now() + NAG_FIRST, id);
  return id;
}
async function dropNag(u, id) {
  await redis("DEL", key(u, "nag:" + id));
  await redis("ZREM", key(u, "nags"), id);
}
async function getNag(u, id) {
  const raw = await redis("GET", key(u, "nag:" + id));
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}
// act: "ok" (sudah) atau "snz" (tunda 10 menit)
async function ackNag(u, id, act) {
  const d = await getNag(u, id);
  if (!d) return { error: "Pengingat ini sudah tidak aktif." };
  await dropNag(u, id);
  if (act === "snz") {
    const r = await addReminder(u, d.text, Date.now() + NAG_SNOOZE);
    return { text: d.text, act: "snz", ts: r ? r.ts : null };
  }
  return { text: d.text, act: "ok" };
}
const nagKeyboard = (id) => ({ inline_keyboard: [[{ text: "✅ Sudah", callback_data: "nag:ok:" + id }, { text: "⏰ Tunda 10 menit", callback_data: "nag:snz:" + id }]] });

// ---------- Notifikasi push web (PWA) ----------
// Butuh env VAPID_PUBLIC_KEY dan VAPID_PRIVATE_KEY (buat dengan: npx web-push generate-vapid-keys) dan paket web-push.
// Langganan disimpan per perangkat di u:<id>:push (hash), maksimal 5 perangkat.
const pushEnabled = () => !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
let _wp;
function webpush() {
  if (_wp !== undefined) return _wp;
  try {
    _wp = require("web-push");
    _wp.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@example.com", process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  } catch { _wp = null; }
  return _wp;
}
async function pushDevices(u) {
  const rows = (await redis("HGETALL", key(u, "push"))) || [];
  const out = [];
  for (let i = 0; i < rows.length; i += 2) { try { out.push({ id: rows[i], ...JSON.parse(rows[i + 1]) }); } catch {} }
  return out;
}
async function pushSubscribe(u, sub) {
  const ep = sub && String(sub.endpoint || "");
  if (!pushEnabled()) throw Object.assign(new Error("Notifikasi web belum diaktifkan oleh pemilik server (env VAPID)."), { status: 400 });
  if (!/^https:\/\//.test(ep) || ep.length > 1000 || !sub.keys || typeof sub.keys.p256dh !== "string" || typeof sub.keys.auth !== "string") throw Object.assign(new Error("Langganan notifikasi tidak valid."), { status: 400 });
  const id = sha(ep).slice(0, 24);
  const list = await pushDevices(u);
  if (list.length >= 5 && !list.some((d) => d.id === id)) throw Object.assign(new Error("Maksimal 5 perangkat. Matikan notifikasi di perangkat lain dulu."), { status: 400 });
  await redis("HSET", key(u, "push"), id, JSON.stringify({ sub: { endpoint: ep, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, at: Date.now() }));
  await redis("SADD", "pushusers", u);
  return { devices: (await pushDevices(u)).length };
}
async function pushUnsubscribe(u, endpoint) {
  const ep = String(endpoint || "");
  if (ep) await redis("HDEL", key(u, "push"), sha(ep).slice(0, 24));
  const n = (await pushDevices(u)).length;
  if (!n) await redis("SREM", "pushusers", u);
  return { devices: n };
}
async function pushCount(u) { return Number((await redis("HLEN", key(u, "push"))) || 0); }
async function pushUsers() { return (await redis("SMEMBERS", "pushusers")) || []; }
async function pushStatus(u) {
  return { enabled: pushEnabled(), publicKey: process.env.VAPID_PUBLIC_KEY || null, devices: await pushCount(u).catch(() => 0) };
}
// payload: { title, body, tag, nagId, urgent }. Mengembalikan jumlah perangkat yang berhasil dikirimi.
async function sendPush(u, payload) {
  if (!pushEnabled()) return 0;
  const wp = webpush();
  if (!wp) return 0;
  let sent = 0;
  for (const d of await pushDevices(u).catch(() => [])) {
    try {
      await wp.sendNotification(d.sub, JSON.stringify(payload), { TTL: 600, urgency: "high" });
      sent++;
    } catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) await redis("HDEL", key(u, "push"), d.id).catch(() => {}); // langganan sudah mati
    }
  }
  return sent;
}

// ---------- Mochi: peliharaan, misi harian, streak (satu data untuk web & Telegram) ----------
// Disimpan di u:<id>:mochi. Pergantian hari dihitung malas (saat data dibaca), jadi tidak bergantung cron.
// Dipicu dari fungsi inti (toggleTask, addExpense, addIncome, obrolan), jadi web, Telegram, dan tag chat sama-sama terhitung.
const MOCHI_LV = 100;
const MOCHI_MISSIONS = [
  { id: "chat", text: "Ngobrol dengan asisten", need: 1, xp: 10 },
  { id: "remind", text: "Pasang 1 pengingat", need: 1, xp: 15 },
  { id: "spend", text: "Catat uang hari ini", need: 1, xp: 15 },
  { id: "checkin", text: "Cerita harimu (curhat atau balas check-in)", need: 1, xp: 15 },
];
const mochiDayDiff = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY);
const mochiAddDays = (k, n) => new Date(Date.parse(k + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);
const mochiZero = () => Object.fromEntries(MOCHI_MISSIONS.map((x) => [x.id, 0]));
const mochiBlank = (day) => ({ name: "Mochi", xp: 0, en: 60, streak: 0, best: 0, frz: 1, day, m: mochiZero(), done: false, week: {}, ev: [] });

// Maju ke hari ini: hari yang terlewat mengurangi kenyang; streak diselamatkan jatah libur kalau ada.
function mochiRoll(s, today) {
  const n = Math.min(mochiDayDiff(s.day, today), 30);
  if (n <= 0) return false;
  let d = s.day;
  for (let i = 0; i < n; i++) {
    if (s.done) s.en = Math.max(0, s.en - 15);
    else if (s.streak > 0 && s.frz > 0) { s.frz--; s.week[d] = "frz"; s.en = Math.max(0, s.en - 35); s.ev.push("❄️ Jatah libur dipakai, streak " + s.streak + " hari aman."); }
    else { if (s.streak > 0) s.ev.push("💔 Streak " + s.streak + " hari putus. Mulai lagi hari ini."); s.streak = 0; s.week[d] = "miss"; s.en = Math.max(0, s.en - 35); }
    s.done = false;
    d = mochiAddDays(d, 1);
  }
  s.day = today;
  s.m = mochiZero();
  for (const k of Object.keys(s.week)) if (mochiDayDiff(k, today) > 14) delete s.week[k];
  s.ev = s.ev.slice(-8);
  return true;
}
async function getMochi(u) {
  const today = wib().dateKey;
  const raw = await redis("GET", key(u, "mochi"));
  let s = null;
  try { s = raw ? JSON.parse(raw) : null; } catch {}
  if (!s) {
    s = mochiBlank(today);
    await redis("SET", key(u, "mochi"), JSON.stringify(s));
    try { // akun yang baru punya Mochi: catatan uang yang sudah ada hari ini ikut dihitung
      const [ex, inc] = await Promise.all([getExpenses(u), getIncomes(u)]);
      const t0 = startOfDayWib();
      if ([...ex, ...inc].some((e) => e.ts >= t0)) { await mochiProgress(u, "spend"); s = await getMochi(u); }
    } catch {}
    return s;
  }
  s.name = s.name || "Mochi"; s.m = s.m || mochiZero(); s.week = s.week || {}; s.ev = s.ev || [];
  if (mochiRoll(s, today)) await redis("SET", key(u, "mochi"), JSON.stringify(s));
  return s;
}
// Dipanggil dari fungsi inti. Tidak pernah melempar error supaya fitur utama tidak ikut gagal.
async function mochiProgress(u, id) {
  try {
    const def = MOCHI_MISSIONS.find((x) => x.id === id);
    if (!def) return;
    const s = await getMochi(u);
    if ((s.m[id] || 0) >= def.need) return;
    s.m[id] = (s.m[id] || 0) + 1;
    s.en = Math.min(100, s.en + 8);
    if (s.m[id] >= def.need) {
      const before = Math.floor(s.xp / MOCHI_LV);
      s.xp += def.xp;
      s.ev.push("✅ Misi selesai: " + def.text + " (+" + def.xp + " XP)");
      if (Math.floor(s.xp / MOCHI_LV) > before) s.ev.push("🎉 " + s.name + " naik ke level " + (before + 2) + "!");
      if (!s.done && MOCHI_MISSIONS.every((x) => (s.m[x.id] || 0) >= x.need)) {
        s.done = true;
        s.streak++;
        s.best = Math.max(s.best || 0, s.streak);
        s.week[s.day] = "on";
        s.en = Math.min(100, s.en + 20);
        let extra = "";
        if (s.streak % 7 === 0 && s.frz < 3) { s.frz++; extra = " Dapat 1 jatah libur."; }
        s.ev.push("🔥 Semua misi selesai! Streak " + s.streak + " hari." + extra);
      }
    }
    s.ev = s.ev.slice(-8);
    await redis("SET", key(u, "mochi"), JSON.stringify(s));
  } catch {}
}
// Pesan di obrolan dihitung sebagai "cerita harimu" kalau mode curhat, atau dikirim setelah jam check-in malam.
async function mochiChat(u, mode) {
  if (mode !== "curhat") await mochiProgress(u, "chat");
  if (mode === "curhat" || wib().hour >= HOURS.checkin) await mochiProgress(u, "checkin");
}
// Ambil lalu kosongkan kabar baru (dipakai sekali oleh web atau Telegram, mana yang sedang melayani)
async function takeMochiEvents(u) {
  try {
    const s = await getMochi(u);
    if (!s.ev.length) return [];
    const ev = s.ev;
    s.ev = [];
    await redis("SET", key(u, "mochi"), JSON.stringify(s));
    return ev;
  } catch { return []; }
}
// Nama peliharaan: 1-16 karakter, tanpa tanda kurung siku/sudut; kosong = kembali ke "Mochi"
async function mochiRename(u, name) {
  const n = String(name || "").replace(/[<>\[\]{}\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim().slice(0, 16).trim();
  const s = await getMochi(u);
  s.name = n || "Mochi";
  await redis("SET", key(u, "mochi"), JSON.stringify(s));
  return s.name;
}
function mochiView(s) {
  const dn = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];
  const w = [];
  for (let i = 6; i >= 0; i--) {
    const k = mochiAddDays(s.day, -i);
    w.push({ d: dn[new Date(k + "T00:00:00Z").getUTCDay()], st: i === 0 ? (s.done ? "on" : "") : (s.week[k] || ""), today: i === 0 });
  }
  return {
    name: s.name || "Mochi", xp: s.xp, level: Math.floor(s.xp / MOCHI_LV) + 1, cur: s.xp % MOCHI_LV, lvlSize: MOCHI_LV,
    en: s.en, streak: s.streak, best: s.best || 0, frz: s.frz, done: s.done, day: s.day, week: w,
    missions: MOCHI_MISSIONS.map((x) => ({ id: x.id, text: x.text, need: x.need, xp: x.xp, n: Math.min(s.m[x.id] || 0, x.need) })),
  };
}
function mochiText(s) {
  const v = mochiView(s);
  const mood = s.en >= 60 ? "senang" : s.en >= 30 ? "mulai lapar" : "lemas";
  const bar = (n, t) => "▰".repeat(Math.round((n / t) * 10)) + "▱".repeat(10 - Math.round((n / t) * 10));
  return `🐾 ${v.name} (level ${v.level}) sedang ${mood}\nKenyang ${bar(v.en, 100)} ${v.en}%\nXP ${bar(v.cur, v.lvlSize)} ${v.cur}/${v.lvlSize}\n🔥 Streak ${v.streak} hari (terbaik ${v.best}) · ❄️ Jatah libur ${v.frz}\n\nMisi hari ini:\n` +
    v.missions.map((m) => `${m.n >= m.need ? "✅" : "▫️"} ${m.text} (${m.n}/${m.need})`).join("\n");
}

const stripTags =  (t) => String(t || "").replace(/\[\[[A-Z_]+:[\s\S]*?\]\]/g, "").trim();

module.exports = {
  TZ, DAY, HOUR, HOURS, BTN,
  uid, key, MAX_KEYS, getBot, saveBot, setupBot, removeBot, relinkBot, botStatus, botUsers, listGeminiKeys, getModelCfg, saveModelCfg, listGeminiModels, keyState, quotaStatus, getKeyHistory, clearKeyHistory, testGeminiKey, addGeminiKey, renameGeminiKey, deleteGeminiKey, moveGeminiKey,
  redis, tg, sendTelegram, downloadTelegramFile, gemini, geminiRaw, geminiSearch, sourceLine, REMIND_INTENT, trimHist, appendModelToHist,
  fmtWib, fmtTime, fmtDateShort, wib, startOfDayWib, nextRepeat, parseRepeat, repeatLabel, rupiah,
  cfgOn, getLocation, setLocation, getWeather, getNews,
  recapText, deleteExpenseNumber, loadContext, buildSystem, loadCurhatContext, buildCurhatSystem, stripTags,
  getTasks, addTask, toggleTask, deleteTask, unlinkTaskReminder, parseWib, fmtDue,
  getNotes, addNote, deleteNoteById,
  getExpenses, addExpense, deleteExpenseById, getSaldo, setSaldo, addOutsideMoney, moneyContext,
  getIncomes, addIncome, deleteIncomeById, incomesSince, moneySummary, incomeListText, deleteIncomeNumber,
  getProfile, saveProfile, getFacts, addFacts, clearFacts,
  getMode, setMode, switchMode, takeCurhatExpiredNotice, CURHAT_TTL,
  getHist, saveHist, hasHist, clearHist,
  createNag, dropNag, getNag, ackNag, nagKeyboard, NAG_MAX, NAG_STEP, sendPush, pushSubscribe, pushUnsubscribe, pushUsers, pushCount, pushStatus,
  getMochi, mochiRename, mochiProgress, mochiChat, takeMochiEvents, mochiView, mochiText,
  getReminders, addReminder, dropDuplicateReminders, deleteReminderById, deleteReminderNumber, rescheduleReminderNumber, DELETE_INTENT,
  findDeleteTargets, planDeletes, getPendingDelete, resolvePendingDelete, deleteQuestion, deleteKeyboard, mentionsAmount, getLink, linkStatus, makeLinkCode, useLinkCode, unlinkPartner, incomingTransfers, sendTransfer, acceptTransfer, declineTransfer, handlePartnerIncome, answerDupMasuk, partnerContext,
};
