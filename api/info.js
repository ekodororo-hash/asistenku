// Vercel Serverless Function: /api/info
//   ?type=weather&city=Bandung
//   ?type=news&cat=terkini            (berita berfoto dari RSS media)
//   ?type=news&topic=ekonomi          (pencarian topik via Google News, tanpa foto)
// Cuaca: Open-Meteo. Semua tanpa API key.

// ---------- Cuaca ----------
function wmo(c) {
  if (c === 0) return "cerah";
  if (c === 1) return "cerah berawan";
  if (c === 2) return "berawan sebagian";
  if (c === 3) return "berawan";
  if (c === 45 || c === 48) return "berkabut";
  if (c >= 51 && c <= 57) return "gerimis";
  if (c >= 61 && c <= 67) return "hujan";
  if (c >= 71 && c <= 77) return "salju";
  if (c >= 80 && c <= 82) return "hujan deras sesaat";
  if (c >= 95) return "badai petir";
  return "berubah-ubah";
}

function icon(c, day = true) {
  if (c === 0 || c === 1) return day ? "☀️" : "🌙";
  if (c === 2) return day ? "⛅" : "☁️";
  if (c === 3) return "☁️";
  if (c === 45 || c === 48) return "🌫️";
  if (c >= 51 && c <= 57) return "🌦️";
  if (c >= 61 && c <= 67) return "🌧️";
  if (c >= 71 && c <= 77) return "❄️";
  if (c >= 80 && c <= 82) return "🌧️";
  if (c >= 95) return "⛈️";
  return "🌡️";
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
      `&current=temperature_2m,apparent_temperature,weather_code,is_day` +
      `&hourly=temperature_2m,weather_code,precipitation_probability,is_day` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
      `&timezone=auto&forecast_days=2`
  );
  if (!d.current || !d.daily || !d.hourly) throw new Error("Data cuaca tidak tersedia");
  const c = d.current, dy = d.daily, h = d.hourly;

  // 6 jam ke depan, mulai dari jam berikutnya
  const nowHour = String(c.time).slice(0, 13) + ":00";
  let start = h.time.findIndex((t) => t > nowHour);
  if (start < 0) start = 0;
  const hours = h.time.slice(start, start + 6).map((t, i) => ({
    time: String(t).slice(11, 16),
    icon: icon(h.weather_code[start + i], h.is_day[start + i] === 1),
    temp: Math.round(h.temperature_2m[start + i]),
    rain: h.precipitation_probability[start + i],
  }));

  const day = c.is_day === 1;
  const w = {
    city: loc.name,
    country: loc.country || "",
    icon: icon(c.weather_code, day),
    desc: wmo(c.weather_code),
    temp: Math.round(c.temperature_2m),
    feels: Math.round(c.apparent_temperature),
    min: Math.round(dy.temperature_2m_min[0]),
    max: Math.round(dy.temperature_2m_max[0]),
    rain: dy.precipitation_probability_max[0],
    today: wmo(dy.weather_code[0]),
    hours,
  };
  w.text =
    `${w.city}${w.country ? ", " + w.country : ""}\n` +
    `Sekarang: ${w.desc}, ${w.temp}°C (terasa ${w.feels}°C)\n` +
    `Hari ini: ${w.today}, ${w.min}-${w.max}°C\n` +
    `Peluang hujan: ${w.rain}%`;
  return w;
}

// ---------- Berita ----------
// Kategori berfoto: setiap feed menyertakan <enclosure url="...gambar...">
const FEEDS = {
  terkini: { name: "Antara", url: "https://www.antaranews.com/rss/terkini.xml" },
  nasional: { name: "CNN Indonesia", url: "https://www.cnnindonesia.com/nasional/rss" },
  detik: { name: "detikNews", url: "https://news.detik.com/berita/rss" },
  ekonomi: { name: "CNN Indonesia", url: "https://www.cnnindonesia.com/ekonomi/rss" },
  teknologi: { name: "CNN Indonesia", url: "https://www.cnnindonesia.com/teknologi/rss" },
  olahraga: { name: "CNN Indonesia", url: "https://www.cnnindonesia.com/olahraga/rss" },
};

function decode(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : "";
};

function findImage(block) {
  let m = block.match(/<enclosure[^>]*\burl="([^"]+)"/i);
  if (!m) m = block.match(/<media:(?:content|thumbnail)[^>]*\burl="([^"]+)"/i);
  if (!m) {
    // gambar di dalam <description>, bisa berupa teks ter-escape atau CDATA
    const desc = decode(tag(block, "description"));
    m = desc.match(/<img[^>]*\bsrc=["']([^"']+)["']/i);
  }
  if (!m) return "";
  let url = decode(m[1]).replace(/^http:\/\//i, "https://");
  return /^https:\/\//i.test(url) ? url : "";
}

function parseItems(xml, source, limit) {
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const b = m[1];
    const title = tag(b, "title");
    let link = tag(b, "link") || tag(b, "guid");
    if (!title || !/^https?:\/\//i.test(link)) continue;
    link = link.replace(/^http:\/\//i, "https://");
    const t = Date.parse(tag(b, "pubDate"));
    out.push({
      title,
      link,
      img: findImage(b),
      source,
      date: isNaN(t) ? "" : new Date(t).toISOString(),
    });
    if (out.length >= limit) break;
  }
  return out;
}

async function fetchXml(url) {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; asisten-pribadi)" } });
  if (!r.ok) throw new Error("Gagal mengambil berita");
  return r.text();
}

async function news(cat, topic) {
  if (topic) {
    // pencarian topik: Google News (tanpa foto)
    const xml = await fetchXml(
      `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=id&gl=ID&ceid=ID:id`
    );
    return parseItems(xml, "Google News", 10).map((it) => {
      // judul Google News berakhiran " - Nama Media"
      const i = it.title.lastIndexOf(" - ");
      return i > 0 ? { ...it, title: it.title.slice(0, i), source: it.title.slice(i + 3) } : it;
    });
  }
  const feed = FEEDS[cat] || FEEDS.terkini;
  const xml = await fetchXml(feed.url);
  return parseItems(xml, feed.name, 10);
}

module.exports = async (req, res) => {
  try {
    const type = req.query.type;
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
    if (type === "weather") {
      const city = String(req.query.city || "Jakarta").slice(0, 80);
      return res.status(200).json(await weather(city));
    }
    if (type === "news") {
      const topic = String(req.query.topic || "").slice(0, 80).trim();
      const cat = String(req.query.cat || "terkini");
      return res.status(200).json({ items: await news(cat, topic) });
    }
    res.setHeader("Cache-Control", "no-store");
    return res.status(400).json({ error: "type tidak dikenal" });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(500).json({ error: e.message });
  }
};
