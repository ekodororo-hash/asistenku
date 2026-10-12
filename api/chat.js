// Vercel Serverless Function: /api/chat
// API key dibaca dari Environment Variable, tidak pernah dikirim ke browser.

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

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Gunakan metode POST" });
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return res.status(500).json({ error: "GEMINI_API_KEY belum diisi di Vercel" });
  }

  // Nama model bisa diganti lewat env GEMINI_MODEL tanpa ubah kode.
  const model = process.env.GEMINI_MODEL || "gemini-flash-latest";

  const { messages = [], profile = {}, tasks = [], notes = [], money = "", mode = "asisten", now = "" } = req.body || {};

  const taskList = tasks.length
    ? tasks.slice(-40).map((t, i) => `${i + 1}. ${t.done ? "[selesai]" : "[belum]"} ${String(t.text).slice(0, 200)}`).join("\n")
    : "(kosong)";
  const noteList = notes.length
    ? notes.slice(-20).map((n) => "- " + String(n).slice(0, 200)).join("\n")
    : "(kosong)";

  const system = `${mode === "curhat" ? PERSONA.curhat : PERSONA.asisten}
Nama kamu: ${profile.assistantName || "Asisten"}.
Pengguna bernama: ${profile.name || "(belum diisi)"}.
Catatan tentang pengguna: ${profile.notes || "(belum ada)"}.
Waktu sekarang pengguna: ${now}.

Daftar tugas pengguna:
${taskList}

Catatan pengguna (terbaru):
${noteList}

Pengeluaran pengguna:
${String(money).slice(0, 1500) || "(belum ada)"}

Aturan:
- Tulis teks biasa, tanpa markdown (tanpa * atau #). Emoji boleh secukupnya.
- Jangan memberi diagnosis medis.
- Jika ada tanda pengguna ingin menyakiti diri, ingin mengakhiri hidup, atau dalam bahaya: tanggapi dengan tenang dan sungguh-sungguh, tanyakan langsung apakah dia aman sekarang, jangan menghakimi, dorong dia menghubungi orang terdekat yang dipercaya dan layanan darurat/kesehatan jiwa setempat (Indonesia: 112 untuk darurat; 119 ekstensi 8 untuk layanan kesehatan jiwa Kemenkes), dan tetap temani dia bicara. Jangan memberi informasi cara menyakiti diri.

Tag khusus (taruh di baris terakhir balasan; pengguna tidak melihatnya):
- Tambah tugas: [[TASK: isi tugas singkat]]. Ubah tanggal relatif seperti "besok" menjadi tanggal jelas dari waktu sekarang.
- Catatan jika pengguna minta mencatat sesuatu: [[CATAT: isi catatan]]
- Pengeluaran yang sudah terjadi (mis. "makan siang 25rb", "beli bensin 50 ribu"): [[BELI: 25000 | makan | makan siang]]
  Jumlah rupiah angka bulat tanpa titik ("25rb" = 25000, "1,5jt" = 1500000). Kategori satu kata: makan, transport, belanja, tagihan, hiburan, kesehatan, lainnya.
- Satu tag per hal, boleh lebih dari satu. Jangan membuat tag kalau pengguna tidak memintanya.
- Halaman web ini tidak bisa mengirim notifikasi di luar halaman; jangan berjanji bisa mengingatkan otomatis. Untuk pengingat berjam-jam, sarankan memakai bot Telegram milik pengguna.`;

  const contents = messages.slice(-20).map((m) => ({
    role: m.role === "user" ? "user" : "model",
    parts: [{ text: String(m.text || "").slice(0, 4000) }],
  }));
  while (contents.length && contents[0].role === "model") contents.shift();

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents,
        }),
      }
    );
    const data = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: data?.error?.message || "Gagal memanggil Gemini" });
    }
    const reply = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
    return res.status(200).json({ reply: reply || "(tidak ada jawaban)" });
  } catch (e) {
    return res.status(500).json({ error: "Server error: " + e.message });
  }
};
