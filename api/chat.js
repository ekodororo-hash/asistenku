// Vercel Serverless Function: /api/chat
// Chat dari web, datanya dibaca/ditulis ke Redis yang sama dipakai bot Telegram
// supaya tugas, catatan, uang, mode, dan riwayat obrolan tersinkron di kedua sisi.

const {
  trimHist, geminiRaw, geminiSearch, sourceLine, REMIND_INTENT, DELETE_INTENT, deleteReminderNumber, fmtWib, rupiah,
  getMode, takeCurhatExpiredNotice, getHist, saveHist, getProfile, gemini, loadCurhatContext, buildCurhatSystem, stripTags,
  getTasks, addTask, getNotes, addNote, getExpenses, addExpense,
  getReminders, addReminder, parseRepeat, repeatLabel, getBot, sendTelegram, cfgOn, quotaStatus, setSaldo, addOutsideMoney, moneyContext, parseWib, addIncome, getIncomes, moneySummary,
  mentionsAmount, partnerContext, incomingTransfers, sendTransfer, handlePartnerIncome, answerDupMasuk,
} = require("./_lib");

const { requireUser } = require("./_auth");

const PERSONA = {
  asisten: `Kamu asisten pribadi sekaligus teman. Jawab dalam bahasa Indonesia yang santai, ringkas, dan membantu.
Bantu merencanakan hari, menyusun prioritas, menulis pesan/email, mengatur uang, dan menjawab pertanyaan umum.
Kalau pengguna terlihat sedang curhat atau emosional, berubah jadi pendengar yang hangat (dengarkan dulu, jangan buru-buru memberi solusi).`,

  curhat: `Kamu teman dekat yang hangat dan jadi tempat curhat, berbahasa Indonesia santai (aku/kamu).
- Dengarkan dulu. Jangan buru-buru memberi solusi atau daftar saran.
- Akui dan validasi perasaannya, lalu ajukan SATU pertanyaan lembut agar dia mau bercerita lebih jauh.
- Jangan menghakimi, jangan menceramahi. Kalimat pendek, hangat, boleh sesekali ringan.
- Beri saran hanya kalau diminta atau terasa dia memang butuh.
- Kamu tidak berpura-pura jadi manusia: kalau ditanya, akui kamu AI, tapi tetap hadir dan peduli.
- Dukung hubungannya dengan teman dan keluarga; jangan membuat dia bergantung hanya padamu.`,
};

function buildSystem(mode, { profile, taskList, noteList, moneyText, remindText, botLinked, partnerText }) {
  return `${mode === "curhat" ? PERSONA.curhat : PERSONA.asisten}
Nama kamu: ${profile.assistantName || "Asisten"}.
Pengguna bernama: ${profile.name || "(belum diisi)"}.
Catatan tentang pengguna: ${profile.notes || "(belum ada)"}.
Waktu sekarang pengguna: ${fmtWib(Date.now())}.

Daftar tugas pengguna:
${taskList}

Catatan pengguna (terbaru):
${noteList}

Pengeluaran pengguna:
${moneyText}

Pengingat mendatang:
${remindText}
Bot Telegram pengguna: ${botLinked ? "sudah terhubung (pengingat dikirim ke sana)" : "BELUM terhubung. Pengingat tetap tersimpan tapi baru terkirim setelah bot dihubungkan di Pengaturan; ingatkan pengguna soal ini saat membuat pengingat."}

${partnerText ? partnerText + "\n" : ""}
Aturan:
- Tulis teks biasa, tanpa markdown (tanpa * atau #). Emoji boleh secukupnya.
- Jangan memberi diagnosis medis.
- Jika ada tanda pengguna ingin menyakiti diri, ingin mengakhiri hidup, atau dalam bahaya: tanggapi dengan tenang dan sungguh-sungguh, tanyakan langsung apakah dia aman sekarang, jangan menghakimi, dorong dia menghubungi orang terdekat yang dipercaya dan layanan darurat/kesehatan jiwa setempat (Indonesia: 112 untuk darurat; 119 ekstensi 8 untuk layanan kesehatan jiwa Kemenkes), dan tetap temani dia bicara. Jangan memberi informasi cara menyakiti diri.

Tag khusus (taruh di baris terakhir balasan; pengguna tidak melihatnya):
- Pengingat: [[REMIND: 2026-10-12T08:00:00+07:00 | isi pengingat singkat]]
  Waktu format ISO 8601 dengan +07:00, dihitung dari waktu sekarang (ubah "besok", "lusa", "2 jam lagi" jadi waktu pasti). Jika pengguna menyebut hari/tanggal tanpa jam (mis. bayar wifi tanggal 10), pakai jam 08:00. Kalau cuma tanggal tanpa bulan, pakai tanggal itu yang terdekat dan belum lewat. Tagihan/cicilan/langganan atau kata tiap bulan dibuat bulanan. Kalau waktunya benar-benar tidak jelas (tanpa jam DAN tanpa hari), tanyakan dulu dan jangan buat tag. Jangan pernah bilang akan mengingatkan kalau kamu tidak membuat tag REMIND.
  Pengingat berulang: tambahkan bagian ketiga harian / mingguan / bulanan, atau interval seperti "tiap 5 menit" / "tiap 2 jam" (minimal 1 menit). Contoh: [[REMIND: 2026-10-13T09:00:00+07:00 | rapat tim | mingguan]]. Waktu = kemunculan pertama.
  Kalau pengguna minta berulang SAMPAI jam tertentu (mis. "tiap 5 menit sampai jam 10"), tambahkan bagian keempat berisi waktu berhenti (ISO, +07:00; kalau jam itu sudah lewat hari ini berarti besok). Waktu pertama = sekarang + interval. Contoh: [[REMIND: 2026-10-12T22:10:00+07:00 | waktunya minum | tiap 5 menit | 2026-10-12T22:30:00+07:00]]. Jangan pernah memakai harian untuk permintaan interval menit/jam, dan jangan mengubah isi pengingat dengan menambah jam atau menit.
- Tugas/checklist (pekerjaan yang perlu dikerjakan): [[TASK: isi tugas singkat]]
  Kalau pengguna menyebut jam/hari untuk tugas itu (mis. "nyuci piring besok jam 7"), tambahkan waktu: [[TASK: nyuci piring | 2026-10-13T07:00:00+07:00]]. Tugas berjam otomatis jadi pengingat yang bunyi tepat waktu dan dibatalkan kalau tugasnya dicentang selesai. Jangan buat TASK dan REMIND sekaligus untuk hal yang sama.
  Pakai REMIND hanya untuk pengingat murni yang bukan tugas (minum obat, rapat, tagihan) atau yang berulang.
- Catatan jika pengguna minta mencatat sesuatu: [[CATAT: isi catatan]]
- Pengingat BISA dihapus lewat tag [[HAPUS_PENGINGAT: N]] (N = nomor di daftar Pengingat mendatang). Buat tag ini hanya kalau pengguna jelas minta menghapus/membatalkan dan jelas pengingat yang mana; kalau belum jelas, tanyakan dulu. Jangan pernah bilang sudah dihapus tanpa tag ini: sistem menulis baris 🗑️ kalau berhasil.
- Kamu TIDAK bisa menghapus tugas, catatan, pengeluaran, atau pemasukan. Kalau pengguna minta, jangan bilang sudah dihapus dan jangan buat tag; arahkan ke Panel (tombol x di samping item yang mau dihapus).
- Pengeluaran yang sudah terjadi (mis. "makan siang 25rb", "beli bensin 50 ribu"): [[BELI: 25000 | makan | makan siang]]
  Jumlah rupiah angka bulat tanpa titik ("25rb" = 25000, "1,5jt" = 1500000). Kategori satu kata: makan, transport, belanja, tagihan, hiburan, kesehatan, lainnya.
- Pemasukan / uang masuk yang sudah terjadi (mis. "gajian 3jt", "dapat bonus 500rb"): [[MASUK: 3000000 | gaji | gajian]]
  Format angka sama seperti BELI. Kategori satu kata: gaji, bonus, usaha, hadiah, lainnya. Jangan pakai SALDO untuk uang masuk baru.
- Saldo/uang yang dimiliki pengguna sekarang (mis. \"uangku sekarang 500rb\"): [[SALDO: 500000]]. Kalau yang disebut uang TAMBAHAN di luar catatan (bukan total), pakai [[SALDO_LAIN: 65000]]. Angka bulat tanpa titik. Sisa uang = saldo + pemasukan - pengeluaran tercatat setelahnya (sudah dihitung di data uang di atas; jangan menebak kalau saldo belum diketahui).
- Kamu punya akses pencarian Google. Untuk hal yang terkini atau bisa berubah (jadwal pertandingan, skor, harga, berita, cuaca, hasil, tanggal rilis), cari dulu lalu jawab; jangan bilang kamu tidak bisa browsing. Jawab ringkas dan sebut waktu/tanggal datanya kalau penting. Hasil pencarian tidak perlu dicatat kecuali pengguna minta.
- Pertanyaan info (kurs, jadwal, harga, berita, dll) dijawab SEKARANG dalam balasan yang sama. Jangan bilang "sebentar aku cek" lalu membuat pengingat atau tugas; REMIND hanya kalau pengguna jelas minta diingatkan.
- Buat tag HANYA untuk permintaan di pesan pengguna yang TERBARU. Permintaan di pesan-pesan sebelumnya sudah diproses; jangan mengulang tagnya. Baris berawalan ⏰ ✅ 🗒️ 💰 💵 🗑️ di akhir balasanmu sebelumnya ditulis otomatis oleh sistem setelah tag berhasil diproses; itu tandanya permintaan tersebut SUDAH SELESAI. Jangan menulis baris seperti itu sendiri.
- Satu tag per hal, boleh lebih dari satu. Jangan membuat tag kalau pengguna tidak memintanya.
- Data ini juga dipakai lewat bot Telegram pengguna (tugas, catatan, uang, pengingat, riwayat obrolan sama persis).`;
}

async function processTags(u, reply, userText = "") {
  const remindOk = REMIND_INTENT.test(userText);
  const added = [];

  for (const m of reply.matchAll(/\[\[TASK:\s*([^\]|]+?)\s*(?:\|\s*([^\]|]+?)\s*)?\]\]/g)) {
    const when = m[2] ? parseWib(m[2]) : null;
    const t = await addTask(u, m[1], when);
    if (!t) continue;
    added.push("✅ Tugas ditambahkan: " + t.text + (t.due ? "\n⏰ Diingatkan " + fmtWib(t.due) : ""));
    if (m[2] && !t.due) added.push("(Jamnya tidak valid atau sudah lewat, jadi tugas dibuat tanpa pengingat.)");
  }
  for (const m of remindOk ? [...reply.matchAll(/\[\[REMIND:\s*([^|\]]+?)\s*\|\s*([^|\]]+?)\s*(?:\|\s*([^|\]]+?)\s*)?(?:\|\s*([^|\]]+?)\s*)?\]\]/gi)] : []) {
    const label = m[2].trim();
    const repeat = parseRepeat(m[3]);
    const until = repeat && m[4] ? parseWib(m[4]) : null;
    const r = await addReminder(u, label, parseWib(m[1]), repeat, null, until);
    added.push(r
      ? "⏰ Pengingat diset: " + label + (repeat ? " (" + repeatLabel(repeat) + (r.until ? " sampai " + fmtWib(r.until) : "") + ")" : "") + "\n" + fmtWib(r.ts)
      : 'Gagal mengatur pengingat "' + label + '" (waktu tidak valid atau sudah lewat).');
  }
  for (const m of reply.matchAll(/\[\[CATAT:\s*([^\]]+?)\s*\]\]/g)) {
    const n = await addNote(u, m[1]);
    if (n) added.push("🗒️ Dicatat: " + n.text);
  }
  const amountOk = mentionsAmount(userText);
  for (const m of amountOk ? [...reply.matchAll(/\[\[BELI:\s*([^|\]]+?)\s*\|\s*([^|\]]+?)\s*\|\s*([^\]]*?)\s*\]\]/g)] : []) {
    const amt = Number(String(m[1]).replace(/[^\d]/g, ""));
    const e = await addExpense(u, amt, m[2].trim(), m[3].trim());
    if (e) added.push("💰 Dicatat: " + rupiah(e.amt) + " (" + e.cat + ")" + (e.note ? " - " + e.note : ""));
  }

  for (const m of amountOk ? [...reply.matchAll(/\[\[MASUK:\s*([^|\]]+?)\s*\|\s*([^|\]]+?)\s*\|\s*([^\]]*?)\s*\]\]/g)] : []) {
    const amt = Number(String(m[1]).replace(/[^\d]/g, ""));
    const e = await addIncome(u, amt, m[2].trim(), m[3].trim());
    if (e) added.push("💵 Pemasukan dicatat: " + rupiah(e.amt) + " (" + e.cat + ")" + (e.note ? " - " + e.note : ""));
  }

  // Kirim uang ke pasangan (pasangan diminta konfirmasi) dan terima uang dari pasangan (dicocokkan supaya tidak dobel)
  for (const m of reply.matchAll(/\[\[KIRIM:\s*([^|\]]+?)\s*(?:\|\s*([^\]]*?)\s*)?\]\]/g)) {
    const amt = Number(String(m[1]).replace(/[^\d]/g, ""));
    const note = (m[2] || "").trim();
    const r = await sendTransfer(u, amt, note);
    if (r && r.error) added.push("⚠️ " + r.error);
    else if (r) added.push("💸 Dicatat: " + rupiah(r.x.amt) + " ke " + r.name + (r.notified ? ". Sudah kukabari " + r.name + " di Telegram." : ". " + r.name + " akan melihatnya di web (tab Uang) untuk konfirmasi."));
    else { // belum terhubung / nominal tidak valid: catat sebagai pengeluaran biasa
      const e = await addExpense(u, amt, "transfer", note || "kirim uang");
      if (e) added.push("💰 Dicatat: " + rupiah(e.amt) + " (" + e.cat + ")" + (e.note ? " - " + e.note : ""));
    }
  }
  for (const m of reply.matchAll(/\[\[PASANGAN_MASUK:\s*([^|\]]+?)\s*(?:\|\s*([^\]]*?)\s*)?\]\]/g)) {
    const amt = Number(String(m[1]).replace(/[^\d]/g, ""));
    const line = await handlePartnerIncome(u, amt, (m[2] || "").trim());
    if (line) added.push(line);
  }

  for (const m of reply.matchAll(/\[\[SALDO:\s*([^\]]+?)\s*\]\]/g)) {
    const sd = await setSaldo(u, Number(String(m[1]).replace(/[^\d]/g, "")));
    if (sd) added.push("💵 Saldo dicatat: " + rupiah(sd.amt));
  }
  for (const m of reply.matchAll(/\[\[SALDO_LAIN:\s*([^\]]+?)\s*\]\]/g)) {
    const r = await addOutsideMoney(u, Number(String(m[1]).replace(/[^\d]/g, "")));
    if (r) added.push("💵 Uang lain " + rupiah(r.extra) + " ditambahkan ke catatan (" + rupiah(r.base) + "). Sisa uang sekarang: " + rupiah(r.saldo.amt));
  }

  // Hapus pengingat (hanya kalau pesan pengguna memang meminta menghapus/membatalkan)
  if (DELETE_INTENT.test(userText)) {
    const nums = [...new Set([...reply.matchAll(/\[\[HAPUS_PENGINGAT:\s*(\d+)\s*\]\]/g)].map((m) => Number(m[1])))].sort((a, b) => b - a);
    for (const n of nums) { // dari nomor terbesar supaya nomor lain tidak bergeser
      const r = await deleteReminderNumber(u, n);
      added.push(r ? "🗑️ Pengingat dihapus: " + r.text : "Gagal menghapus: pengingat nomor " + n + " tidak ditemukan.");
    }
  }

  const clean = reply.replace(/\[\[(TASK|REMIND|CATAT|BELI|MASUK|KIRIM|PASANGAN_MASUK|SALDO_LAIN|SALDO|HAPUS_PENGINGAT):[\s\S]*?\]\]/g, "").trim();
  return { clean, added };
}

function moneyText(expenses) {
  if (!expenses.length) return "(belum ada)";
  const total = expenses.reduce((s, e) => s + e.amt, 0);
  const by = {};
  expenses.forEach((e) => { by[e.cat] = (by[e.cat] || 0) + e.amt; });
  const cats = Object.entries(by).sort((a, b) => b[1] - a[1]).map(([c, v]) => c + " " + rupiah(v)).join(", ");
  const last = expenses.slice(-5).map((e) => (e.note || e.cat) + " " + rupiah(e.amt)).join("; ");
  return `Bulan ini total ${rupiah(total)}. Per kategori: ${cats}. Terakhir: ${last}.`;
}

// ---- Streaming (SSE) ----
// Klien yang mengirim { stream: true } menerima potongan jawaban lewat event "data: {...}".
// Event: delta (potongan teks), final (teks akhir setelah tag diproses), done (data terbaru, sama seperti respons JSON), error.
// Header baru dikirim saat event pertama, jadi error sebelum itu (login, key, limit) tetap berupa JSON biasa.
function makeOut(res) {
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    if (res.flushHeaders) res.flushHeaders();
    res.write(":" + " ".repeat(2048) + "\n\n"); // komentar SSE sebagai pengisi: memaksa proxy/CDN mulai meneruskan aliran
  };
  return {
    started: () => started,
    emit(o) { start(); res.write("data: " + JSON.stringify(o) + "\n\n"); },
  };
}

// Menyaring potongan teks: tag khusus ([[...]]) ada di akhir balasan dan tidak boleh sempat terlihat.
// Teks mulai dari "[[" ditahan; teks final yang bersih dikirim lewat event "final".
function makeStreamer(emit) {
  let acc = "", sent = 0;
  return (piece) => {
    acc += piece;
    const i = acc.indexOf("[[");
    const safe = i >= 0 ? i : acc.length - (acc.endsWith("[") ? 1 : 0);
    if (safe > sent) { emit({ t: "delta", text: acc.slice(sent, safe) }); sent = safe; }
  };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Gunakan metode POST" });
  }
  const u = await requireUser(req, res);
  if (!u) return;

  const text = String((req.body || {}).text || "").trim().slice(0, 4000);
  if (!text) return res.status(400).json({ error: "Pesan kosong" });

  const wantStream = !!(req.body || {}).stream;
  const out = makeOut(res);
  const onText = wantStream ? makeStreamer(out.emit) : undefined;
  const finish = (payload) => {
    if (!wantStream) return res.status(200).json(payload);
    out.emit({ t: "done", ...payload });
    return res.end();
  };

  try {
    const mode = await getMode(u);

    // ---- Mode curhat: riwayat sendiri, tanpa tag, tanpa pencarian, tanpa salinan ke Telegram ----
    if (mode === "curhat") {
      const [hist, ctx] = await Promise.all([getHist(u, "curhat"), loadCurhatContext(u)]);
      const userTurn = { role: "user", parts: [{ text }], ts: Date.now() };
      const raw = await gemini(u, buildCurhatSystem(ctx), trimHist([...hist, userTurn]), "web", onText);
      const reply = stripTags(raw) || "(tidak ada jawaban)";
      await saveHist(u, [...hist, userTurn, { role: "model", parts: [{ text: reply }], ts: Date.now() }], "curhat");
      return finish({ reply, added: [], mode: "curhat" });
    }

    const expiredNotice = await takeCurhatExpiredNotice(u); // curhat kedaluwarsa sendiri: kabari sekali
    if (wantStream && expiredNotice) out.emit({ t: "delta", text: expiredNotice + "\n\n" });
    const [hist, tasks, notes, expenses, profile, reminders, bot] = await Promise.all([
      getHist(u, "asisten"), getTasks(u), getNotes(u), getExpenses(u), getProfile(u), getReminders(u), getBot(u).catch(() => null),
    ]);
    const remindText = reminders.length
      ? reminders.slice(0, 10).map((r, i) => `${i + 1}. ${r.text}${r.repeat ? " [" + repeatLabel(r.repeat) + (r.until ? " sampai " + fmtWib(r.until) : "") + "]" : ""} (${fmtWib(r.ts)})`).join("\n")
      : "(belum ada)";

    const taskList = tasks.length
      ? tasks.slice(-40).map((t, i) => `${i + 1}. ${t.done ? "[selesai]" : "[belum]"} ${t.text}${t.due ? " (jam " + fmtWib(t.due) + ")" : ""}`).join("\n")
      : "(kosong)";
    const noteList = notes.length
      ? notes.slice(-20).map((n) => "- " + n.text).join("\n")
      : "(kosong)";

    // Jawaban "ya / tidak" untuk pertanyaan "mau tambah lagi sebagai pemasukan terpisah?"
    const dupReply = await answerDupMasuk(u, text);
    if (dupReply) {
      const t = Date.now();
      await saveHist(u, [...hist, { role: "user", parts: [{ text }], ts: t }, { role: "model", parts: [{ text: dupReply }], ts: t }], "asisten");
      const [fTasks, fNotes, fExpenses, fReminders, fQuota, fIncomes, fMoney, fXfer] = await Promise.all([getTasks(u), getNotes(u), getExpenses(u), getReminders(u), quotaStatus(u), getIncomes(u), moneySummary(u), incomingTransfers(u)]);
      return finish({
        reply: [expiredNotice, dupReply].filter(Boolean).join("\n\n"), added: [], quota: fQuota,
        tasks: fTasks, reminders: fReminders, notes: fNotes.slice(-100).reverse(), expenses: fExpenses.slice(-100).reverse(),
        incomes: fIncomes.slice(-100).reverse(), money: fMoney, xferIn: fXfer,
      });
    }

    const system = buildSystem(mode, { profile, taskList, noteList, moneyText: await moneyContext(u), remindText, botLinked: !!(bot && bot.chatId), partnerText: await partnerContext(u).catch(() => "") });

    const userTurn = { role: "user", parts: [{ text }], ts: Date.now() };
    const contents = trimHist([...hist, userTurn]);

    const found = await geminiSearch(u, system, contents, "web", onText);
    const raw = found.text;
    const { clean, added } = await processTags(u, raw, text);
    const reply = clean || (added.length ? "" : "(tidak ada jawaban)");
    const shown = [expiredNotice, reply, sourceLine(found.sources, found.searchError)].filter(Boolean).join("\n\n"); // sumber hanya ditampilkan, tidak masuk riwayat

    const newHist = [...hist, userTurn, { role: "model", parts: [{ text: [reply, ...added].filter(Boolean).join("\n\n") || "(dicatat)" }], ts: Date.now() }];
    await saveHist(u, newHist, "asisten");
    if (wantStream) out.emit({ t: "final", text: [shown, ...added].filter(Boolean).join("\n\n") || "(tidak ada jawaban)" }); // teks akhir tanpa tag, sebelum langkah susulan

    // Salin ke Telegram supaya obrolan di web juga terlihat di chat Telegram (matikan: /salin off)
    if (bot && bot.chatId && (await cfgOn(u, "mirror").catch(() => true))) {
      const body = "💻 Dari web: " + text + "\n\n" + [shown, ...added].filter(Boolean).join("\n\n");
      try { await sendTelegram(u, String(bot.chatId), body); } catch {}
    }

    const [freshTasks, freshNotes, freshExpenses, freshReminders, quota, freshIncomes, money] = await Promise.all([getTasks(u), getNotes(u), getExpenses(u), getReminders(u), quotaStatus(u), getIncomes(u), moneySummary(u)]);
    const xferIn = await incomingTransfers(u).catch(() => []);
    return finish({
      reply: shown, added, quota, xferIn,
      tasks: freshTasks,
      reminders: freshReminders,
      notes: freshNotes.slice(-100).reverse(),
      expenses: freshExpenses.slice(-100).reverse(),
      incomes: freshIncomes.slice(-100).reverse(),
      money,
    });
  } catch (e) {
    const status = e.status || 500, msg = e.status ? e.message : "Server error: " + e.message;
    if (wantStream && out.started()) { out.emit({ t: "error", error: msg, status }); return res.end(); } // header sudah terkirim
    return res.status(status).json({ error: msg });
  }
};
