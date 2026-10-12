// Vercel Serverless Function: /api/info?type=weather&city=Bandung  |  /api/info?type=news&topic=ekonomi
// Cuaca: Open-Meteo. Berita: RSS Google News. Keduanya tanpa API key.

function wmo(c) {
  if (c === 0) return "cerah";
  if (c === 1) return "cerah berawan";
  if (c === 2) return "berawan sebagian";
  if (c === 3) return "berawan";
  if (c === 45 || c === 48) return "berkabut";
  if (c >= 51 && c <= 57) return "gerimis";
  if (c >= 61 && c <= 67) return "hujan";
  if (c >= 80 && c <= 82) return "hujan deras sesaat";
  if (c >= 95) return "badai petir";
  return "berubah-ubah";
}

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("Layanan data tidak merespons");
  return r.json();
}

async function weather(city) {
  const g = await getJson(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=id`
  );
  const loc = g.results && g.results[0];
  if (!loc) throw new Error("Kota tidak ditemukan");
  const d = await getJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}` +
      `&current=temperature_2m,apparent_temperature,weather_code` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
      `&timezone=auto&forecast_days=1`
  );
  if (!d.current || !d.daily) throw new Error("Data cuaca tidak tersedia");
  const c = d.current, dy = d.daily;
  return (
    `${loc.name}${loc.country ? ", " + loc.country : ""}\n` +
    `Sekarang: ${wmo(c.weather_code)}, ${Math.round(c.temperature_2m)}°C (terasa ${Math.round(c.apparent_temperature)}°C)\n` +
    `Hari ini: ${wmo(dy.weather_code[0])}, ${Math.round(dy.temperature_2m_min[0])}-${Math.round(dy.temperature_2m_max[0])}°C\n` +
    `Peluang hujan: ${dy.precipitation_probability_max[0]}%`
  );
}

async function news(topic) {
  const url = topic
    ? `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=id&gl=ID&ceid=ID:id`
    : "https://news.google.com/rss?hl=id&gl=ID&ceid=ID:id";
  const r = await fetch(url);
  if (!r.ok) throw new Error("Gagal mengambil berita");
  const xml = await r.text();
  const decode = (s) =>
    s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").trim();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 8).map((m) => ({
    title: decode((m[1].match(/<title>([\s\S]*?)<\/title>/) || [])[1] || ""),
    link: decode((m[1].match(/<link>([\s\S]*?)<\/link>/) || [])[1] || ""),
  }));
}

module.exports = async (req, res) => {
  try {
    const type = req.query.type;
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
    if (type === "weather") {
      const city = String(req.query.city || "Jakarta").slice(0, 80);
      return res.status(200).json({ text: await weather(city) });
    }
    if (type === "news") {
      const topic = String(req.query.topic || "").slice(0, 80);
      return res.status(200).json({ items: await news(topic) });
    }
    return res.status(400).json({ error: "type tidak dikenal" });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(500).json({ error: e.message });
  }
};
