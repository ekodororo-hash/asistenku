// Vercel Serverless Function: /api/state
// Dipakai web untuk memuat state awal (GET) dan melakukan satu aksi (POST),
// semua baca/tulis ke Redis yang sama dipakai bot Telegram.

const { redis, key, MAX_KEYS, listGeminiKeys, addGeminiKey, deleteGeminiKey, moveGeminiKey, setupBot, removeBot, relinkBot, botStatus } = require("./_lib");
const { requireUser } = require("./_auth");
const {
  getTasks, addTask, toggleTask, deleteTask,
  getNotes, addNote, deleteNoteById,
  getExpenses, addExpense, deleteExpenseById,
  getProfile, saveProfile,
  getMode, setMode,
  getHist,
} = require("./_lib");

module.exports = async (req, res) => {
  const u = await requireUser(req, res);
  if (!u) return;

  if (req.method === "GET") {
    try {
      const [tasks, notes, expenses, profile, mode, hist, keys, bot] = await Promise.all([
        getTasks(u), getNotes(u), getExpenses(u), getProfile(u), getMode(u), getHist(u), listGeminiKeys(u), botStatus(u),
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
        geminiKeys: keys, maxKeys: MAX_KEYS, globalKey: !!process.env.GEMINI_API_KEY, bot,
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
        case "addTask": result = await addTask(u, p.text); break;
        case "toggleTask": result = await toggleTask(u, p.id); break;
        case "deleteTask": result = await deleteTask(u, p.id); break;
        case "addNote": result = await addNote(u, p.text); break;
        case "deleteNote": result = await deleteNoteById(u, p.id); break;
        case "addExpense": result = await addExpense(u, p.amt, p.cat, p.note); break;
        case "deleteExpense": result = await deleteExpenseById(u, p.id); break;
        case "saveProfile": result = await saveProfile(u, p.profile || {}); break;
        case "addKey": result = await addGeminiKey(u, p.value); break;
        case "deleteKey": result = await deleteGeminiKey(u, p.id); break;
        case "moveKey": result = await moveGeminiKey(u, p.id, p.dir); break;
        case "setBot": {
          const host = req.headers["x-forwarded-host"] || req.headers.host;
          result = await setupBot(u, p.token, `https://${host}`);
          break;
        }
        case "removeBot": result = await removeBot(u); break;
        case "relinkBot": result = await relinkBot(u); break;
        case "setMode": result = await setMode(u, p.mode); break;
        case "resetHist": await redis("DEL", key(u, "hist")); result = { ok: true }; break;
        default: return res.status(400).json({ error: "op tidak dikenal: " + op });
      }
      return res.status(200).json({ ok: true, result });
    } catch (e) {
      return res.status(500).json({ error: "Server error: " + e.message });
    }
  }

  return res.status(405).json({ error: "Metode tidak didukung" });
};
