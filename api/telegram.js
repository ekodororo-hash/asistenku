// Webhook bot Telegram: /api/telegram
const {
  HOURS, BTN, redis, key, getBot, saveBot, sendTelegram, downloadTelegramFile, gemini, trimHist,
  fmtWib, wib, rupiah, cfgOn, getLocation, setLocation, getWeather, getNews,
  recapText, deleteExpenseNumber, loadContext, buildSystem,
  getTasks, addTask, toggleTask, deleteTask,
  addNote, addExpense, setSaldo,
} = require("./_lib");
const { getOwnerId, safeEq } = require("./_auth");

const PLAN_PROMPT =
  "Bantu aku susun rencana hari ini berdasarkan pengingat dan hal yang kamu tahu tentang aku. Tanya aku kalau butuh info tambahan.";

const REPEAT_LABEL = { harian: "tiap hari", mingguan: "tiap minggu", bulanan: "tiap bulan" };
const TOGGLES = { "/pagi": "pagi", "/checkin": "checkin", "/rekapauto": "rekapauto", "/salin": "mirror" };

const START_TEXT =
  "Halo! Aku asistan pribadi sekaligus teman ceritamu. Pakai tombol di bawah, atau langsung tulis, kirim foto, atau voice note.\n\n" +
  "Contoh:\n" +
  "- \"Ingatkan aku besok jam 8 bayar listrik\"\n" +
  "- \"Ingatkan tiap Senin jam 9 rapat tim\"\n" +
  "- \"makan siang 25rb\" (catat pengeluaran)\n" +
  "- \"catat: ide konten minggu depan\"\n" +
  "- kirim foto struk, atau voice note\n\n" +
  "Perintah:\n" +
  "/pengingat  /hapus N\n" +
  "/tugas  /tugasdone N  /hapustugas N\n" +
  "/rekap (lalu balas nomor untuk hapus)  /batal\n" +
  "/catatan  /cari kata  /hapuscatatan N\n" +
  "/cuaca  /lokasi kota  /berita topik\n" +
  "/memori  /lupakan  /atur\n\n" +
  `Otomatis: ringkasan pagi, check-in malam, dan rekap pengeluaran mingguan. Atur di /atur.\n` +
  "Aku mengingat hal-hal penting tentangmu supaya ngobrolnya nyambung. Lihat dengan /memori, hapus dengan /lupakan.\n\n" +
  "Tugas, catatan, uang, dan obrolan di sini sama persis dengan yang ada di web. Pesan yang kamu tulis di web juga disalin ke sini (matikan dengan /salin off).";

// ---------- Hapus pengeluaran (dipakai /hapusbeli dan balasan angka setelah /rekap) ----------
// Mengembalikan true kalau selesai (berhasil / memang kosong), false kalau nomor salah (pengguna boleh coba lagi).
async function hapusBeli(u, n, say) {
  const r = await deleteExpenseNumber(u, n);
  if (r.empty) { await say("Tidak ada pengeluaran bulan ini yang bisa dihapus."); return true; }
  if (r.range) { await say(`Nomor ${n} tidak ada. Bulan ini ada ${r.range} entri; balas dengan nomor yang tertera di daftar.`); return false; }
  if (r.fail) { await say("Gagal menghapus entri."); return true; }
  await say(`🗑️ Dihapus: ${r.item.note || r.item.cat || "?"} (${rupiah(r.item.amt || 0)})`);
  return true;
}

// ---------- Perintah ----------
async function handleCommand(u, cmd, arg, say) {
  switch (cmd) {
    case "/start":
    case "/help":
      await say(START_TEXT);
      return;

    case "/curhat":
      await redis("SET", key(u, "mode"), "curhat");
      await say("Oke, aku dengerin. Cerita aja, pelan-pelan juga gapapa.");
      return;

    case "/asisten":
      await redis("SET", key(u, "mode"), "asisten");
      await say("Siap, balik ke mode asisten. Ada yang perlu dibantu?");
      return;

    case "/reset":
      await redis("DEL", key(u, "hist"));
      await say("Riwayat obrolan dihapus. Hal-hal yang kuingat tentangmu tetap ada (hapus dengan /lupakan).");
      return;

    case "/memori": {
      const facts = await redis("LRANGE", key(u, "facts"), 0, -1);
      await say(
        facts && facts.length
          ? "Yang kuingat tentangmu:\n\n" + facts.map((f, i) => `${i + 1}. ${f}`).join("\n")
          : "Belum ada yang kuingat."
      );
      return;
    }

    case "/lupakan":
      await redis("DEL", key(u, "facts"));
      await say("Semua yang kuingat tentangmu sudah dihapus.");
      return;

    case "/pengingat": {
      const rows = await redis("ZRANGE", key(u, "reminders"), 0, -1, "WITHSCORES");
      if (!rows || !rows.length) {
        await say("Belum ada pengingat.");
        return;
      }
      const lines = [];
      for (let i = 0; i < rows.length; i += 2) {
        let it = {};
        try { it = JSON.parse(rows[i]); } catch {}
        const rep = it.repeat ? " [" + REPEAT_LABEL[it.repeat] + "]" : "";
        lines.push(`${lines.length + 1}. ${it.text || "?"}${rep}\n   ${fmtWib(Number(rows[i + 1]))}`);
      }
      await say("Pengingat mendatang:\n\n" + lines.join("\n") + "\n\nHapus: /hapus <nomor>");
      return;
    }

    case "/hapus": {
      const n = parseInt(arg, 10);
      const rows = await redis("ZRANGE", key(u, "reminders"), 0, -1);
      if (!n || n < 1 || n > rows.length) {
        await say("Pakai: /hapus <nomor>. Lihat nomornya di /pengingat.");
        return;
      }
      await redis("ZREM", key(u, "reminders"), rows[n - 1]);
      let it = {};
      try { it = JSON.parse(rows[n - 1]); } catch {}
      await say(`Pengingat dihapus: ${it.text || "?"}`);
      return;
    }

    case "/tugas": {
      const tasks = await getTasks(u);
      if (!tasks.length) { await say("Belum ada tugas. Tulis: tambah tugas <isi>, atau pakai web."); return; }
      const lines = tasks.map((t, i) => `${i + 1}. ${t.done ? "[selesai]" : "[belum]"} ${t.text}`);
      await say("Tugas (sama dengan di web):\n\n" + lines.join("\n") + "\n\nTandai selesai: /tugasdone N\nHapus: /hapustugas N");
      return;
    }

    case "/tugasdone": {
      const n = parseInt(arg, 10);
      const tasks = await getTasks(u);
      if (!n || n < 1 || n > tasks.length) { await say("Pakai: /tugasdone <nomor>. Lihat nomornya di /tugas."); return; }
      const t = await toggleTask(u, tasks[n - 1].id);
      await say(t ? `Tugas "${t.text}" ditandai ${t.done ? "selesai" : "belum selesai"}.` : "Gagal mengubah tugas.");
      return;
    }

    case "/hapustugas": {
      const n = parseInt(arg, 10);
      const tasks = await getTasks(u);
      if (!n || n < 1 || n > tasks.length) { await say("Pakai: /hapustugas <nomor>. Lihat nomornya di /tugas."); return; }
      const ok = await deleteTask(u, tasks[n - 1].id);
      await say(ok ? `Tugas dihapus: ${tasks[n - 1].text}` : "Gagal menghapus tugas.");
      return;
    }

    case "/cuaca":
      try { await say("⛅ " + (await getWeather(u))); }
      catch (e) { await say("Gagal mengambil cuaca: " + e.message); }
      return;

    case "/lokasi": {
      if (!arg) {
        const loc = await getLocation(u);
        await say(`Lokasi cuaca saat ini: ${loc.name}.\nGanti dengan: /lokasi <nama kota>`);
        return;
      }
      const loc = await setLocation(u, arg);
      await say(loc ? `Lokasi cuaca diganti ke ${loc.name}.` : "Kota tidak ditemukan. Coba tulis nama kota yang lain.");
      return;
    }

    case "/berita":
      try { await say(await getNews(arg), { link_preview_options: { is_disabled: true } }); }
      catch (e) { await say("Gagal mengambil berita: " + e.message); }
      return;

    case "/rekap": {
      const r = await recapText(u, true);
      await say(r.text);
      // 3 menit ke depan, balasan angka = nomor entri yang mau dihapus
      if (r.monthCount) await redis("SET", key(u, "pending"), "hapusbeli", "EX", "180");
      return;
    }

    case "/batal":
      await redis("DEL", key(u, "pending"));
      await say("Oke, dibatalkan.");
      return;

    case "/hapusbeli": {
      const n = arg ? parseInt(arg, 10) : 0;
      if (arg && (!n || n < 1)) { await say("Pakai: /hapusbeli <nomor>, contoh: /hapusbeli 2. Lihat nomornya di /rekap. Tanpa nomor menghapus entri terakhir."); return; }
      await hapusBeli(u, n, say);
      return;
    }

    case "/catatan": {
      const all = await redis("LRANGE", key(u, "notes"), 0, -1);
      if (!all || !all.length) { await say("Belum ada catatan. Tulis: catat: isi catatanmu"); return; }
      const start = Math.max(0, all.length - 10);
      const lines = all.slice(start).map((r, i) => {
        let n = {};
        try { n = JSON.parse(r); } catch {}
        return `${start + i + 1}. ${n.text}`;
      });
      await say(`Catatan terakhir (${all.length} total):\n\n` + lines.join("\n") + "\n\nCari: /cari kata  Hapus: /hapuscatatan N");
      return;
    }

    case "/cari": {
      if (!arg) { await say("Pakai: /cari <kata kunci>"); return; }
      const all = await redis("LRANGE", key(u, "notes"), 0, -1);
      const items = (all || []).map((r, i) => {
        let n = {};
        try { n = JSON.parse(r); } catch {}
        return { i: i + 1, text: n.text || "" };
      });
      const q = arg.toLowerCase();
      const hit = items.filter((x) => x.text.toLowerCase().includes(q)).slice(0, 10);
      if (hit.length) {
        await say(`Hasil untuk "${arg}":\n\n` + hit.map((x) => `${x.i}. ${x.text}`).join("\n"));
        return;
      }
      if (!items.length) { await say("Belum ada catatan."); return; }
      // Tidak ada yang cocok persis: minta Gemini mencari yang maknanya mirip
      const listing = items.slice(-100).map((x) => `${x.i}. ${x.text}`).join("\n");
      const out = await gemini(u,
        "Kamu mencari catatan pengguna. Tulis teks biasa tanpa markdown.",
        [{ role: "user", parts: [{ text: `Catatan:\n${listing}\n\nCari catatan yang relevan dengan: "${arg}". Tulis nomor dan isinya. Jika tidak ada yang relevan, katakan tidak ada.` }] }]
      );
      await say(out.trim() || "Tidak ada catatan yang cocok.");
      return;
    }

    case "/hapuscatatan": {
      const n = parseInt(arg, 10);
      const all = await redis("LRANGE", key(u, "notes"), 0, -1);
      if (!n || n < 1 || !all || n > all.length) { await say("Pakai: /hapuscatatan <nomor>. Lihat nomornya di /catatan."); return; }
      const rest = all.filter((_, i) => i !== n - 1);
      await redis("DEL", key(u, "notes"));
      if (rest.length) await redis("RPUSH", key(u, "notes"), ...rest);
      await say("Catatan dihapus.");
      return;
    }

    case "/pagi":
    case "/checkin":
    case "/rekapauto":
    case "/salin": {
      const cfgKey = TOGGLES[cmd];
      const a = arg.toLowerCase();
      if (a !== "on" && a !== "off") {
        await say(`Pakai: ${cmd} on  atau  ${cmd} off. Status lengkap: /atur`);
        return;
      }
      await redis("HSET", key(u, "cfg"), cfgKey, a);
      await say(`${cmd.slice(1)} sekarang ${a === "on" ? "aktif" : "dimatikan"}.`);
      return;
    }

    case "/atur": {
      const [p, c, r, m, loc] = await Promise.all([cfgOn(u, "pagi"), cfgOn(u, "checkin"), cfgOn(u, "rekapauto"), cfgOn(u, "mirror"), getLocation(u)]);
      const s = (b) => (b ? "aktif" : "mati");
      const jam = (h) => String(h).padStart(2, "0") + ".00";
      await say(
        "Pengaturan otomatis:\n" +
          `- Ringkasan pagi (${jam(HOURS.morning)} WIB): ${s(p)}  -> /pagi on | off\n` +
          `- Check-in malam (${jam(HOURS.checkin)} WIB): ${s(c)}  -> /checkin on | off\n` +
          `- Rekap pengeluaran (Minggu ${jam(HOURS.recap)}): ${s(r)}  -> /rekapauto on | off\n` +
          `- Salin obrolan web ke sini: ${s(m)}  -> /salin on | off\n` +
          `- Lokasi cuaca: ${loc.name}  -> /lokasi <kota>`
      );
      return;
    }

    default:
      await say("Perintah tidak dikenal. Ketik /start untuk melihat daftar.");
  }
}

// ---------- Tag dari Gemini ----------
async function processTags(u, reply) {
  const notes = [];

  // Tugas/checklist
  for (const m of reply.matchAll(/\[\[TASK:\s*([^\]]+?)\s*\]\]/g)) {
    const t = await addTask(u, m[1]);
    if (t) notes.push("✅ Tugas ditambahkan: " + t.text);
  }

  // Pengingat (boleh berulang)
  for (const m of reply.matchAll(/\[\[REMIND:\s*([^|\]]+?)\s*\|\s*([^|\]]+?)\s*(?:\|\s*(harian|mingguan|bulanan)\s*)?\]\]/gi)) {
    const ts = Date.parse(m[1]);
    const label = m[2].trim();
    const repeat = m[3] ? m[3].toLowerCase() : null;
    if (isNaN(ts) || ts <= Date.now()) {
      notes.push('Gagal mengatur pengingat "' + label + '" (waktu tidak valid atau sudah lewat).');
      continue;
    }
    const item = { id: Math.random().toString(36).slice(2, 10), text: label };
    if (repeat) item.repeat = repeat;
    await redis("ZADD", key(u, "reminders"), ts, JSON.stringify(item));
    notes.push("⏰ Pengingat diset: " + label + (repeat ? " (" + REPEAT_LABEL[repeat] + ")" : "") + "\n" + fmtWib(ts));
  }

  // Fakta tentang pengguna
  let savedFacts = false;
  for (const m of reply.matchAll(/\[\[INGAT:\s*([^\]]+?)\s*\]\]/g)) {
    await redis("RPUSH", key(u, "facts"), m[1].trim().slice(0, 300));
    savedFacts = true;
  }
  if (savedFacts) await redis("LTRIM", key(u, "facts"), -40, -1);

  // Pengeluaran
  for (const m of reply.matchAll(/\[\[BELI:\s*([^|\]]+?)\s*\|\s*([^|\]]+?)\s*\|\s*([^\]]*?)\s*\]\]/g)) {
    const amt = Number(String(m[1]).replace(/[^\d]/g, ""));
    const e = await addExpense(u, amt, m[2].trim(), m[3].trim());
    if (e) notes.push("💰 Dicatat: " + rupiah(e.amt) + " (" + e.cat + ")" + (e.note ? " - " + e.note : ""));
  }

  // Saldo
  for (const m of reply.matchAll(/\[\[SALDO:\s*([^\]]+?)\s*\]\]/g)) {
    const sd = await setSaldo(u, Number(String(m[1]).replace(/[^\d]/g, "")));
    if (sd) notes.push("💵 Saldo dicatat: " + rupiah(sd.amt));
  }

  // Catatan
  for (const m of reply.matchAll(/\[\[CATAT:\s*([^\]]+?)\s*\]\]/g)) {
    const n = await addNote(u, m[1]);
    if (n) notes.push("🗒️ Dicatat: " + n.text);
  }

  const clean = reply.replace(/\[\[(TASK|REMIND|INGAT|BELI|CATAT|SALDO):[\s\S]*?\]\]/g, "").trim();
  return { clean, notes };
}

// ---------- Handler utama ----------
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(200).send("ok");

  const msg = req.body && req.body.message;
  if (!msg) return res.status(200).end();

  // Pengguna ditentukan dari ?u=<id> (webhook per pengguna). Tanpa ?u = bot lama milik pemilik data lama.
  const u = String(req.query.u || "").match(/^[a-f0-9]{16}$/) ? req.query.u : await getOwnerId();
  const bot = u ? await getBot(u) : null;
  if (!bot) return res.status(200).end();

  // Pastikan request benar-benar dari Telegram (secret per bot)
  const sentSecret = req.headers["x-telegram-bot-api-secret-token"] || "";
  if (!bot.secret || !safeEq(sentSecret, bot.secret)) return res.status(401).end();

  const chatId = String(msg.chat.id);
  const say = (t, extra) => sendTelegram(u, chatId, t, extra);

  try {
    // Kunci chat: pesan pertama harus /start <kode> dari tautan di Pengaturan web
    if (!bot.chatId) {
      const m = !bot.legacy && msg.text && msg.text.trim().match(/^\/start(?:@\w+)?\s+(\w+)$/);
      if (m && bot.linkCode && safeEq(m[1], bot.linkCode)) {
        await saveBot(u, { ...bot, chatId, linkCode: null });
        await say("✅ Terhubung! Bot ini sekarang terkunci ke chat ini.\n\n" + START_TEXT);
      } else {
        await say("Bot ini belum terhubung. Buka Pengaturan di web, lalu klik tautan Hubungkan Telegram.");
      }
      return res.status(200).end();
    }
    if (chatId !== String(bot.chatId)) return res.status(200).end();

    // Tombol permanen mengirim teks biasa; ubah jadi perintah
    const map = {
      [BTN.tasks]: "/tugas",
      [BTN.remind]: "/pengingat",
      "💰 Rekap": "/rekap", // label lama, kalau keyboard di HP belum diperbarui
      [BTN.reset]: "/reset",
      [BTN.curhat]: "/curhat",
      [BTN.asisten]: "/asisten",
      [BTN.weather]: "/cuaca",
      [BTN.news]: "/berita",
      [BTN.recap]: "/rekap",
      [BTN.notes]: "/catatan",
    };

    let text = (msg.text || msg.caption || "").trim();
    const isText = !!msg.text;
    if (isText && map[text]) text = map[text];
    if (isText && text === BTN.plan) text = PLAN_PROMPT;

    // Setelah /rekap: balasan angka = pilih nomor pengeluaran yang dihapus (tidak diteruskan ke Gemini).
    // Pesan lain apa pun membatalkan mode ini.
    if (isText) {
      const isNum = /^[1-9]\d{0,2}$/.test(text);
      if (isNum && (await redis("GET", key(u, "pending"))) === "hapusbeli") {
        if (await hapusBeli(u, parseInt(text, 10), say)) await redis("DEL", key(u, "pending"));
        return res.status(200).end();
      }
      if (!isNum && text !== "/rekap" && text !== "/batal") await redis("DEL", key(u, "pending"));
    }

    let image = null;
    let voice = false;

    if (msg.photo && msg.photo.length) {
      const f = await downloadTelegramFile(u, msg.photo[msg.photo.length - 1].file_id);
      image = { mime: "image/jpeg", data: f.base64 };
    } else if (msg.voice) {
      const f = await downloadTelegramFile(u, msg.voice.file_id);
      const t = await gemini(u, "Kamu hanya menulis transkrip.", [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "audio/ogg", data: f.base64 } },
            { text: "Tulis transkrip pesan suara ini apa adanya, dalam bahasa yang diucapkan. Balas hanya dengan transkripnya." },
          ],
        },
      ]);
      text = t.trim();
      voice = true;
      if (!text) {
        await say("Maaf, suaranya kurang jelas. Coba kirim ulang?");
        return res.status(200).end();
      }
    } else if (!isText) {
      return res.status(200).end(); // stiker dan lainnya diabaikan
    }

    // Perintah
    if (isText && text.startsWith("/")) {
      const [rawCmd, ...rest] = text.split(/\s+/);
      await handleCommand(u, rawCmd.split("@")[0].toLowerCase(), rest.join(" ").trim(), say);
      return res.status(200).end();
    }

    // "catat: ..." disimpan langsung tanpa Gemini
    const cm = !image && text.match(/^catat(?:\s*:\s*|\s+)([\s\S]+)$/i);
    if (cm) {
      const n = await addNote(u, cm[1]);
      await say("🗒️ Dicatat: " + (n ? n.text : cm[1].trim()));
      return res.status(200).end();
    }

    // ---- Obrolan -> Gemini ----
    const [mode, rawHist, ctx] = await Promise.all([redis("GET", key(u, "mode")), redis("GET", key(u, "hist")), loadContext(u)]);

    let hist = [];
    try { hist = rawHist ? JSON.parse(rawHist) : []; } catch {}
    hist.push({ role: "user", parts: [{ text: image ? `[Foto] ${text}`.trim() : text }], ts: Date.now() });

    const contents = trimHist(hist);
    if (image) {
      contents[contents.length - 1] = {
        role: "user",
        parts: [
          { inlineData: { mimeType: image.mime, data: image.data } },
          { text: text || "Ini fotoku. Tolong lihat dan tanggapi." },
        ],
      };
    }

    const raw = await gemini(u, buildSystem(mode, ctx), contents);
    const { clean, notes } = await processTags(u, raw);
    const reply = clean || (notes.length ? "" : "(tidak ada jawaban)");

    hist.push({ role: "model", parts: [{ text: reply || "(dicatat)" }], ts: Date.now() });
    await redis("SET", key(u, "hist"), JSON.stringify(hist.slice(-30)));

    const echo = voice && mode !== "curhat" ? `🎙️ "${text}"\n\n` : "";
    await say(echo + [reply, ...notes].filter(Boolean).join("\n\n"));
  } catch (e) {
    try { await say("Maaf, ada error: " + e.message); } catch {}
  }

  return res.status(200).end();
};
