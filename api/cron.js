// Dipanggil tiap menit oleh cron-job.org: /api/cron?key=CRON_SECRET
// Tugasnya: kirim pengingat yang jatuh tempo, ringkasan pagi, check-in malam, dan rekap mingguan.
const {
  DAY, HOURS, redis, key, getBot, botUsers, sendTelegram, gemini: geminiBase, appendModelToHist,
  fmtWib, fmtTime, fmtDue, wib, startOfDayWib, nextRepeat, getTasks,
  cfgOn, getWeather, recapText, loadContext, buildSystem,
} = require("./_lib");

const gemini = (u, system, contents) => geminiBase(u, system, contents, "otomatis"); // riwayat key menandai sumbernya

const REPEAT_LABEL = { harian: "tiap hari", mingguan: "tiap minggu", bulanan: "tiap bulan" };

// Tandai "sudah dikirim" secara atomik supaya tidak terkirim dobel
async function once(k, ttlSec) {
  return (await redis("SET", k, "1", "NX", "EX", String(ttlSec))) === "OK";
}

const stripTags = (s) => s.replace(/\[\[(REMIND|INGAT|BELI|MASUK|CATAT|SALDO):[\s\S]*?\]\]/g, "").trim();
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
      const label = item.repeat ? ` (${REPEAT_LABEL[item.repeat]})` : "";
      msg = `⏰ Pengingat${label}: ${item.text}`;
    }
    const ok = await sendTelegram(u, chatId, msg);
    if (!ok) {
      await redis("ZADD", key(u, "reminders"), Date.now() + 5 * 60 * 1000, member); // coba lagi 5 menit
      continue;
    }
    sent++;

    if (item.repeat) {
      let next = nextRepeat(score, item.repeat);
      while (next !== null && next <= now) next = nextRepeat(next, item.repeat);
      if (next) await redis("ZADD", key(u, "reminders"), next, member);
    }
  }
  return { due: (rows || []).length / 2, sent };
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
  await appendModelToHist(u, text);
  return "terkirim";
}

// ---- Check-in malam ----
async function checkin(u, chatId) {
  const w = wib();
  if (!inWindow(w.hour, HOURS.checkin, 2)) return "skip";
  if (!(await cfgOn(u, "checkin"))) return "off";
  if (!(await once(key(u, `sent:checkin:${w.dateKey}`), 2 * DAY / 1000))) return "done";

  const ctx = await loadContext(u);
  let text = "Malam 🌙 Gimana harimu hari ini? Mau cerita?";
  try {
    const out = stripTags(
      await gemini(u, buildSystem("curhat", ctx), [
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
  await appendModelToHist(u, text);
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

async function guarded(out, name, fn) {
  try { out[name] = await fn(); } catch (e) { out[name] = "error: " + e.message; }
}

module.exports = async (req, res) => {
  const secret = process.env.CRON_SECRET;
  const authorized =
    secret && (req.query.key === secret || req.headers.authorization === `Bearer ${secret}`);
  if (!authorized) return res.status(401).json({ error: "unauthorized" });

  const out = {};
  for (const u of await botUsers()) {
    const bot = await getBot(u).catch(() => null);
    if (!bot || !bot.chatId) { out[u] = "belum terhubung"; continue; }
    const r = (out[u] = {});
    await guarded(r, "reminders", () => runReminders(u, bot.chatId)); // yang paling penting dulu
    await guarded(r, "pagi", () => morning(u, bot.chatId));
    await guarded(r, "checkin", () => checkin(u, bot.chatId));
    await guarded(r, "rekap", () => weeklyRecap(u, bot.chatId));
  }
  return res.status(200).json(out);
};
