// Dipanggil tiap menit oleh cron-job.org: /api/cron?key=CRON_SECRET
// Tugasnya: kirim pengingat yang jatuh tempo, ringkasan pagi, check-in malam, dan rekap mingguan.
const {
  DAY, HOURS, redis, key, getBot, botUsers, sendTelegram, gemini: geminiBase, appendModelToHist,
  fmtWib, fmtTime, fmtDue, wib, startOfDayWib, nextRepeat, repeatLabel, getTasks,
  cfgOn, getMochi, mochiText, createNag, dropNag, getNag, nagKeyboard, NAG_MAX, NAG_STEP, sendPush, pushUsers, pushCount, getWeather, recapText, loadContext, buildSystem, loadCurhatContext, buildCurhatSystem, getMode,
} = require("./_lib");

const gemini = (u, system, contents) => geminiBase(u, system, contents, "otomatis"); // riwayat key menandai sumbernya


// Tandai "sudah dikirim" secara atomik supaya tidak terkirim dobel
async function once(k, ttlSec) {
  return (await redis("SET", k, "1", "NX", "EX", String(ttlSec))) === "OK";
}

const stripTags = (s) => s.replace(/\[\[(TASK|REMIND|INGAT|BELI|MASUK|KIRIM|PASANGAN_MASUK|CATAT|SALDO|HAPUS_PENGINGAT):[\s\S]*?\]\]/g, "").trim();
const inWindow = (hour, start, len = 3) => hour >= start && hour < start + len;

// ---- Pengingat (termasuk yang berulang) ----
async function runReminders(u, chatId) {
  const now = Date.now();
  const rows = await redis("ZRANGEBYSCORE", key(u, "reminders"), "-inf", now, "WITHSCORES");
  let sent = 0;
  let tasks = null; // dimuat sekali kalau ada pengingat tugas
  for (let i = 0; i < (rows || []).length; i += 2) {
    const member = rows[i];
    const score = Number(rows[i + 1]);

    // ZREM dulu: hanya satu pemanggil yang "menang"
    if (Number(await redis("ZREM", key(u, "reminders"), member)) !== 1) continue;

    let item;
    try { item = JSON.parse(member); } catch { continue; }

    // Pengingat milik tugas: lewati kalau tugasnya sudah selesai/dihapus; sertakan nomor tugas untuk /tugasdone
    let msg;
    if (item.tid) {
      if (!tasks) tasks = await getTasks(u);
      const idx = tasks.findIndex((t) => t.id === item.tid);
      if (idx < 0 || tasks[idx].done) continue;
      msg = `⏰ Waktunya: ${item.text}\nSelesai? Ketik /tugasdone ${idx + 1}`;
    } else {
      const label = item.repeat ? ` (${repeatLabel(item.repeat)})` : "";
      msg = `⏰ Pengingat${label}: ${item.text}`;
    }
    // Pengingat sekali jalan bisa diulang kalau tidak ditanggapi (tombol Sudah / Tunda); yang berulang tidak
    const nagId = item.repeat ? null : await createNag(u, item.text, item.tid || null, await cfgOn(u, "nag"));
    let ok = false;
    if (chatId) ok = await sendTelegram(u, chatId, msg, nagId ? { reply_markup: nagKeyboard(nagId) } : {});
    const pushed = await sendPush(u, { title: "⏰ Pengingat", body: item.text, tag: "rem-" + (nagId || item.id || score), nagId, urgent: true });
    ok = ok || pushed > 0;
    if (!ok) {
      if (nagId) await dropNag(u, nagId);
      await redis("ZADD", key(u, "reminders"), Date.now() + 5 * 60 * 1000, member); // coba lagi 5 menit
      continue;
    }
    sent++;

    if (item.repeat) {
      let next = nextRepeat(score, item.repeat);
      while (next !== null && next <= now && (!item.until || next <= item.until)) next = nextRepeat(next, item.repeat);
      if (next && (!item.until || next <= item.until)) await redis("ZADD", key(u, "reminders"), next, member); // berhenti setelah batas "sampai"
    }
  }
  return { due: (rows || []).length / 2, sent };
}

// ---- Pengingat ulang: 5 menit setelah pengingat, lalu tiap 1 menit, maksimal NAG_MAX kali ----
async function runNags(u, chatId) {
  const now = Date.now();
  const ids = await redis("ZRANGEBYSCORE", key(u, "nags"), "-inf", now);
  if (!(ids || []).length) return { sent: 0 };
  const on = await cfgOn(u, "nag");
  let sent = 0;
  let tasks = null;
  for (const id of ids) {
    if (Number(await redis("ZREM", key(u, "nags"), id)) !== 1) continue; // hanya satu pemanggil yang "menang"
    const d = await getNag(u, id);
    if (!d) continue; // sudah ditekan Sudah/Tunda
    if (!on) { await dropNag(u, id); continue; }
    if (d.tid) { // tugasnya sudah selesai/dihapus: berhenti
      if (!tasks) tasks = await getTasks(u);
      const t = tasks.find((x) => x.id === d.tid);
      if (!t || t.done) { await dropNag(u, id); continue; }
    }
    const n = d.n + 1;
    const last = n >= NAG_MAX;
    const msg = `🔔 Pengingat (ulang ${n}/${NAG_MAX}): ${d.text}` + (last ? "\nIni yang terakhir." : "");
    let ok = false;
    if (chatId) ok = await sendTelegram(u, chatId, msg, { reply_markup: nagKeyboard(id) });
    const pushed = await sendPush(u, { title: `🔔 Pengingat (${n}/${NAG_MAX})`, body: d.text, tag: "rem-" + id, nagId: id, urgent: true });
    if (ok || pushed > 0) sent++;
    if (last) await dropNag(u, id);
    else {
      d.n = n;
      await redis("SET", key(u, "nag:" + id), JSON.stringify(d), "EX", "21600");
      await redis("ZADD", key(u, "nags"), Date.now() + NAG_STEP, id);
    }
  }
  return { sent };
}

// ---- Ringkasan pagi ----
async function morning(u, chatId) {
  const w = wib();
  if (!inWindow(w.hour, HOURS.morning)) return "skip";
  if (!(await cfgOn(u, "pagi"))) return "off";
  if (!(await once(key(u, `sent:pagi:${w.dateKey}`), 2 * DAY / 1000))) return "done";

  const ctx = await loadContext(u);
  const dayStart = startOfDayWib();
  const todays = ctx.reminders.filter((r) => r.ts >= dayStart && r.ts < dayStart + DAY);
  const todayLines = todays.length
    ? todays.map((r) => `- ${r.text} (jam ${fmtTime(r.ts)})`).join("\n")
    : "(tidak ada pengingat hari ini)";
  let weather = "";
  try { weather = await getWeather(u); } catch {}

  // Daftar tetap (tidak bergantung Gemini): tugas belum selesai tanpa jam, atau jamnya sudah lewat
  const open = (ctx.tasks || []).map((t, i) => ({ ...t, n: i + 1 })).filter((t) => !t.done && (!t.due || t.due < dayStart));
  const taskBlock = open.length
    ? "\n\n📝 Tugas belum selesai:\n" + open.slice(0, 15).map((t) => `${t.n}. ${t.text}${t.due ? " (terlewat, " + fmtDue(t.due) + ")" : ""}`).join("\n")
    : "";

  const fallback =
    `☀️ Selamat pagi!\n${fmtWib(Date.now())}\n\n` +
    (weather ? `⛅ ${weather}\n\n` : "") +
    `Pengingat hari ini:\n${todayLines}` + taskBlock;

  let text = fallback;
  try {
    const out = stripTags(
      await gemini(u, buildSystem("asisten", ctx), [
        {
          role: "user",
          parts: [{
            text:
              `[Pesan otomatis sistem] Tulis ringkasan pagi untuk pengguna, maksimal 6 baris, hangat dan ringkas. ` +
              `Sebut namanya jika kamu tahu. Beri satu saran kecil sesuai cuaca bila relevan. Daftar tugas yang belum selesai akan ditempel otomatis di bawah pesanmu, jadi jangan menyebutkannya satu-satu.\n\n` +
              `Tanggal: ${fmtWib(Date.now())}\nCuaca: ${weather || "(tidak tersedia)"}\nPengingat hari ini:\n${todayLines}`,
          }],
        },
      ])
    );
    if (out) text = out + taskBlock;
  } catch {}

  const ok = await sendTelegram(u, chatId, text);
  if (!ok) { await redis("DEL", key(u, `sent:pagi:${w.dateKey}`)); return "gagal kirim"; }
  await appendModelToHist(u, text, "asisten"); // ringkasan pagi berisi tugas: selalu ke riwayat asisten
  return "terkirim";
}

// ---- Check-in malam ----
async function checkin(u, chatId) {
  const w = wib();
  if (!inWindow(w.hour, HOURS.checkin, 2)) return "skip";
  if (!(await cfgOn(u, "checkin"))) return "off";
  if (!(await once(key(u, `sent:checkin:${w.dateKey}`), 2 * DAY / 1000))) return "done";

  const ctx = await loadCurhatContext(u); // tanpa tugas/catatan/uang: hanya nama dan hal yang diingat
  let text = "Malam 🌙 Gimana harimu hari ini? Mau cerita?";
  try {
    const out = stripTags(
      await gemini(u, buildCurhatSystem(ctx), [
        {
          role: "user",
          parts: [{
            text:
              "[Pesan otomatis sistem] Tulis pesan check-in malam singkat (2-3 kalimat) yang menanyakan kabar harinya dengan hangat. " +
              "Boleh merujuk hal yang kamu tahu tentang pengguna. Satu pertanyaan terbuka di akhir. Jangan menggurui.",
          }],
        },
      ])
    );
    if (out) text = out;
  } catch {}

  const ok = await sendTelegram(u, chatId, text);
  if (!ok) { await redis("DEL", key(u, `sent:checkin:${w.dateKey}`)); return "gagal kirim"; }
  await appendModelToHist(u, text, await getMode(u)); // balasan pengguna akan masuk ke riwayat mode yang aktif, jadi nyambung
  return "terkirim";
}

// ---- Rekap pengeluaran mingguan (Minggu malam) ----
async function weeklyRecap(u, chatId) {
  const w = wib();
  if (w.weekday !== 0 || !inWindow(w.hour, HOURS.recap, 3)) return "skip";
  if (!(await cfgOn(u, "rekapauto"))) return "off";
  if (!(await once(key(u, `sent:rekap:${w.dateKey}`), 2 * DAY / 1000))) return "done";

  const r = await recapText(u);
  if (!r.weekCount) return "kosong";
  const ok = await sendTelegram(u, chatId, "📊 Rekap mingguan\n\n" + r.text);
  if (!ok) { await redis("DEL", key(u, `sent:rekap:${w.dateKey}`)); return "gagal kirim"; }
  return "terkirim";
}

// ---- Pengingat Mochi: sore, kalau misi hari ini belum selesai ----
async function mochiNudge(u, chatId) {
  const w = wib();
  if (!inWindow(w.hour, HOURS.checkin - 1, 1)) return "skip";
  if (!(await cfgOn(u, "mochi"))) return "off";
  const s = await getMochi(u); // sekaligus mengejar pergantian hari
  if (s.done) return "selesai";
  if (!(await once(key(u, `sent:mochi:${w.dateKey}`), 2 * DAY / 1000))) return "done";
  const risk = s.streak > 0 ? `\n🔥 Streak ${s.streak} hari bisa putus kalau hari ini terlewat${s.frz > 0 ? " (ada " + s.frz + " jatah libur)" : ""}.` : "";
  const ok = await sendTelegram(u, chatId, "🐾 " + (s.name || "Mochi") + " menunggu kamu.\n\n" + mochiText(s).split("\n\n")[1] + risk);
  if (!ok) { await redis("DEL", key(u, `sent:mochi:${w.dateKey}`)); return "gagal kirim"; }
  return "terkirim";
}

async function guarded(out, name, fn) {
  try { out[name] = await fn(); } catch (e) { out[name] = "error: " + e.message; }
}

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const authorized =
    secret && (req.query.key === secret || req.headers.authorization === `Bearer ${secret}`);
  if (!authorized) return res.status(401).json({ error: "unauthorized" });

  const out = {};
  // Pengguna dengan bot Telegram dan/atau notifikasi web
  const users = [...new Set([...(await botUsers()), ...(await pushUsers().catch(() => []))])];
  for (const u of users) {
    const bot = await getBot(u).catch(() => null);
    const chatId = bot && bot.chatId ? bot.chatId : null;
    if (!chatId && !(await pushCount(u).catch(() => 0))) { out[u] = "belum terhubung"; continue; }
    const r = (out[u] = {});
    await guarded(r, "reminders", () => runReminders(u, chatId)); // yang paling penting dulu
    await guarded(r, "nags", () => runNags(u, chatId));
    if (!chatId) continue; // pesan otomatis lain hanya lewat Telegram
    await guarded(r, "pagi", () => morning(u, chatId));
    await guarded(r, "checkin", () => checkin(u, chatId));
    await guarded(r, "rekap", () => weeklyRecap(u, chatId));
    await guarded(r, "mochi", () => mochiNudge(u, chatId));
  }
  return res.status(200).json(out);
};
