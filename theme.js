/* Tampilan: mode warna, warna aksen, wallpaper chat, gaya bubble.
   Disimpan per perangkat di localStorage (bukan data pribadi). Dimuat di <head> supaya
   tidak ada kedipan tema lama saat halaman dibuka. */
(function () {
  var KEY = "look", PHOTO = "look_photo";
  var D = { scheme: "auto", accent: "indigo", wall: "none", bubble: "klasik", dim: 20 };

  var ACCENTS = {
    indigo:  { name: "Indigo",  c: "#4f46e5" },
    biru:    { name: "Biru",    c: "#2563eb" },
    teal:    { name: "Teal",    c: "#0f766e" },
    hijau:   { name: "Hijau",   c: "#047857" },
    jingga:  { name: "Jingga",  c: "#c2410c" },
    pink:    { name: "Pink",    c: "#db2777" },
    ungu:    { name: "Ungu",    c: "#7c3aed" }
  };

  var N = "rgba(127,127,127,";
  var WALLS = {
    none:    { name: "Polos",    img: "none", size: "auto" },
    dots:    { name: "Titik",    img: "radial-gradient(" + N + ".28) 1.3px, transparent 1.6px)", size: "18px 18px" },
    grid:    { name: "Kotak",    img: "linear-gradient(" + N + ".14) 1px, transparent 1px), linear-gradient(90deg, " + N + ".14) 1px, transparent 1px)", size: "28px 28px" },
    stripes: { name: "Garis",    img: "repeating-linear-gradient(45deg, " + N + ".10) 0 2px, transparent 2px 14px)", size: "auto" },
    aurora:  { name: "Aurora",   img: "radial-gradient(circle at 15% 10%, color-mix(in srgb, var(--accent) 30%, transparent), transparent 55%), radial-gradient(circle at 90% 85%, color-mix(in srgb, var(--accent) 22%, #ec4899 18%), transparent 55%)", size: "auto" },
    senja:   { name: "Senja",    img: "linear-gradient(160deg, rgba(251,191,36,.30), rgba(244,114,182,.30) 50%, rgba(129,140,248,.34))", size: "auto" },
    laut:    { name: "Laut",     img: "linear-gradient(180deg, rgba(56,189,248,.26), rgba(20,184,166,.22) 60%, rgba(16,185,129,.20))", size: "auto" },
    foto:    { name: "Foto",     img: "", size: "cover" }
  };
  var BUBBLES = { klasik: "Klasik", bulat: "Bulat", kotak: "Kotak", gradien: "Gradien" };

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  function get() {
    var o = {};
    try { o = JSON.parse(lsGet(KEY)) || {}; } catch (e) {}
    var r = {};
    for (var k in D) r[k] = o[k] === undefined ? D[k] : o[k];
    if (!ACCENTS[r.accent]) r.accent = D.accent;
    if (!WALLS[r.wall]) r.wall = D.wall;
    if (!BUBBLES[r.bubble]) r.bubble = D.bubble;
    if (["auto", "light", "dark"].indexOf(r.scheme) < 0) r.scheme = D.scheme;
    return r;
  }
  function photo() { return lsGet(PHOTO) || ""; }
  function wallImage(L, p) {
    if (L.wall === "foto") {
      if (!p) return { img: "none", size: "auto" };
      var d = Math.max(0, Math.min(70, +L.dim || 0)) / 100;
      return { img: "linear-gradient(rgba(0,0,0," + d + "), rgba(0,0,0," + d + ")), url(" + p + ")", size: "cover" };
    }
    return WALLS[L.wall];
  }

  function apply() {
    var L = get(), h = document.documentElement, s = h.style, p = photo();
    if (L.scheme === "auto") h.removeAttribute("data-scheme"); else h.setAttribute("data-scheme", L.scheme);
    var a = ACCENTS[L.accent].c;
    if (L.accent === "indigo") { s.removeProperty("--accent"); s.removeProperty("--me"); }
    else { s.setProperty("--accent", a); s.setProperty("--me", a); }
    var w = wallImage(L, p);
    if (w.img === "none") { h.removeAttribute("data-wall"); s.removeProperty("--wall"); s.removeProperty("--wall-size"); }
    else { h.setAttribute("data-wall", L.wall); s.setProperty("--wall", w.img); s.setProperty("--wall-size", w.size); }
    h.setAttribute("data-bubble", L.bubble);
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute("content", a);
  }

  function set(patch) {
    var L = get();
    for (var k in patch) L[k] = patch[k];
    lsSet(KEY, JSON.stringify(L));
    apply();
    return L;
  }
  function reset() { lsDel(KEY); lsDel(PHOTO); apply(); }

  // Perkecil foto supaya muat di localStorage (maks ~1280px, JPEG).
  function setPhoto(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !/^image\//.test(file.type)) return reject(new Error("Pilih file gambar."));
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        try {
          var max = 1280, sc = Math.min(1, max / Math.max(img.width, img.height));
          var c = document.createElement("canvas");
          c.width = Math.max(1, Math.round(img.width * sc)); c.height = Math.max(1, Math.round(img.height * sc));
          c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
          var q = 0.72, data = c.toDataURL("image/jpeg", q);
          while (data.length > 900000 && q > 0.35) { q -= 0.12; data = c.toDataURL("image/jpeg", q); }
          URL.revokeObjectURL(url);
          if (!lsSet(PHOTO, data)) return reject(new Error("Penyimpanan perangkat penuh, coba foto yang lebih kecil."));
          set({ wall: "foto" });
          resolve();
        } catch (e) { reject(e); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("Gambar tidak bisa dibuka.")); };
      img.src = url;
    });
  }
  function clearPhoto() {
    lsDel(PHOTO);
    if (get().wall === "foto") set({ wall: "none" }); else apply();
  }

  window.Look = { get: get, set: set, reset: reset, photo: photo, setPhoto: setPhoto, clearPhoto: clearPhoto, ACCENTS: ACCENTS, WALLS: WALLS, BUBBLES: BUBBLES, wallImage: wallImage };
  apply();
})();
