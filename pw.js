/* Bantuan input password: ikon mata, bar kekuatan, dan contoh password kuat.
   Dipakai di index.html (daftar) dan settings.html (ganti password, key, token).
   API: PW.eye(input)  -> hanya ikon mata
        PW.attach(input, { examples: true }) -> ikon mata + bar kekuatan (+ contoh). Mengembalikan elemen kotak bar. */
(function () {
  const css = `
.pw{position:relative;flex:1;min-width:0;width:100%}
.pw input{padding-right:44px!important;width:100%}
.pw-eye{position:absolute;right:4px;top:50%;transform:translateY(-50%);border:none!important;background:transparent!important;padding:6px 8px!important;min-width:0!important;width:auto!important;color:var(--muted,#6b7385);cursor:pointer;line-height:0;border-radius:8px}
.pw-eye svg{width:20px;height:20px;display:block}
.pw-box{margin:8px 0 0;font-size:13px;line-height:1.5;color:var(--muted,#6b7385);text-align:left;width:100%}
.pw-bar{height:6px;border-radius:99px;background:var(--line,#e4e7ef);overflow:hidden}
.pw-bar i{display:block;height:100%;width:0;border-radius:99px;transition:width .2s,background .2s}
.pw-top{display:flex;justify-content:space-between;gap:8px;margin-top:5px}
.pw-top b{font-weight:600}
.pw-list{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:4px}
.pw-list span{opacity:.6}
.pw-list span.ok{opacity:1;color:var(--ok,#2a9d4b)}
.pw-ex{margin-top:8px}
.pw-ex code{font-family:ui-monospace,Menlo,Consolas,monospace;background:var(--bg,#f6f7fb);padding:2px 6px;border-radius:6px;word-break:break-all;color:var(--ink,#1d2433)}
.pw-ex .pw-btns{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.pw-ex button{font:inherit;font-size:13px;cursor:pointer;border:1px solid var(--line,#e4e7ef);background:var(--card,#fff);color:var(--ink,#1d2433);border-radius:8px;padding:4px 10px}
`;
  const st = document.createElement("style");
  st.textContent = css;
  document.head.appendChild(st);

  const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 19C5 19 1 12 1 12a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A9.1 9.1 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/></svg>';

  function eye(input) {
    if (input.parentElement && input.parentElement.classList.contains("pw")) return input.parentElement;
    const wrap = document.createElement("div");
    wrap.className = "pw";
    wrap.style.margin = input.style.margin; // pertahankan jarak bawaan dari input
    input.style.margin = "0";
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pw-eye";
    b.setAttribute("aria-label", "Tampilkan password");
    b.innerHTML = EYE;
    b.onclick = () => {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      b.innerHTML = show ? EYE_OFF : EYE;
      b.setAttribute("aria-label", show ? "Sembunyikan password" : "Tampilkan password");
    };
    wrap.appendChild(b);
    return wrap;
  }

  const CHECKS = [
    ["Minimal 8 karakter", (p) => p.length >= 8],
    ["Huruf besar & kecil", (p) => /[a-z]/.test(p) && /[A-Z]/.test(p)],
    ["Angka", (p) => /\d/.test(p)],
    ["Simbol (!@#-_)", (p) => /[^A-Za-z0-9]/.test(p)],
  ];

  function score(p) {
    if (!p) return 0;
    const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length;
    let s = Math.min(p.length, 16) * 4 + (kinds - 1) * 10 + (p.length >= 12 ? 6 : 0);
    if (/(.)\1{2,}/.test(p)) s -= 10;
    if (/^(.)\1+$/.test(p) || /^\d+$/.test(p)) s = Math.min(s, 20);
    if (/(password|passw0rd|qwerty|123456|abcdef|asdf|admin|rahasia|sandi|bismillah|indonesia)/i.test(p)) s = Math.min(s, 30);
    if (p.length < 8) s = Math.min(s, 25);
    return Math.max(0, Math.min(100, s));
  }

  const LEVELS = [
    [35, "Lemah", "#d33"],
    [60, "Cukup", "#e8890c"],
    [80, "Kuat", "#6cb33f"],
    [101, "Sangat kuat", "#2a9d4b"],
  ];

  function attach(input, opts) {
    opts = opts || {};
    const wrap = eye(input);
    const box = document.createElement("div");
    box.className = "pw-box";
    box.innerHTML =
      '<div class="pw-bar"><i></i></div>' +
      '<div class="pw-top"><span>Kekuatan: <b class="pw-lvl">-</b></span></div>' +
      '<div class="pw-list">' + CHECKS.map((c) => "<span>○ " + c[0] + "</span>").join("") + "</div>";
    const anchor = wrap.parentElement.classList.contains("row") ? wrap.parentElement : wrap;
    anchor.insertAdjacentElement("afterend", box);

    const bar = box.querySelector(".pw-bar i");
    const lvl = box.querySelector(".pw-lvl");
    const items = box.querySelectorAll(".pw-list span");
    function update() {
      const p = input.value;
      const s = score(p);
      const L = LEVELS.find((l) => s < l[0]);
      bar.style.width = (p ? Math.max(8, s) : 0) + "%";
      bar.style.background = L[2];
      lvl.textContent = p ? L[1] : "-";
      lvl.style.color = p ? L[2] : "";
      CHECKS.forEach((c, i) => {
        const ok = c[1](p);
        items[i].className = ok ? "ok" : "";
        items[i].textContent = (ok ? "✓ " : "○ ") + c[0];
      });
    }
    input.addEventListener("input", update);
    update();

    if (opts.examples) {
      // Hanya petunjuk statis (tanpa contoh password dan tanpa tombol)
      const ex = document.createElement("div");
      ex.className = "pw-ex";
      ex.innerHTML = "Pola yang mudah diingat: <b>3 kata + angka + simbol</b>.";
      box.appendChild(ex);
    }
    return box;
  }

  window.PW = { eye, attach, score };
})();
