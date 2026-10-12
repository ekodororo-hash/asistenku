// Vercel Serverless Function: /api/state
// Dipakai web untuk memuat state awal (GET) dan melakukan satu aksi (POST),
// semua baca/tulis ke Redis yang sama dipakai bot Telegram.

const {
  requirePin, redis,
  getTasks, addTask, toggleTask, deleteTask,
  getNotes, addNote, deleteNoteById,
  getExpenses, addExpense, deleteExpenseById,
  getProfile, saveProfile,
  getMode, setMode,
  getHist,
} = require("./_lib");

module.exports = async (req, res) => {
  if (!requirePin(req, res)) return;

  if (req.method === "GET") {
    try {
      const [tasks, notes, expenses, profile, mode, hist] = await Promise.all([
        getTasks(), getNotes(), getExpenses(), getProfile(), getMode(), getHist(),
      ]);
      const messages = hist.map((h) => ({
        role: h.role === "user" ? "user" : "model",
        text: (h.parts || []).map((p) => p.text || "").join(""),
      }));
      return res.status(200).json({
        tasks,
        notes: notes.slice(-100).reverse(),
        expenses: expenses.slice(-100).reverse(),
        profile, mode, messages,
      });
    } catch (e) {
      return res.status(500).json({ error: "Server error: " + e.message });
    }
  }

  if (req.method === "POST") {
    const { op, ...p } = req.body || {};
    try {
      let result;
      switch (op) {
        case "addTask": result = await addTask(p.text); break;
        case "toggleTask": result = await toggleTask(p.id); break;
        case "deleteTask": result = await deleteTask(p.id); break;
        case "addNote": result = await addNote(p.text); break;
        case "deleteNote": result = await deleteNoteById(p.id); break;
        case "addExpense": result = await addExpense(p.amt, p.cat, p.note); break;
        case "deleteExpense": result = await deleteExpenseById(p.id); break;
        case "saveProfile": result = await saveProfile(p.profile || {}); break;
        case "setMode": result = await setMode(p.mode); break;
        case "resetHist": await redis("DEL", "hist"); result = { ok: true }; break;
        default: return res.status(400).json({ error: "op tidak dikenal: " + op });
      }
      return res.status(200).json({ ok: true, result });
    } catch (e) {
      return res.status(500).json({ error: "Server error: " + e.message });
    }
  }

  return res.status(405).json({ error: "Metode tidak didukung" });
};
