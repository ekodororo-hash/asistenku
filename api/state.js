// Vercel Serverless Function: /api/state
// Dipakai web untuk memuat state awal (GET) dan melakukan satu aksi (POST),
// semua baca/tulis ke Redis yang sama dipakai bot Telegram.

const { redis, key, MAX_KEYS, keyState, clearKeyHistory, testGeminiKey, getModelCfg, saveModelCfg, listGeminiModels, addGeminiKey, renameGeminiKey, deleteGeminiKey, moveGeminiKey, setupBot, removeBot, relinkBot, botStatus } = require("./_lib");
const { requireUser } = require("./_auth");
const {
  getTasks, addTask, toggleTask, deleteTask,
  getNotes, addNote, deleteNoteById,
  getExpenses, addExpense, deleteExpenseById,
  getIncomes, addIncome, deleteIncomeById, moneySummary,
  getProfile, saveProfile,
  getMode, switchMode,
  getHist, clearHist, getBot,
  getReminders, addReminder, deleteReminderById,
} = require("./_lib");

// Riwayat -> bentuk yang dipakai web
const toMessages = (hist) => hist.map((h) => ({
  role: h.role === "user" ? "user" : "model",
  text: (h.parts || []).map((p) => p.text || "").join(""),
  ts: h.ts || null,
}));

module.exports = async (req, res) => {
  const u = await requireUser(req, res);
  if (!u) return;

  if (req.method === "GET") {
    try {
      // ?light=1: dipakai web untuk penyegaran berkala (tanpa key dan tanpa panggilan ke Telegram)
      const light = !!(req.query && req.query.light);
      const mode = await getMode(u);
      const [tasks, notes, expenses, incomes, money, profile, hist, reminders, kstate, bot, rawBot, mcfg] = await Promise.all([
        getTasks(u), getNotes(u), getExpenses(u), getIncomes(u), moneySummary(u), getProfile(u), getHist(u, mode), getReminders(u),
        light ? null : keyState(u), light ? null : botStatus(u), light ? getBot(u).catch(() => null) : null, light ? null : getModelCfg(u),
      ]);
      const botLinked = light ? !!(rawBot && rawBot.chatId) : !!(bot && bot.linked);
      const messages = toMessages(hist); // riwayat milik mode yang sedang aktif
      return res.status(200).json({
        tasks,
        notes: notes.slice(-100).reverse(),
        expenses: expenses.slice(-100).reverse(),
        incomes: incomes.slice(-100).reverse(),
        money,
        profile, mode, messages, reminders, botLinked,
        ...(light ? {} : { geminiKeys: kstate.keys, keyHistoryCount: kstate.history.length, modelCfg: mcfg, maxKeys: MAX_KEYS, globalKey: !!process.env.GEMINI_API_KEY, bot }),
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
        case "addTask": result = await addTask(u, p.text, p.ts); break;
        case "toggleTask": result = await toggleTask(u, p.id); break;
        case "deleteTask": result = await deleteTask(u, p.id); break;
        case "addReminder": result = await addReminder(u, p.text, p.ts, p.repeat); if (!result) throw new Error("Waktu pengingat tidak valid atau sudah lewat."); break;
        case "deleteReminder": result = await deleteReminderById(u, p.id); break;
        case "addNote": result = await addNote(u, p.text); break;
        case "deleteNote": result = await deleteNoteById(u, p.id); break;
        case "addExpense": result = await addExpense(u, p.amt, p.cat, p.note); break;
        case "deleteExpense": result = await deleteExpenseById(u, p.id); break;
        case "addIncome": result = await addIncome(u, p.amt, p.cat, p.note); break;
        case "deleteIncome": result = await deleteIncomeById(u, p.id); break;
        case "saveProfile": result = await saveProfile(u, p.profile || {}); break;
        case "addKey": result = await addGeminiKey(u, p.value, p.name); break;
        case "renameKey": result = await renameGeminiKey(u, p.id, p.name); break;
        case "deleteKey": result = await deleteGeminiKey(u, p.id); break;
        case "moveKey": result = await moveGeminiKey(u, p.id, p.dir); break;
        case "saveModel": result = await saveModelCfg(u, p.model, p.fallback); break;
        case "listModels": result = await listGeminiModels(u); break;
        case "keyHistory": result = await keyState(u); break;
        case "testKey": result = await testGeminiKey(u, p.id); break;
        case "clearKeyHistory": await clearKeyHistory(u); result = await keyState(u); break;
        case "setBot": {
          const host = req.headers["x-forwarded-host"] || req.headers.host;
          result = await setupBot(u, p.token, `https://${host}`);
          break;
        }
        case "removeBot": result = await removeBot(u); break;
        case "relinkBot": result = await relinkBot(u); break;
        case "setMode": {
          result = await switchMode(u, p.mode, p.curhatAction);
          if (!result.needConfirm) result.messages = toMessages(await getHist(u, result.mode)); // riwayat milik mode tujuan
          break;
        }
        case "resetHist": { // hanya riwayat mode yang sedang aktif
          const mode = await getMode(u);
          await clearHist(u, mode);
          result = { ok: true, mode };
          break;
        }
        default: return res.status(400).json({ error: "op tidak dikenal: " + op });
      }
      return res.status(200).json({ ok: true, result });
    } catch (e) {
      return res.status(500).json({ error: "Server error: " + e.message });
    }
  }

  return res.status(405).json({ error: "Metode tidak didukung" });
};
