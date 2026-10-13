// Vercel Serverless Function: /api/chat
// Chat dari web, datanya dibaca/ditulis ke Redis yang sama dipakai bot Telegram
// supaya tugas, catatan, uang, mode, dan riwayat obrolan tersinkron di kedua sisi.

const {
  trimHist, geminiRaw, geminiSearch, sourceLine, REMIND_INTENT, DELETE_INTENT, deleteReminderNumber, fmtWib, rupiah,
  getMode, takeCurhatExpiredNotice, getHist, saveHist, getProfile, gemini, loadCurhatContext, buildCurhatSystem, stripTags,
  getTasks, addTask, getNotes, addNote, getExpenses, addExpense,
  getReminders, addReminder, parseRepeat, repeatLabel, rescheduleReminderNumber, getBot, sendTelegram, cfgOn, quotaStatus, setSaldo, addOutsideMoney, moneyContext, parseWib, addIncome, getIncomes, moneySummary,
  mentionsAmount, partnerContext, incomingTransfers, sendTransfer, handlePartnerIncome, answerDupMasuk,
  getFacts, addFacts, planDeletes, getPendingDelete, mochiChat, getMochi, takeMochiEvents, mochiView, pushCount,
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

// Status tujuan pengingat (Telegram dan/atau notifikasi PWA) untuk prompt
function deliveryLine(botLinked, pushOn) {
  if (botLinked && pushOn) return "Tujuan pengingat: bot Telegram sudah terhubung dan notifikasi PWA sudah aktif, jadi pengingat dikirim ke keduanya.";
  if (botLinked) return "Tujuan pengingat: bot Telegram sudah terhubung (pengingat dikirim ke sana). Itu sudah cukup, jadi jangan menyinggung notifikasi PWA.";
  if (pushOn) return "Tujuan pengingat: notifikasi PWA sudah aktif, tapi bot Telegram belum terhubung. Telegram lebih andal untuk pengingat karena notifikasi PWA bisa telat kalau aplikasinya lama tidak dibuka. Sarankan SEKALI dan singkat saat membuat pengingat agar pengguna menghubungkan Telegram di Pengaturan, jangan memaksa dan jangan diulang-ulang.";
  return "Tujuan pengingat: bot Telegram BELUM terhubung dan notifikasi PWA BELUM aktif. Pengingat tetap tersimpan tapi belum akan sampai ke mana pun sampai salah satunya diaktifkan di Pengaturan, dan Telegram yang paling dianjurkan. Ingatkan pengguna soal ini saat membuat pengingat.";
}

function buildSystem(mode, { profile, taskList, noteList, moneyText, remindText, botLinked, pushOn, partnerText, factsList }) {
  return `${mode === "curhat" ? PERSONA.curhat : PERSONA.asisten}
Nama kamu: ${profile.assistantName || "Asisten"}.
Pengguna bernama: ${profile.name || "(belum diisi)"}.
Catatan tentang pengguna: ${profile.notes || "(belum ada)"}.
Waktu sekarang pengguna: ${fmtWib(Date.now())}.

Yang kamu ingat tentang pengguna:
${factsList}

Daftar tugas pengguna:
${taskList}

Catatan pengguna (terbaru):
${noteList}

Pengeluaran pengguna:
${moneyText}

Pengingat mendatang:
${remindText}
${deliveryLine(botLinked, pushOn)}

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
- Pengingat juga bisa dihapus lewat tag lama [[HAPUS_PENGINGAT: N]] (N = nomor di daftar Pengingat mendatang); sama seperti [[HAPUS: ...]] di bawah, sistem tetap minta konfirmasi dulu.
- Pengingat BISA digeser jamnya lewat tag [[GESER_PENGINGAT: N | waktu_baru]] (N = nomor di daftar Pengingat mendatang, waktu_baru format ISO 8601 +07:00 seperti REMIND). Pakai ini kalau pengguna minta mengubah/menggeser/memajukan/memundurkan jam pengingat yang sudah ada, BUKAN hapus lalu bikin REMIND baru. Kalau tidak jelas pengingat yang mana atau jam barunya, tanyakan dulu.
- Fakta jangka panjang tentang pengguna (nama, orang penting, kebiasaan, preferensi, hal besar yang sedang dihadapi): [[INGAT: fakta singkat]]. Jangan simpan detail yang sangat sensitif kecuali pengguna memintanya. Tag ini tidak terlihat pengguna, jangan bilang "sudah kucatat" secara eksplisit kecuali relevan.
- Menghapus tugas, catatan, pengeluaran, pemasukan, atau pengingat: pakai tag [[HAPUS: jenis | kata kunci]]. Jenis salah satu: tugas, catatan, beli (pengeluaran), masuk (pemasukan), pengingat. Kata kunci = isi item seperti disebut pengguna, mis. "hapus beli makan 5rb" -> [[HAPUS: beli | makan 5rb]]. Untuk "yang barusan/terakhir/tadi" pakai kata kunci TERAKHIR dan tentukan jenisnya dari baris ✅ ⏰ 🗒️ 💰 💵 terakhir di balasanmu sebelumnya (✅ tugas, ⏰ pengingat, 🗒️ catatan, 💰 beli, 💵 masuk); kalau jenisnya tidak jelas, tanyakan dulu. Penghapusan TIDAK langsung: sistem mencari item lalu menampilkan tombol konfirmasi. Jadi balas singkat saja (mis. "Oke, konfirmasi dulu ya.") dan JANGAN bilang sudah dihapus. Hapus massal ("hapus semua ...") tidak didukung: tolak dengan sopan dan sarankan hapus satu per satu.
  Kalau pengguna membatalkan hal yang BARU dicatat ("eh ga jadi", "salah catat", "batal yang tadi", "salah input"), anggap itu permintaan hapus: pakai [[HAPUS: jenis | TERAKHIR]] sesuai jenis baris ✅ ⏰ 🗒️ 💰 💵 terakhir di balasanmu. JANGAN bilang "tidak jadi dicatat" tanpa tag ini, karena datanya sudah tersimpan.
- Pengeluaran yang sudah terjadi (mis. "makan siang 25rb", "beli bensin 50 ribu"): [[BELI: 25000 | makan | makan siang]]
  Jumlah rupiah angka bulat tanpa titik ("25rb" = 25000, "1,5jt" = 1500000). Kategori satu kata: makan, transport, belanja, tagihan, hiburan, kesehatan, lainnya.
- Pemasukan / uang masuk yang sudah terjadi (mis. "gajian 3jt", "dapat bonus 500rb"): [[MASUK: 3000000 | gaji | gajian]]
  Format angka sama seperti BELI. Kategori satu kata: gaji, bonus, usaha, hadiah, lainnya. Jangan pakai SALDO untuk uang masuk baru.
- Saldo/uang yang dimiliki pengguna sekarang (mis. \"uangku sekarang 500rb\"): [[SALDO: 500000]]. Kalau yang disebut uang TAMBAHAN di luar catatan (bukan total), pakai [[SALDO_LAIN: 65000]]. Angka bulat tanpa titik. Sisa uang = saldo + pemasukan - pengeluaran tercatat setelahnya (sudah dihitung di data uang di atas; jangan menebak kalau saldo belum diketahui).
- Kamu punya akses pencarian Google. Untuk hal yang terkini atau bisa berubah (jadwal pertandingan, skor, harga, berita, cuaca, hasil, tanggal rilis), cari dulu lalu jawab; jangan bilang kamu tidak bisa browsing. Jawab ringkas dan sebut waktu/tanggal datanya kalau penting. Hasil pencarian tidak perlu dicatat kecuali pengguna minta.
- Pertanyaan info (kurs, jadwal, harga, berita, dll) dijawab SEKARANG dalam balasan yang sama. Jangan bilang "sebentar aku cek" lalu membuat pengingat atau tugas; REMIND hanya kalau pengguna jelas minta diingatkan.
- Buat tag HANYA untuk permintaan di pesan pengguna yang TERBARU. Permintaan di pesan-pesan sebelumnya sudah diproses; jangan mengulang tagnya. Baris berawalan ⏰ ✅ 🗒️ 💰 💵 🗑️ di akhir balasanmu sebelumnya ditulis otomatis oleh sistem setelah tag berhasil diproses; itu tandanya permintaan tersebut SUDAH SELESAI. Jangan menulis baris seperti itu sendiri.
- Kalau pengguna mengirim foto struk/nota/bukti bayar: baca nama toko dan total bayar, catat dengan SATU tag [[BELI: ...]] untuk totalnya, lalu sebutkan hasil bacaanmu singkat (toko, total). Kalau angkanya tidak terbaca jelas, tanyakan dulu dan jangan buat tag. Foto lain (bukan struk) cukup ditanggapi biasa tanpa tag.
- Satu tag per hal, boleh lebih dari satu. Jangan membuat tag kalau pengguna tidak memintanya.
- Data ini juga dipakai lewat bot Telegram pengguna (tugas, catatan, uang, pengingat, riwayat obrolan sama persis).`;
}

async function processTags(u, reply, userText = "", hasImage = false) {
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
  await addFacts(u, [...reply.matchAll(/\[\[INGAT:\s*([^\]]+?)\s*\]\]/g)].map((m) => m[1]));
  const amountOk = hasImage || mentionsAmount(userText); // foto struk boleh tanpa angka di teks
  for (const m of amountOk ? [...reply.matchAll(/\[\[BELI:\s*([^|\]]+?)\s*\|\s*([^|\]]+?)\s*\|\s*([^\]]*?)\s*\]\]/g)] : []) {
    const amt = Number(String(m[1]).replace(/[^\d]/g, ""));
    const e = await addExpense(u, amt, m[2].trim(), m[3].trim());
    if (e) added.push("💰 Dicatat: " + rupiah(e.amt) + " (" + e.cat + ")" + (e.note ? " - " + e.note : "") + (e.dup ? "\n⚠️ Mirip pencatatan beberapa menit lalu (nominal & kategori sama) — kalau ini memang transaksi lain, nggak apa-apa." : ""));
  }

  for (const m of amountOk ? [...reply.matchAll(/\[\[MASUK:\s*([^|\]]+?)\s*\|\s*([^|\]]+?)\s*\|\s*([^\]]*?)\s*\]\]/g)] : []) {
    const amt = Number(String(m[1]).replace(/[^\d]/g, ""));
    const e = await addIncome(u, amt, m[2].trim(), m[3].trim());
    if (e) added.push("💵 Pemasukan dicatat: " + rupiah(e.amt) + " (" + e.cat + ")" + (e.note ? " - " + e.note : "") + (e.dup ? "\n⚠️ Mirip pemasukan beberapa menit lalu (nominal & kategori sama) — kalau ini memang beda, nggak apa-apa." : ""));
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

  // Hapus (tugas/catatan/uang/pengingat): TIDAK langsung. Cari item, simpan sebagai permintaan, minta konfirmasi lewat tombol.
  let confirm = null;
  if (DELETE_INTENT.test(userText)) {
    const pl = await planDeletes(u, reply);
    confirm = pl.pending;
    pl.misses.forEach((x) => added.push(x));
  }

  // Geser jam pengingat (mis. "geser yang bayar wifi jadi besok jam 9")
  if (remindOk) {
    for (const m of reply.matchAll(/\[\[GESER_PENGINGAT:\s*(\d+)\s*\|\s*([^\]]+?)\s*\]\]/g)) {
      const n = Number(m[1]);
      const r = await rescheduleReminderNumber(u, n, parseWib(m[2]));
      added.push(r ? "⏰ Pengingat digeser: " + r.text + " -> " + fmtWib(r.ts) : "Gagal menggeser: pengingat nomor " + n + " tidak ditemukan atau waktu tidak valid.");
    }
  }

  const clean = reply.replace(/\[\[(TASK|REMIND|INGAT|CATAT|BELI|MASUK|KIRIM|PASANGAN_MASUK|SALDO_LAIN|SALDO|HAPUS_PENGINGAT|HAPUS|GESER_PENGINGAT):[\s\S]*?\]\]/g, "").trim();
  return { clean, added, confirm };
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

// ---- Lampiran dari web: foto (sudah dikecilkan klien) dan suara (WAV 16 kHz) ----
const MAX_B64 = 3500000; // batas body fungsi Vercel ~4,5 MB
const IMG_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const AUD_MIME = new Set(["audio/wav", "audio/mpeg", "audio/mp3", "audio/ogg", "audio/aac", "audio/flac"]);
function pickMedia(m, allowed) {
  if (!m || typeof m !== "object") return null;
  const mime = String(m.mime || "").toLowerCase().split(";")[0].trim();
  const data = String(m.data || "").replace(/\s+/g, "");
  if (!data) return null;
  if (!allowed.has(mime)) { const e = new Error("Format lampiran tidak didukung."); e.status = 400; throw e; }
  if (data.length > MAX_B64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) { const e = new Error("Lampiran terlalu besar atau rusak. Coba yang lebih kecil."); e.status = 413; throw e; }
  return { mime, data };
}
// Pasang foto (kalau ada) pada giliran user terakhir
function withImage(contents, image, text) {
  if (!image) return contents;
  contents[contents.length - 1] = {
    role: "user",
    parts: [
      { inlineData: { mimeType: image.mime, data: image.data } },
      { text: text || "Ini fotoku. Tolong lihat dan tanggapi." },
    ],
  };
  return contents;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Gunakan metode POST" });
  }
  const u = await requireUser(req, res);
  if (!u) return;

  let text = String((req.body || {}).text || "").trim().slice(0, 4000);
  let image = null, audio = null, voice = false;
  try {
    image = pickMedia((req.body || {}).image, IMG_MIME);
    audio = pickMedia((req.body || {}).audio, AUD_MIME);
  } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  if (!text && !image && !audio) return res.status(400).json({ error: "Pesan kosong" });

  const wantStream = !!(req.body || {}).stream;
  const out = makeOut(res);
  const onText = wantStream ? makeStreamer(out.emit) : undefined;
  const finish = async (payload) => {
    if (voice) payload = { ...payload, transcript: text };
    try { // kabar Mochi (misi selesai, naik level) ikut dikirim ke web
      const mev = await takeMochiEvents(u);
      payload = { ...payload, mochi: mochiView(await getMochi(u)), mev };
    } catch {}
    if (!wantStream) return res.status(200).json(payload);
    out.emit({ t: "done", ...payload });
    return res.end();
  };

  try {
    // Pesan suara: ditranskrip dulu, hasilnya diperlakukan seperti teks yang diketik
    if (audio) {
      const t = await gemini(u, "Kamu hanya menulis transkrip.", [{
        role: "user",
        parts: [
          { inlineData: { mimeType: audio.mime, data: audio.data } },
          { text: "Tulis transkrip pesan suara ini apa adanya, dalam bahasa yang diucapkan. Balas hanya dengan transkripnya." },
        ],
      }], "web");
      text = String(t || "").trim().slice(0, 4000);
      voice = true;
      if (!text) return finish({ reply: "Maaf, suaranya kurang jelas. Coba rekam ulang?", added: [] });
      if (wantStream) out.emit({ t: "transcript", text });
    }
    const histText = image ? `[Foto] ${text}`.trim() : text;
    const mode = await getMode(u);
    await mochiChat(u, mode); // hitung sebagai misi "Ngobrol dengan asisten"

    // ---- Mode curhat: riwayat sendiri, tanpa tag, tanpa pencarian, tanpa salinan ke Telegram ----
    if (mode === "curhat") {
      const [hist, ctx] = await Promise.all([getHist(u, "curhat"), loadCurhatContext(u)]);
      const userTurn = { role: "user", parts: [{ text: histText }], ts: Date.now() };
      const raw = await gemini(u, buildCurhatSystem(ctx), withImage(trimHist([...hist, userTurn]), image, text), "web", onText);
      const reply = stripTags(raw) || "(tidak ada jawaban)";
      await saveHist(u, [...hist, userTurn, { role: "model", parts: [{ text: reply }], ts: Date.now() }], "curhat");
      return finish({ reply, added: [], mode: "curhat" });
    }

    const expiredNotice = await takeCurhatExpiredNotice(u); // curhat kedaluwarsa sendiri: kabari sekali
    if (wantStream && expiredNotice) out.emit({ t: "delta", text: expiredNotice + "\n\n" });
    const [hist, tasks, notes, expenses, profile, reminders, bot, facts] = await Promise.all([
      getHist(u, "asisten"), getTasks(u), getNotes(u), getExpenses(u), getProfile(u), getReminders(u), getBot(u).catch(() => null), getFacts(u),
    ]);
    const factsList = facts.length ? facts.map((f) => "- " + f).join("\n") : "(belum ada)";
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
    const dupReply = image ? null : await answerDupMasuk(u, text);
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

    const system = buildSystem(mode, { profile, taskList, noteList, moneyText: await moneyContext(u), remindText, botLinked: !!(bot && bot.chatId), pushOn: await pushCount(u).then((n) => n > 0).catch(() => true), partnerText: await partnerContext(u).catch(() => ""), factsList });

    const userTurn = { role: "user", parts: [{ text: histText }], ts: Date.now() };
    const contents = withImage(trimHist([...hist, userTurn]), image, text);

    const found = await geminiSearch(u, system, contents, "web", onText);
    const raw = found.text;
    const { clean, added, confirm } = await processTags(u, raw, text, !!image);
    const reply = clean || (added.length ? "" : "(tidak ada jawaban)");
    const shown = [expiredNotice, reply, sourceLine(found.sources, found.searchError)].filter(Boolean).join("\n\n"); // sumber hanya ditampilkan, tidak masuk riwayat

    const newHist = [...hist, userTurn, { role: "model", parts: [{ text: [reply, ...added].filter(Boolean).join("\n\n") || "(dicatat)" }], ts: Date.now() }];
    await saveHist(u, newHist, "asisten");
    if (wantStream) out.emit({ t: "final", text: [shown, ...added].filter(Boolean).join("\n\n") || "(tidak ada jawaban)" }); // teks akhir tanpa tag, sebelum langkah susulan

    // Salin ke Telegram supaya obrolan di web juga terlihat di chat Telegram (matikan: /salin off)
    if (bot && bot.chatId && (await cfgOn(u, "mirror").catch(() => true))) {
      const body = "💻 Dari web: " + (voice ? "🎙️ " + text : image ? "📷 " + text : text).trim() + "\n\n" + [shown, ...added].filter(Boolean).join("\n\n");
      try { await sendTelegram(u, String(bot.chatId), body); } catch {}
    }

    const [freshTasks, freshNotes, freshExpenses, freshReminders, quota, freshIncomes, money] = await Promise.all([getTasks(u), getNotes(u), getExpenses(u), getReminders(u), quotaStatus(u), getIncomes(u), moneySummary(u)]);
    const xferIn = await incomingTransfers(u).catch(() => []);
    return finish({
      reply: shown, added, quota, xferIn, confirm: confirm || null,
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
