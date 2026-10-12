// Autentikasi: akun (username + password), sesi cookie bertanda tangan, kode undangan.
// Hanya memakai crypto bawaan Node.

const crypto = require("crypto");
const { redis } = require("./_lib");

const COOKIE = "sid";
const SESSION_DAYS = 30;

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new Error("SESSION_SECRET belum diisi (min. 16 karakter) di Vercel");
  return s;
}

const b64u = (b) => Buffer.from(b).toString("base64url");
const sign = (data) => crypto.createHmac("sha256", secret()).update(data).digest("base64url");

function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------- Password (scrypt) ----------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `${salt.toString("base64")}:${hash.toString("base64")}`;
}
function verifyPassword(pw, stored) {
  const [s, h] = String(stored || "").split(":");
  if (!s || !h) return false;
  const hash = crypto.scryptSync(pw, Buffer.from(s, "base64"), 64);
  return crypto.timingSafeEqual(hash, Buffer.from(h, "base64"));
}

// ---------- Sesi ----------
function makeSession(userId) {
  const payload = b64u(JSON.stringify({ u: userId, exp: Date.now() + SESSION_DAYS * 86400000 }));
  return `${payload}.${sign(payload)}`;
}
function readSession(req) {
  const m = String(req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const [payload, sig] = decodeURIComponent(m[1]).split(".");
  if (!payload || !sig || !safeEq(sig, sign(payload))) return null;
  try {
    const d = JSON.parse(Buffer.from(payload, "base64url").toString());
    return d.exp > Date.now() ? d.u : null;
  } catch { return null; }
}
function setSessionCookie(res, userId) {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${encodeURIComponent(makeSession(userId))}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`
  );
}
function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
}

// Dipakai endpoint data: kembalikan userId, atau balas 401 dan kembalikan null.
// Pastikan akunnya masih ada (misal sudah dihapus).
async function requireUser(req, res) {
  let uid;
  try { uid = readSession(req); }
  catch (e) { res.status(500).json({ error: e.message }); return null; }
  if (!uid) { res.status(401).json({ error: "Belum login." }); return null; }
  const ok = await redis("EXISTS", `uid:${uid}`);
  if (Number(ok) !== 1) { res.status(401).json({ error: "Akun tidak ditemukan." }); return null; }
  return uid;
}

// Batas percobaan per IP (anti tebak password / kode undangan)
async function rateLimit(req, name, max, windowSec) {
  const ip = String(req.headers["x-forwarded-for"] || "x").split(",")[0].trim();
  const k = `rl:${name}:${ip}`;
  const n = Number(await redis("INCR", k));
  if (n === 1) await redis("EXPIRE", k, String(windowSec));
  return n <= max;
}

// Pemilik lama (data global sebelum ada akun). Dipakai bot Telegram & cron
// sampai Tahap 3 (bot per pengguna).
async function getOwnerId() {
  return redis("GET", "legacy:owner");
}

module.exports = {
  safeEq, hashPassword, verifyPassword,
  setSessionCookie, clearSessionCookie, readSession, requireUser,
  rateLimit, getOwnerId,
};
