// Webhook bot Telegram: /api/telegram
const {
  HOURS, BTN, redis, sendTelegram, downloadTelegramFile, gemini, trimHist,
  fmtWib, wib, rupiah, cfgOn, getLocation, setLocation, getWeather, getNews,
  recapText, loadContext, buildSystem,
  getTasks, addTask, toggleTask, deleteTask,
  addNote, addExpense,
} = require("./_lib");

const PLAN_PROMPT =
  "Bantu aku susun rencana hari ini berdasarkan pengingat dan hal yang kamu tahu tentang aku. Tanya aku kalau butuh info tambahan.";

const REPEAT_LABEL = { harian: "tiap hari", mingguan: "tiap minggu", bulanan: "tiap bulan" };
const TOGGLES = { "/pagi": "pagi", "/checkin": "checkin", "/rekapauto": "rekapauto" };

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
  "/rekap  /hapusbeli\n" +
  "/catatan  /cari kata  /hapuscatatan N\n" +
  "/cuaca  /lokasi kota  /berita topik\n" +
  "/memori  /lupakan  /atur\n\n" +
  `Otomatis: ringkasan pagi, check-in malam, dan rekap pengeluaran mingguan. Atur di /atur.\n` +
  "Aku mengingat hal-hal penting tentangmu supaya ngobrolnya nyambung. Lihat dengan /memori, hapus dengan /lupakan.\n\n" +
  "Tugas, catatan, uang, dan obrolan di sini sama persis dengan yang ada di web.";

// ---------- Perintah ----------
async function handleCommand(cmd, arg, say) {
  switch (cmd) {
    case "/start":
    case "/help":
      await say(START_TEXT);
      return;

    case "/curhat":
      await redis("SET", "mode", "curhat");
      await say("Oke, aku dengerin. Cerita aja, pelan-pelan juga gapapa.");
      return;

    case "/asisten":
      await redis("SET", "mode", "asisten");
      await say("Siap, balik ke mode asisten. Ada yang perlu dibantu?");
      return;

    case "/reset":
      await redis("DEL", "hist");
      await say("Riwayat obrolan dihapus. Hal-hal yang kuingat tentangmu tetap ada (hapus dengan /lupakan).");
      return;

    case "/memori": {
      const facts = await redis("LRANGE", "facts", 0, -1);
      await say(
        facts && facts.length
          ? "Yang kuingat tentangmu:\n\n" + facts.map((f, i) => `${i + 1}. ${f}`).join("\n")
          : "Belum ada yang kuingat."
      );
      return;
    }

    case "/lupakan":
      await redis("DEL", "facts");
      await say("Semua yang kuingat tentangmu sudah dihapus.");
      return;

    case "/pengingat": {
      const rows = await redis("ZRANGE", "reminders", 0, -1, "WITHSCORES");
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
      const rows = await redis("ZRANGE", "reminders", 0, -1);
      if (!n || n < 1 || n > rows.length) {
        await say("Pakai: /hapus <nomor>. Lihat nomornya di /pengingat.");
        return;
      }
      await redis("ZREM", "reminders", rows[n - 1]);
      let it = {};
      try { it = JSON.parse(rows[n - 1]); } catch {}
      await say(`Pengingat dihapus: ${it.text || "?"}`);
      return;
    }

    case "/tugas": {
      const tasks = await getTasks();
      if (!tasks.length) { await say("Belum ada tugas. Tulis: tambah tugas <isi>, atau pakai web."); return; }
      const lines = tasks.map((t, i) => `${i + 1}. ${t.done ? "[selesai]" : "[belum]"} ${t.text}`);
      await say("Tugas (sama dengan di web):\n\n" + lines.join("\n") + "\n\nTandai selesai: /tugasdone N\nHapus: /hapustugas N");
      return;
    }

    case "/tugasdone": {
      const n = parseInt(arg, 10);
      const tasks = await getTasks();
      if (!n || n < 1 || n > tasks.length) { await say("Pakai: /tugasdone <nomor>. Lihat nomornya di /tugas."); return; }
      const t = await toggleTask(tasks[n - 1].id);
      await say(t ? `Tugas "${t.text}" ditandai ${t.done ? "selesai" : "belum selesai"}.` : "Gagal mengubah tugas.");
      return;
    }

    case "/hapustugas": {
      const n = parseInt(arg, 10);
      const tasks = await getTasks();
      if (!n || n < 1 || n > tasks.length) { await say("Pakai: /hapustugas <nomor>. Lihat nomornya di /tugas."); return; }
      const ok = await deleteTask(tasks[n - 1].id);
      await say(ok ? `Tugas dihapus: ${tasks[n - 1].text}` : "Gagal menghapus tugas.");
      return;
    }

    case "/cuaca":
      try { await say("⛅ " + (await getWeather())); }
      catch (e) { await say("Gagal mengambil cuaca: " + e.message); }
      return;

    case "/lokasi": {
      if (!arg) {
        const loc = await getLocation();
        await say(`Lokasi cuaca saat ini: ${loc.name}.\nGanti dengan: /lokasi <nama kota>`);
        return;
      }
      const loc = await setLocation(arg);
      await say(loc ? `Lokasi cuaca diganti ke ${loc.name}.` : "Kota tidak ditemukan. Coba tulis nama kota yang lain.");
      return;
    }

    case "/berita":
      try { await say(await getNews(arg), { link_preview_options: { is_disabled: true } }); }
      catch (e) { await say("Gagal mengambil berita: " + e.message); }
      return;

    case "/rekap":
      await say((await recapText()).text);
      return;

    case "/hapusbeli": {
      const raw = await redis("RPOP", "exp:" + wib().monthKey);
      if (!raw) { await say("Tidak ada pengeluaran bulan ini yang bisa dihapus."); return; }
      let e = {};
      try { e = JSON.parse(raw); } catch {}
      await say(`Pengeluaran terakhir dihapus: ${e.note || e.cat || "?"} (${rupiah(e.amt || 0)})`);
      return;
    }

    case "/catatan": {
      const all = await redis("LRANGE", "notes", 0, -1);
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
      const all = await redis("LRANGE", "notes", 0, -1);
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
      const out = await gemini(
        "Kamu mencari catatan pengguna. Tulis teks biasa tanpa markdown.",
        [{ role: "user", parts: [{ text: `Catatan:\n${listing}\n\nCari catatan yang relevan dengan: "${arg}". Tulis nomor dan isinya. Jika tidak ada yang relevan, katakan tidak ada.` }] }]
      );
      await say(out.trim() || "Tidak ada catatan yang cocok.");
      return;
    }

    case "/hapuscatatan": {
      const n = parseInt(arg, 10);
      const all = await redis("LRANGE", "notes", 0, -1);
      if (!n || n < 1 || !all || n > all.length) { await say("Pakai: /hapuscatatan <nomor>. Lihat nomornya di /catatan."); return; }
      const rest = all.filter((_, i) => i !== n - 1);
      await redis("DEL", "notes");
      if (rest.length) await redis("RPUSH", "notes", ...rest);
      await say("Catatan dihapus.");
      return;
    }

    case "/pagi":
    case "/checkin":
    case "/rekapauto": {
      const key = TOGGLES[cmd];
      const a = arg.toLowerCase();
      if (a !== "on" && a !== "off") {
        await say(`Pakai: ${cmd} on  atau  ${cmd} off. Status lengkap: /atur`);
        return;
      }
      await redis("HSET", "cfg", key, a);
      await say(`${cmd.slice(1)} sekarang ${a === "on" ? "aktif" : "dimatikan"}.`);
      return;
    }

    case "/atur": {
      const [p, c, r, loc] = await Promise.all([cfgOn("pagi"), cfgOn("checkin"), cfgOn("rekapauto"), getLocation()]);
      const s = (b) => (b ? "aktif" : "mati");
      const jam = (h) => String(h).padStart(2, "0") + ".00";
      await say(
        "Pengaturan otomatis:\n" +
          `- Ringkasan pagi (${jam(HOURS.morning)} WIB): ${s(p)}  -> /pagi on | off\n` +
          `- Check-in malam (${jam(HOURS.checkin)} WIB): ${s(c)}  -> /checkin on | off\n` +
          `- Rekap pengeluaran (Minggu ${jam(HOURS.recap)}): ${s(r)}  -> /rekapauto on | off\n` +
          `- Lokasi cuaca: ${loc.name}  -> /lokasi <kota>`
      );
      return;
    }

    default:
      await say("Perintah tidak dikenal. Ketik /start untuk melihat daftar.");
  }
}

// ---------- Tag dari Gemini ----------
async function processTags(reply) {
  const notes = [];

  // Tugas/checklist
  for (const m of reply.matchAll(/\[\[TASK:\s*([^\]]+?)\s*\]\]/g)) {
    const t = await addTask(m[1]);
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
    await redis("ZADD", "reminders", ts, JSON.stringify(item));
    notes.push("⏰ Pengingat diset: " + label + (repeat ? " (" + REPEAT_LABEL[repeat] + ")" : "") + "\n" + fmtWib(ts));
  }

  // Fakta tentang pengguna
  let savedFacts = false;
  for (const m of reply.matchAll(/\[\[INGAT:\s*([^\]]+?)\s*\]\]/g)) {
    await redis("RPUSH", "facts", m[1].trim().slice(0, 300));
    savedFacts = true;
  }
  if (savedFacts) await redis("LTRIM", "facts", -40, -1);

  // Pengeluaran
  for (const m of reply.matchAll(/\[\[BELI:\s*([^|\]]+?)\s*\|\s*([^|\]]+?)\s*\|\s*([^\]]*?)\s*\]\]/g)) {
    const amt = Number(String(m[1]).replace(/[^\d]/g, ""));
    const e = await addExpense(amt, m[2].trim(), m[3].trim());
    if (e) notes.push("💰 Dicatat: " + rupiah(e.amt) + " (" + e.cat + ")" + (e.note ? " - " + e.note : ""));
  }

  // Catatan
  for (const m of reply.matchAll(/\[\[CATAT:\s*([^\]]+?)\s*\]\]/g)) {
    const n = await addNote(m[1]);
    if (n) notes.push("🗒️ Dicatat: " + n.text);
  }

  const clean = reply.replace(/\[\[(TASK|REMIND|INGAT|BELI|CATAT):[\s\S]*?\]\]/g, "").trim();
  return { clean, notes };
}

// ---------- Handler utama ----------
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(200).send("ok");

  // Pastikan request benar-benar dari Telegram
  if (req.headers["x-telegram-bot-api-secret-token"] !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.status(401).end();
  }

  const msg = req.body && req.body.message;
  if (!msg) return res.status(200).end();

  const chatId = String(msg.chat.id);
  const owner = process.env.TELEGRAM_CHAT_ID;
  const say = (t, extra) => sendTelegram(chatId, t, extra);

  try {
    // /id boleh dipakai siapa saja, untuk mengetahui chat ID saat setup
    if (msg.text && msg.text.trim() === "/id") {
      await say(`Chat ID kamu: ${chatId}\nIsi angka ini di env TELEGRAM_CHAT_ID di Vercel, lalu redeploy.`);
      return res.status(200).end();
    }

    // Hanya pemilik yang dilayani
    if (!owner) {
      await say("Bot belum dikunci ke pemilik. Kirim /id untuk melihat chat ID-mu.");
      return res.status(200).end();
    }
    if (chatId !== String(owner)) return res.status(200).end();

    // Tombol permanen mengirim teks biasa; ubah jadi perintah
    const map = {
      [BTN.remind]: "/pengingat",
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

    let image = null;
    let voice = false;

    if (msg.photo && msg.photo.length) {
      const f = await downloadTelegramFile(msg.photo[msg.photo.length - 1].file_id);
      image = { mime: "image/jpeg", data: f.base64 };
    } else if (msg.voice) {
      const f = await downloadTelegramFile(msg.voice.file_id);
      const t = await gemini("Kamu hanya menulis transkrip.", [
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
      await handleCommand(rawCmd.split("@")[0].toLowerCase(), rest.join(" ").trim(), say);
      return res.status(200).end();
    }

    // "catat: ..." disimpan langsung tanpa Gemini
    const cm = !image && text.match(/^catat(?:\s*:\s*|\s+)([\s\S]+)$/i);
    if (cm) {
      const n = await addNote(cm[1]);
      await say("🗒️ Dicatat: " + (n ? n.text : cm[1].trim()));
      return res.status(200).end();
    }

    // ---- Obrolan -> Gemini ----
    const [mode, rawHist, ctx] = await Promise.all([redis("GET", "mode"), redis("GET", "hist"), loadContext()]);

    let hist = [];
    try { hist = rawHist ? JSON.parse(rawHist) : []; } catch {}
    hist.push({ role: "user", parts: [{ text: image ? `[Foto] ${text}`.trim() : text }] });

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

    const raw = await gemini(buildSystem(mode, ctx), contents);
    const { clean, notes } = await processTags(raw);
    const reply = clean || (notes.length ? "" : "(tidak ada jawaban)");

    hist.push({ role: "model", parts: [{ text: reply || "(dicatat)" }] });
    await redis("SET", "hist", JSON.stringify(hist.slice(-30)));

    const echo = voice && mode !== "curhat" ? `🎙️ "${text}"\n\n` : "";
    await say(echo + [reply, ...notes].filter(Boolean).join("\n\n"));
  } catch (e) {
    try { await say("Maaf, ada error: " + e.message); } catch {}
  }

  return res.status(200).end();
};
