// Vercel Serverless Function: /api/chat
// Chat dari web, datanya dibaca/ditulis ke Redis yang sama dipakai bot Telegram
// supaya tugas, catatan, uang, mode, dan riwayat obrolan tersinkron di kedua sisi.

const {
  trimHist, geminiRaw, geminiSearch, sourceLine, fmtWib, rupiah,
  getMode, getHist, saveHist, getProfile,
  getTasks, addTask, getNotes, addNote, getExpenses, addExpense,
  getReminders, addReminder, getBot, sendTelegram, cfgOn, quotaStatus, setSaldo, moneyContext, parseWib,
} = require("./_lib");

const REPEAT_LABEL = { harian: "tiap hari", mingguan: "tiap minggu", bulanan: "tiap bulan" };
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

function buildSystem(mode, { profile, taskList, noteList, moneyText, remindText, botLinked }) {
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

Aturan:
- Tulis teks biasa, tanpa markdown (tanpa * atau #). Emoji boleh secukupnya.
- Jangan memberi diagnosis medis.
- Jika ada tanda pengguna ingin menyakiti diri, ingin mengakhiri hidup, atau dalam bahaya: tanggapi dengan tenang dan sungguh-sungguh, tanyakan langsung apakah dia aman sekarang, jangan menghakimi, dorong dia menghubungi orang terdekat yang dipercaya dan layanan darurat/kesehatan jiwa setempat (Indonesia: 112 untuk darurat; 119 ekstensi 8 untuk layanan kesehatan jiwa Kemenkes), dan tetap temani dia bicara. Jangan memberi informasi cara menyakiti diri.

Tag khusus (taruh di baris terakhir balasan; pengguna tidak melihatnya):
- Pengingat: [[REMIND: 2026-10-12T08:00:00+07:00 | isi pengingat singkat]]
  Waktu format ISO 8601 dengan +07:00, dihitung dari waktu sekarang (ubah "besok", "lusa", "2 jam lagi" jadi waktu pasti). Jika jam tidak disebut, tanyakan dulu dan jangan buat tag.
  Pengingat berulang: tambahkan bagian ketiga harian / mingguan / bulanan, contoh [[REMIND: 2026-10-13T09:00:00+07:00 | rapat tim | mingguan]]. Waktu = kemunculan pertama.
- Tugas/checklist (pekerjaan yang perlu dikerjakan): [[TASK: isi tugas singkat]]
  Kalau pengguna menyebut jam/hari untuk tugas itu (mis. "nyuci piring besok jam 7"), tambahkan waktu: [[TASK: nyuci piring | 2026-10-13T07:00:00+07:00]]. Tugas berjam otomatis jadi pengingat yang bunyi tepat waktu dan dibatalkan kalau tugasnya dicentang selesai. Jangan buat TASK dan REMIND sekaligus untuk hal yang sama.
  Pakai REMIND hanya untuk pengingat murni yang bukan tugas (minum obat, rapat, tagihan) atau yang berulang.
- Catatan jika pengguna minta mencatat sesuatu: [[CATAT: isi catatan]]
- Pengeluaran yang sudah terjadi (mis. "makan siang 25rb", "beli bensin 50 ribu"): [[BELI: 25000 | makan | makan siang]]
  Jumlah rupiah angka bulat tanpa titik ("25rb" = 25000, "1,5jt" = 1500000). Kategori satu kata: makan, transport, belanja, tagihan, hiburan, kesehatan, lainnya.
- Saldo/uang yang dimiliki pengguna sekarang (mis. \"uangku sekarang 500rb\"): [[SALDO: 500000]]. Angka bulat tanpa titik. Sisa uang = saldo dikurangi pengeluaran tercatat setelahnya (sudah dihitung di data uang di atas; jangan menebak kalau saldo belum diketahui).
- Kamu punya akses pencarian Google. Untuk hal yang terkini atau bisa berubah (jadwal pertandingan, skor, harga, berita, cuaca, hasil, tanggal rilis), cari dulu lalu jawab; jangan bilang kamu tidak bisa browsing. Jawab ringkas dan sebut waktu/tanggal datanya kalau penting. Hasil pencarian tidak perlu dicatat kecuali pengguna minta.
- Buat tag HANYA untuk permintaan di pesan pengguna yang TERBARU. Permintaan di pesan-pesan sebelumnya sudah diproses; jangan mengulang tagnya. Baris berawalan ⏰ ✅ 🗒️ 💰 💵 di akhir balasanmu sebelumnya ditulis otomatis oleh sistem setelah tag berhasil diproses; itu tandanya permintaan tersebut SUDAH SELESAI. Jangan menulis baris seperti itu sendiri.
- Satu tag per hal, boleh lebih dari satu. Jangan membuat tag kalau pengguna tidak memintanya.
- Data ini juga dipakai lewat bot Telegram pengguna (tugas, catatan, uang, pengingat, riwayat obrolan sama persis).`;
}

async function processTags(u, reply) {
  const added = [];

  for (const m of reply.matchAll(/\[\[TASK:\s*([^\]|]+?)\s*(?:\|\s*([^\]|]+?)\s*)?\]\]/g)) {
    const when = m[2] ? parseWib(m[2]) : null;
    const t = await addTask(u, m[1], when);
    if (!t) continue;
    added.push("✅ Tugas ditambahkan: " + t.text + (t.due ? "\n⏰ Diingatkan " + fmtWib(t.due) : ""));
    if (m[2] && !t.due) added.push("(Jamnya tidak valid atau sudah lewat, jadi tugas dibuat tanpa pengingat.)");
  }
  for (const m of reply.matchAll(/\[\[REMIND:\s*([^|\]]+?)\s*\|\s*([^|\]]+?)\s*(?:\|\s*(harian|mingguan|bulanan)\s*)?\]\]/gi)) {
    const label = m[2].trim();
    const repeat = m[3] ? m[3].toLowerCase() : null;
    const r = await addReminder(u, label, parseWib(m[1]), repeat);
    added.push(r
      ? "⏰ Pengingat diset: " + label + (repeat ? " (" + REPEAT_LABEL[repeat] + ")" : "") + "\n" + fmtWib(r.ts)
      : 'Gagal mengatur pengingat "' + label + '" (waktu tidak valid atau sudah lewat).');
  }
  for (const m of reply.matchAll(/\[\[CATAT:\s*([^\]]+?)\s*\]\]/g)) {
    const n = await addNote(u, m[1]);
    if (n) added.push("🗒️ Dicatat: " + n.text);
  }
  for (const m of reply.matchAll(/\[\[BELI:\s*([^|\]]+?)\s*\|\s*([^|\]]+?)\s*\|\s*([^\]]*?)\s*\]\]/g)) {
    const amt = Number(String(m[1]).replace(/[^\d]/g, ""));
    const e = await addExpense(u, amt, m[2].trim(), m[3].trim());
    if (e) added.push("💰 Dicatat: " + rupiah(e.amt) + " (" + e.cat + ")" + (e.note ? " - " + e.note : ""));
  }

  for (const m of reply.matchAll(/\[\[SALDO:\s*([^\]]+?)\s*\]\]/g)) {
    const sd = await setSaldo(u, Number(String(m[1]).replace(/[^\d]/g, "")));
    if (sd) added.push("💵 Saldo dicatat: " + rupiah(sd.amt));
  }

  const clean = reply.replace(/\[\[(TASK|REMIND|CATAT|BELI|SALDO):[\s\S]*?\]\]/g, "").trim();
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

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Gunakan metode POST" });
  }
  const u = await requireUser(req, res);
  if (!u) return;

  const text = String((req.body || {}).text || "").trim().slice(0, 4000);
  if (!text) return res.status(400).json({ error: "Pesan kosong" });

  try {
    const [mode, hist, tasks, notes, expenses, profile, reminders, bot] = await Promise.all([
      getMode(u), getHist(u), getTasks(u), getNotes(u), getExpenses(u), getProfile(u), getReminders(u), getBot(u).catch(() => null),
    ]);
    const remindText = reminders.length
      ? reminders.slice(0, 10).map((r) => `- ${r.text}${r.repeat ? " [" + REPEAT_LABEL[r.repeat] + "]" : ""} (${fmtWib(r.ts)})`).join("\n")
      : "(belum ada)";

    const taskList = tasks.length
      ? tasks.slice(-40).map((t, i) => `${i + 1}. ${t.done ? "[selesai]" : "[belum]"} ${t.text}${t.due ? " (jam " + fmtWib(t.due) + ")" : ""}`).join("\n")
      : "(kosong)";
    const noteList = notes.length
      ? notes.slice(-20).map((n) => "- " + n.text).join("\n")
      : "(kosong)";

    const system = buildSystem(mode, { profile, taskList, noteList, moneyText: await moneyContext(u), remindText, botLinked: !!(bot && bot.chatId) });

    const userTurn = { role: "user", parts: [{ text }], ts: Date.now() };
    const contents = trimHist([...hist, userTurn]);

    const found = await geminiSearch(u, system, contents, "web");
    const raw = found.text;
    const { clean, added } = await processTags(u, raw);
    const reply = clean || (added.length ? "" : "(tidak ada jawaban)");
    const shown = [reply, sourceLine(found.sources)].filter(Boolean).join("\n\n"); // sumber hanya ditampilkan, tidak masuk riwayat

    const newHist = [...hist, userTurn, { role: "model", parts: [{ text: [reply, ...added].filter(Boolean).join("\n\n") || "(dicatat)" }], ts: Date.now() }];
    await saveHist(u, newHist);

    // Salin ke Telegram supaya obrolan di web juga terlihat di chat Telegram (matikan: /salin off)
    if (bot && bot.chatId && (await cfgOn(u, "mirror").catch(() => true))) {
      const body = "💻 Dari web: " + text + "\n\n" + [shown, ...added].filter(Boolean).join("\n\n");
      try { await sendTelegram(u, String(bot.chatId), body); } catch {}
    }

    const [freshTasks, freshNotes, freshExpenses, freshReminders, quota] = await Promise.all([getTasks(u), getNotes(u), getExpenses(u), getReminders(u), quotaStatus(u)]);
    return res.status(200).json({
      reply: shown, added, quota,
      tasks: freshTasks,
      reminders: freshReminders,
      notes: freshNotes.slice(-100).reverse(),
      expenses: freshExpenses.slice(-100).reverse(),
    });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.status ? e.message : "Server error: " + e.message });
  }
};
