// Dipanggil tiap menit oleh cron-job.org: /api/cron?key=CRON_SECRET
// Tugasnya: kirim pengingat yang jatuh tempo, ringkasan pagi, check-in malam, dan rekap mingguan.
const {
  DAY, HOURS, redis, sendTelegram, gemini, appendModelToHist,
  fmtWib, fmtTime, wib, startOfDayWib, nextRepeat,
  cfgOn, getWeather, recapText, loadContext, buildSystem,
} = require("./_lib");

const REPEAT_LABEL = { harian: "tiap hari", mingguan: "tiap minggu", bulanan: "tiap bulan" };

// Tandai "sudah dikirim" secara atomik supaya tidak terkirim dobel
async function once(key, ttlSec) {
  return (await redis("SET", key, "1", "NX", "EX", String(ttlSec))) === "OK";
}

const stripTags = (s) => s.replace(/\[\[(REMIND|INGAT|BELI|CATAT):[\s\S]*?\]\]/g, "").trim();
const inWindow = (hour, start, len = 3) => hour >= start && hour < start + len;

// ---- Pengingat (termasuk yang berulang) ----
async function runReminders(chatId) {
  const now = Date.now();
  const rows = await redis("ZRANGEBYSCORE", "reminders", "-inf", now, "WITHSCORES");
  let sent = 0;
  for (let i = 0; i < (rows || []).length; i += 2) {
    const member = rows[i];
    const score = Number(rows[i + 1]);

    // ZREM dulu: hanya satu pemanggil yang "menang"
    if (Number(await redis("ZREM", "reminders", member)) !== 1) continue;

    let item;
    try { item = JSON.parse(member); } catch { continue; }

    const label = item.repeat ? ` (${REPEAT_LABEL[item.repeat]})` : "";
    const ok = await sendTelegram(chatId, `⏰ Pengingat${label}: ${item.text}`);
    if (!ok) {
      await redis("ZADD", "reminders", Date.now() + 5 * 60 * 1000, member); // coba lagi 5 menit
      continue;
    }
    sent++;

    if (item.repeat) {
      let next = nextRepeat(score, item.repeat);
      while (next !== null && next <= now) next = nextRepeat(next, item.repeat);
      if (next) await redis("ZADD", "reminders", next, member);
    }
  }
  return { due: (rows || []).length / 2, sent };
}

// ---- Ringkasan pagi ----
async function morning(chatId) {
  const w = wib();
  if (!inWindow(w.hour, HOURS.morning)) return "skip";
  if (!(await cfgOn("pagi"))) return "off";
  if (!(await once(`sent:pagi:${w.dateKey}`, 2 * DAY / 1000))) return "done";

  const ctx = await loadContext();
  const dayStart = startOfDayWib();
  const todays = ctx.reminders.filter((r) => r.ts >= dayStart && r.ts < dayStart + DAY);
  const todayLines = todays.length
    ? todays.map((r) => `- ${r.text} (jam ${fmtTime(r.ts)})`).join("\n")
    : "(tidak ada pengingat hari ini)";
  let weather = "";
  try { weather = await getWeather(); } catch {}

  const fallback =
    `☀️ Selamat pagi!\n${fmtWib(Date.now())}\n\n` +
    (weather ? `⛅ ${weather}\n\n` : "") +
    `Pengingat hari ini:\n${todayLines}`;

  let text = fallback;
  try {
    const out = stripTags(
      await gemini(buildSystem("asisten", ctx), [
        {
          role: "user",
          parts: [{
            text:
              `[Pesan otomatis sistem] Tulis ringkasan pagi untuk pengguna, maksimal 6 baris, hangat dan ringkas. ` +
              `Sebut namanya jika kamu tahu. Beri satu saran kecil sesuai cuaca bila relevan.\n\n` +
              `Tanggal: ${fmtWib(Date.now())}\nCuaca: ${weather || "(tidak tersedia)"}\nPengingat hari ini:\n${todayLines}`,
          }],
        },
      ])
    );
    if (out) text = out;
  } catch {}

  const ok = await sendTelegram(chatId, text);
  if (!ok) { await redis("DEL", `sent:pagi:${w.dateKey}`); return "gagal kirim"; }
  await appendModelToHist(text);
  return "terkirim";
}

// ---- Check-in malam ----
async function checkin(chatId) {
  const w = wib();
  if (!inWindow(w.hour, HOURS.checkin, 2)) return "skip";
  if (!(await cfgOn("checkin"))) return "off";
  if (!(await once(`sent:checkin:${w.dateKey}`, 2 * DAY / 1000))) return "done";

  const ctx = await loadContext();
  let text = "Malam 🌙 Gimana harimu hari ini? Mau cerita?";
  try {
    const out = stripTags(
      await gemini(buildSystem("curhat", ctx), [
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

  const ok = await sendTelegram(chatId, text);
  if (!ok) { await redis("DEL", `sent:checkin:${w.dateKey}`); return "gagal kirim"; }
  await appendModelToHist(text);
  return "terkirim";
}

// ---- Rekap pengeluaran mingguan (Minggu malam) ----
async function weeklyRecap(chatId) {
  const w = wib();
  if (w.weekday !== 0 || !inWindow(w.hour, HOURS.recap, 3)) return "skip";
  if (!(await cfgOn("rekapauto"))) return "off";
  if (!(await once(`sent:rekap:${w.dateKey}`, 2 * DAY / 1000))) return "done";

  const r = await recapText();
  if (!r.weekCount) return "kosong";
  const ok = await sendTelegram(chatId, "📊 Rekap mingguan\n\n" + r.text);
  if (!ok) { await redis("DEL", `sent:rekap:${w.dateKey}`); return "gagal kirim"; }
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

  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) return res.status(500).json({ error: "TELEGRAM_CHAT_ID belum diisi" });

  const out = {};
  await guarded(out, "reminders", () => runReminders(chatId)); // yang paling penting dulu
  await guarded(out, "pagi", () => morning(chatId));
  await guarded(out, "checkin", () => checkin(chatId));
  await guarded(out, "rekap", () => weeklyRecap(chatId));
  return res.status(200).json(out);
};
