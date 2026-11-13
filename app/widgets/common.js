/* Leave Sync for YouTrack – shared widget helpers (exposed as window.LT). */
(function () {
  const LT = {};

  // ---- tiny DOM builder ----
  LT.h = function (tag, attrs) {
    const el = document.createElement(tag);
    const children = Array.prototype.slice.call(arguments, 2);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.indexOf('on') === 0 && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'value') el.value = v;
        else if (k === 'checked') el.checked = !!v;
        else if (k === 'html') el.innerHTML = v;
        else el.setAttribute(k, v === true ? '' : v);
      });
    }
    append(el, children);
    return el;
  };
  function append(el, children) {
    children.forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      if (Array.isArray(c)) return append(el, c);
      el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
    });
  }
  LT.clear = function (el) { while (el.firstChild) el.removeChild(el.firstChild); return el; };

  // ---- formatting ----
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  LT.date = function (iso) {
    if (!iso) return '—';
    const p = String(iso).slice(0, 10).split('-');
    return (+p[2]) + ' ' + MONTHS[+p[1] - 1] + ' ' + p[0];
  };
  LT.range = function (a, b) {
    if (!a) return '—';
    if (!b || a === b) return LT.date(a);
    const pa = a.split('-'), pb = b.split('-');
    if (pa[0] === pb[0] && pa[1] === pb[1]) return (+pa[2]) + '–' + LT.date(b);
    if (pa[0] === pb[0]) return (+pa[2]) + ' ' + MONTHS[+pa[1] - 1] + ' – ' + LT.date(b);
    return LT.date(a) + ' – ' + LT.date(b);
  };
  LT.n = function (x) {
    const v = Math.round((+x || 0) * 100) / 100;
    return (Object.is(v, -0) ? 0 : v).toLocaleString('en-US', { maximumFractionDigits: 2 });
  };
  LT.days = function (d) {
    const v = Math.round((+d || 0) * 100) / 100;
    return LT.n(v) + (Math.abs(v) === 1 ? ' day' : ' days');
  };
  LT.hours = function (h) { return LT.n(h) + ' h'; };
  LT.signed = function (d) { const v = +d || 0; return (v > 0 ? '+' : '') + LT.n(v); };
  LT.signedDays = function (d) { const v = +d || 0; return (v > 0 ? '+' : '') + LT.days(v); };
  LT.ago = function (iso) {
    if (!iso) return 'never';
    const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return LT.date(iso.slice(0, 10));
  };
  LT.time = function (isoTs, offsetMinutes) {
    const d = new Date(Date.parse(isoTs) + (offsetMinutes || 180) * 60000);
    return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
  };

  // ---- host / API ----
  LT.connect = async function () {
    LT.host = await YTApp.register();
    return LT.host;
  };
  function errorText(e) {
    if (!e) return 'Request failed';
    const d = e.data || e.body || e.response;
    if (d && d.error) return d.error;
    if (typeof d === 'string') { try { return JSON.parse(d).error || d; } catch (x) { return d; } }
    return e.message || String(e);
  }
  LT.api = async function (path, opts) {
    let res;
    try {
      res = await LT.host.fetchApp('api/' + path, opts || {});
    } catch (e) {
      throw new Error(errorText(e));
    }
    if (res && res.ok === false && res.error) throw new Error(res.error);
    return res;
  };
  LT.get = function (path, query) { return LT.api(path, query ? { query: query } : {}); };
  LT.post = function (path, body) { return LT.api(path, { method: 'POST', body: body || {} }); };

  // ---- toast ----
  let toastTimer = null;
  LT.toast = function (msg, isError) {
    let el = document.getElementById('lt-toast');
    if (!el) { el = LT.h('div', { id: 'lt-toast' }); document.body.appendChild(el); }
    el.className = 'toast' + (isError ? ' error' : '');
    el.textContent = msg;
    el.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.style.display = 'none'; }, isError ? 6000 : 2500);
  };

  // ---- theme (auto / light / dark, remembered per browser) ----
  const THEME_KEY = 'lt-theme';
  function systemDark() { return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches; }
  async function readTheme() {
    try { if (LT.host && LT.host.storage) return (await LT.host.storage.getItem(THEME_KEY)) || 'auto'; } catch (e) { /* ignore */ }
    try { return window.localStorage.getItem(THEME_KEY) || 'auto'; } catch (e) { return 'auto'; }
  }
  async function writeTheme(v) {
    try { if (LT.host && LT.host.storage) { await LT.host.storage.setItem(THEME_KEY, v); return; } } catch (e) { /* ignore */ }
    try { window.localStorage.setItem(THEME_KEY, v); } catch (e) { /* ignore */ }
  }
  function applyTheme(v) {
    const dark = v === 'dark' || (v === 'auto' && systemDark());
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  }
  LT.initTheme = async function () {
    LT.theme = await readTheme();
    applyTheme(LT.theme);
    if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () { applyTheme(LT.theme); });
  };
  LT.themeToggle = function () {
    const labels = { auto: 'Theme: auto', light: 'Theme: light', dark: 'Theme: dark' };
    const order = ['auto', 'light', 'dark'];
    const btn = LT.h('button', { class: 'link theme-toggle', title: 'Switch colour theme' }, labels[LT.theme || 'auto']);
    btn.addEventListener('click', function () {
      LT.theme = order[(order.indexOf(LT.theme) + 1) % order.length];
      applyTheme(LT.theme);
      writeTheme(LT.theme);
      btn.textContent = labels[LT.theme];
    });
    return btn;
  };

  window.LT = LT;
})();
