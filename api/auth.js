// Vercel Serverless Function: /api/auth
// POST {op:"register", username, password, invite}  -> buat akun + login
// POST {op:"login", username, password}             -> login
// POST {op:"changePassword", oldPassword, newPassword}
// POST {op:"logout"}                                -> keluar
// GET                                               -> {user} kalau sudah login

const crypto = require("crypto");
const { redis } = require("./_lib");
const {
  safeEq, hashPassword, verifyPassword,
  setSessionCookie, clearSessionCookie, readSession, rateLimit, requireUser,
} = require("./_auth");

const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

// Data lama (global, tanpa awalan) dipindah ke akun pemilik. RENAME atomik per key.
const LEGACY_KEYS = ["tasks", "notes", "mode", "hist", "profile", "loc", "facts", "reminders", "cfg"];

async function migrateLegacy(userId) {
  const expKeys = (await redis("KEYS", "exp:*")) || [];
  const moved = [];
  for (const k of [...LEGACY_KEYS, ...expKeys]) {
    try {
      await redis("RENAME", k, `u:${userId}:${k}`);
      moved.push(k);
    } catch { /* key tidak ada: lewati */ }
  }
  return moved;
}

async function register(req, res, body) {
  const username = String(body.username || "").trim().toLowerCase();
  const password = String(body.password || "");
  const invite = String(body.invite || "");

  const code = process.env.INVITE_CODE;
  if (!code) return res.status(500).json({ error: "INVITE_CODE belum diisi di Vercel." });
  if (!(await rateLimit(req, "reg", 10, 900))) return res.status(429).json({ error: "Terlalu banyak percobaan. Coba lagi nanti." });
  if (!safeEq(invite, code)) return res.status(403).json({ error: "Kode undangan salah." });
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: "Username 3-20 karakter: huruf kecil, angka, atau _." });
  if (password.length < 8 || password.length > 200) return res.status(400).json({ error: "Password minimal 8 karakter." });

  const id = crypto.randomBytes(8).toString("hex");
  const created = await redis("SET", `user:${username}`, JSON.stringify({ id, hash: hashPassword(password) }), "NX");
  if (created !== "OK") return res.status(409).json({ error: "Username sudah dipakai." });
  await redis("SET", `uid:${id}`, username);

  // Pemilik data lama: akun OWNER_USERNAME (kalau diisi), kalau tidak, akun pertama.
  let migrated = [];
  const ownerName = (process.env.OWNER_USERNAME || "").trim().toLowerCase();
  if (!ownerName || ownerName === username) {
    if ((await redis("SET", "legacy:owner", id, "NX")) === "OK") migrated = await migrateLegacy(id);
  }

  setSessionCookie(res, id);
  return res.status(200).json({ ok: true, user: { id, username }, migrated: migrated.length });
}

async function login(req, res, body) {
  const username = String(body.username || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!(await rateLimit(req, "login", 10, 900))) return res.status(429).json({ error: "Terlalu banyak percobaan. Coba lagi nanti." });

  const raw = USERNAME_RE.test(username) ? await redis("GET", `user:${username}`) : null;
  let rec = null;
  try { rec = raw ? JSON.parse(raw) : null; } catch {}
  // Tetap hitung hash saat user tidak ada supaya waktu respons seragam
  const ok = verifyPassword(password, rec ? rec.hash : "AAAA:AAAA") && !!rec;
  if (!ok) return res.status(401).json({ error: "Username atau password salah." });

  setSessionCookie(res, rec.id);
  return res.status(200).json({ ok: true, user: { id: rec.id, username } });
}

async function changePassword(req, res, body) {
  const id = await requireUser(req, res);
  if (!id) return;
  const oldPw = String(body.oldPassword || "");
  const newPw = String(body.newPassword || "");
  if (!(await rateLimit(req, "chpw", 10, 900))) return res.status(429).json({ error: "Terlalu banyak percobaan. Coba lagi nanti." });
  if (newPw.length < 8 || newPw.length > 200) return res.status(400).json({ error: "Password baru minimal 8 karakter." });
  const username = await redis("GET", `uid:${id}`);
  const rec = JSON.parse(await redis("GET", `user:${username}`));
  if (!verifyPassword(oldPw, rec.hash)) return res.status(403).json({ error: "Password lama salah." });
  await redis("SET", `user:${username}`, JSON.stringify({ ...rec, hash: hashPassword(newPw) }));
  return res.status(200).json({ ok: true });
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "GET") {
      const id = readSession(req);
      const name = id ? await redis("GET", `uid:${id}`) : null;
      if (!name) return res.status(401).json({ error: "Belum login." });
      return res.status(200).json({ user: { id, username: name } });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "Metode tidak didukung" });

    const body = req.body || {};
    if (body.op === "register") return await register(req, res, body);
    if (body.op === "login") return await login(req, res, body);
    if (body.op === "changePassword") return await changePassword(req, res, body);
    if (body.op === "logout") { clearSessionCookie(res); return res.status(200).json({ ok: true }); }
    return res.status(400).json({ error: "op tidak dikenal" });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + e.message });
  }
};
