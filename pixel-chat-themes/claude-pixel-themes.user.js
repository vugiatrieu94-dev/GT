// ==UserScript==
// @name         Pixel Chat Themes + Bảo Lộc
// @name:vi      Pixel Chat Themes – hình nền pixel cho claude.ai
// @namespace    https://github.com/aqua2409z/pixel-chat-themes
// @version      2.1.0-baoloc.1
// @description  Animated pixel/ASCII wallpapers behind the claude.ai chat. Type /theme to pick one.
// @description:vi Hình nền pixel/ASCII chuyển động phía sau khung chat claude.ai. Gõ /theme để chọn.
// @author       aqua2409z
// @license      MIT
// @homepageURL  https://github.com/aqua2409z/pixel-chat-themes
// @supportURL   https://github.com/aqua2409z/pixel-chat-themes/issues
// @match        https://claude.ai/*
// @grant        none
// @run-at       document-idle
// @inject-into  content
// @noframes
// ==/UserScript==

/*
 * How it works
 *  1. A full-screen <canvas> sits behind the page (z-index -1) and draws a scene
 *     as a grid of small tiles, each holding one ASCII glyph – the "pixel" look.
 *  2. A scanner finds the page's opaque backgrounds: large ones become
 *     transparent, smaller panels (sidebar, composer, bubbles, menus) become
 *     frosted glass. It only looks at computed styles, not class names, so it
 *     keeps working when claude.ai changes its markup.
 *  3. Typing /theme in the chat box (or the floating button, or Alt+T) opens a
 *     picker. Settings are kept in localStorage.
 *
 * No innerHTML and no inline <style> (CSSOM only), so it also works on pages
 * with a strict Content-Security-Policy / Trusted Types.
 */
(function () {
  'use strict';
  // A clear line in the console, so a run from DevTools shows it worked.
  const say = (text) => console.info('%c' + text, 'color:#2f8a58;font-weight:bold');
  if (window.__pixelThemes) {
    say('Pixel Themes đang chạy rồi. Bấm Alt+T (hoặc nút ô vuông màu ở cạnh phải) để chọn theme.');
    return;
  }

  /* ------------------------------------------------------------------ utils */

  const rnd = (a, b) => a + Math.random() * (b - a);
  const rint = (a, b) => Math.floor(rnd(a, b + 1));
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

  // Stable pseudo-random number in [0, 1) for integer coordinates.
  function hash(x, y, s) {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1274126177);
    h = Math.imul(h ^ (h >>> 13), 1103515245);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  function rgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function vgrad(c, w, h, stops) {
    const g = c.createLinearGradient(0, 0, 0, h);
    stops.forEach((s, i) => g.addColorStop(i / (stops.length - 1), s));
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
  }

  function rglow(c, x, y, r, hex, a) {
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgba(hex, a));
    g.addColorStop(1, rgba(hex, 0));
    c.fillStyle = g;
    c.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // A sprite is ASCII art: every non-space char is a key into a palette of
  // [tileColor, glyphColor, fixedGlyph?, alpha?].
  function sprite(rows, pal) {
    const w = Math.max(...rows.map((r) => r.length));
    return { rows: rows.map((r) => r.padEnd(w)), w, h: rows.length, pal };
  }

  const strip = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').toLowerCase().trim();

  /* ------------------------------------------------------------------ world */

  const FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

  class World {
    constructor(canvas) {
      this.cv = canvas;
      this.ctx = canvas.getContext('2d');
      this.tiles = new Map();
      this.glows = new Map();
      this.s = {};
      this.t = 0;
      this.veil = 0;
      this.veilColor = '#ffffff';
    }

    resize(w, h, cell, dpr) {
      this.w = w;
      this.h = h;
      this.cell = cell;
      this.dpr = dpr;
      this.cv.width = Math.max(1, Math.round(w * dpr));
      this.cv.height = Math.max(1, Math.round(h * dpr));
      this.cols = Math.ceil(w / cell);
      this.rows = Math.ceil(h / cell);
      this.glyphsOn = cell >= 8;
      this.tiles.clear();
      this.under = this.over = null;
    }

    setTheme(th) {
      this.th = th;
      this.s = {};
      this.t = 0;
      this.tiles.clear();
      this.under = this.over = null;
      th.init(this);
    }

    // Static parts of a scene are drawn once into an offscreen layer.
    layer(fn) {
      const c = document.createElement('canvas');
      c.width = this.cv.width;
      c.height = this.cv.height;
      const x = c.getContext('2d');
      x.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      const prev = this.ctx;
      this.ctx = x;
      try {
        fn(x);
      } finally {
        this.ctx = prev;
      }
      return c;
    }

    draw(dt) {
      const th = this.th;
      const ctx = this.ctx;
      if (!th) return;
      this.t += dt;
      if (!this.under) {
        this.under = this.layer((c) => {
          th.bg(c, this.w, this.h, this);
          if (th.under) th.under(this);
        });
      }
      if (th.over && !this.over) this.over = this.layer(() => th.over(this));

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(this.under, 0, 0);
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      th.frame(this, dt);
      if (this.over) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(this.over, 0, 0);
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      }
      if (this.veil > 0) {
        ctx.globalAlpha = this.veil;
        ctx.fillStyle = this.veilColor;
        ctx.fillRect(0, 0, this.w, this.h);
        ctx.globalAlpha = 1;
      }
    }

    // One tile = rounded square + glyph, rendered once and reused.
    img(bg, fg, ch) {
      const key = bg + '|' + fg + '|' + ch;
      let c = this.tiles.get(key);
      if (c) return c;
      if (this.tiles.size > 900) this.tiles.clear();
      const s = this.cell;
      const px = Math.max(1, Math.ceil(s * this.dpr));
      c = document.createElement('canvas');
      c.width = c.height = px;
      const x = c.getContext('2d');
      x.scale(px / s, px / s);
      if (bg) {
        const gap = s > 6 ? Math.max(1, s * 0.09) : 0.5;
        const r = s > 6 ? s * 0.16 : 0;
        x.fillStyle = bg;
        if (r && x.roundRect) {
          x.beginPath();
          x.roundRect(gap / 2, gap / 2, s - gap, s - gap, r);
          x.fill();
        } else {
          x.fillRect(gap / 2, gap / 2, s - gap, s - gap);
        }
      }
      if (ch && fg && this.glyphsOn) {
        x.fillStyle = fg;
        x.font = `600 ${Math.round(s * 0.7)}px ${FONT}`;
        x.textAlign = 'center';
        x.textBaseline = 'middle';
        x.fillText(ch, s / 2, s / 2 + s * 0.05);
      } else if (ch && fg && !bg) {
        const d = Math.max(1, s * 0.4);
        x.fillStyle = fg;
        x.fillRect((s - d) / 2, (s - d) / 2, d, d);
      }
      this.tiles.set(key, c);
      return c;
    }

    tile(x, y, bg, fg, ch, a = 1) {
      x = Math.round(x);
      y = Math.round(y);
      if (a <= 0.01 || x < 0 || y < 0 || x >= this.cols || y >= this.rows) return;
      const ctx = this.ctx;
      ctx.globalAlpha = a > 1 ? 1 : a;
      ctx.drawImage(this.img(bg, fg, ch), x * this.cell, y * this.cell, this.cell, this.cell);
      ctx.globalAlpha = 1;
    }

    glyph(x, y, ch, fg, a) {
      this.tile(x, y, null, fg, ch, a);
    }

    ch(i, j, seed) {
      const g = this.th.glyphs;
      return g[(hash(i, j, seed) * g.length) | 0];
    }

    sprite(sp, x, y, o = {}) {
      const X = Math.round(x);
      const Y = Math.round(y);
      const pal = o.pal || sp.pal;
      const a = o.a == null ? 1 : o.a;
      const seed = o.seed || 0;
      for (let j = 0; j < sp.h; j++) {
        const row = sp.rows[j];
        for (let i = 0; i < sp.w; i++) {
          const p = pal[row[i]];
          if (!p) continue;
          const gx = X + (o.flip ? sp.w - 1 - i : i);
          this.tile(gx, Y + j, p[0], p[1], p[2] != null ? p[2] : this.ch(i, j, seed), a * (p[3] == null ? 1 : p[3]));
        }
      }
    }

    glow(x, y, r, hex, a) {
      if (a <= 0.01) return;
      let g = this.glows.get(hex);
      if (!g) {
        g = document.createElement('canvas');
        g.width = g.height = 64;
        rglow(g.getContext('2d'), 32, 32, 32, hex, 1);
        this.glows.set(hex, g);
      }
      const c = this.cell;
      const R = r * c;
      this.ctx.globalAlpha = clamp(a, 0, 1);
      this.ctx.drawImage(g, (x + 0.5) * c - R, (y + 0.5) * c - R, R * 2, R * 2);
      this.ctx.globalAlpha = 1;
    }

    dot(x, y, color, a, size = 0.3) {
      if (a <= 0.01) return;
      const c = this.cell;
      const d = Math.max(1, c * size);
      this.ctx.globalAlpha = clamp(a, 0, 1);
      this.ctx.fillStyle = color;
      this.ctx.fillRect(Math.round(x) * c + (c - d) / 2, Math.round(y) * c + (c - d) / 2, d, d);
      this.ctx.globalAlpha = 1;
    }
  }

  /* ---------------------------------------------------------------- sprites */

  const CLOUD_DAY = { c: ['#ffffff', '#a9c1d6'], e: ['#eef6fd', '#c3d5e5'] };

  // Flat-bottomed cloud made of a few overlapping ellipses.
  function cloudRows(w, h) {
    const E = [{ x: w / 2, y: h - h * 0.32, rx: w / 2, ry: h * 0.34 }];
    for (let k = rint(2, 4); k > 0; k--) {
      const rx = rnd(w * 0.16, w * 0.3);
      E.push({ x: rnd(rx * 0.9, w - rx * 0.9), y: h - h * 0.4 - rnd(0, h * 0.2), rx, ry: Math.min(rx * 0.8, h * 0.6) });
    }
    const inside = (i, j) => E.some((e) => ((i + 0.5 - e.x) / e.rx) ** 2 + ((j + 0.5 - e.y) / e.ry) ** 2 <= 1);
    const rows = [];
    for (let j = 0; j < h; j++) {
      let r = '';
      for (let i = 0; i < w; i++) {
        if (!inside(i, j)) r += ' ';
        else r += !inside(i - 1, j) || !inside(i + 1, j) || !inside(i, j - 1) || !inside(i, j + 1) ? 'e' : 'c';
      }
      rows.push(r);
    }
    return rows;
  }

  function cloud(w, anywhere, pal) {
    const z = Math.random();
    const cw = Math.round(clamp(w.cols * 0.12, 7, 16) + z * clamp(w.cols * 0.14, 4, 16));
    const ch = Math.max(3, Math.round(cw * rnd(0.3, 0.42)));
    return {
      sp: sprite(cloudRows(cw, ch), pal),
      z,
      x: anywhere ? rnd(-cw, w.cols) : -cw - rnd(0, w.cols * 0.3),
      y: rnd(-1, w.rows * 0.85 - ch),
      v: 0.35 + z * 1.2,
      a: 0.55 + z * 0.45,
      seed: rint(1, 1e6),
    };
  }

  /* ----------------------------------------------------------------- themes */

  const THEMES = [];

  // Vietnam's flag: 2:3, red field, a yellow five-pointed star in the middle
  // whose centre-to-tip radius is 1/5 of the flag's length, one point up.
  const FLAG_RED = [
    ['#9e1712', '#7f120e'],
    ['#b31b15', '#921611'],
    ['#c72019', '#a51a14'],
    ['#da251d', '#b51f18'],
    ['#e8382c', '#c52c22'],
    ['#f2503f', '#d23e31'],
    ['#fa6a55', '#dc5545'],
  ];
  const FLAG_YELLOW = [
    ['#c7b000', '#9c8900'],
    ['#dac400', '#ac9800'],
    ['#ecd800', '#bda800'],
    ['#ffea00', '#cfb800'],
    ['#fff23d', '#dcc81a'],
    ['#fff76b', '#e4d244'],
    ['#fffa99', '#ebdc6e'],
  ];

  function inStar(x, y, cx, cy, R) {
    const r = R * 0.381966;
    let inside = false;
    for (let k = 0, j = 9; k < 10; j = k++) {
      const ak = -Math.PI / 2 + (k * Math.PI) / 5;
      const aj = -Math.PI / 2 + (j * Math.PI) / 5;
      const rk = k % 2 ? r : R;
      const rj = j % 2 ? r : R;
      const xk = cx + Math.cos(ak) * rk;
      const yk = cy + Math.sin(ak) * rk;
      const xj = cx + Math.cos(aj) * rj;
      const yj = cy + Math.sin(aj) * rj;
      if (yk > y !== yj > y && x < ((xj - xk) * (y - yk)) / (yj - yk) + xk) inside = !inside;
    }
    return inside;
  }

  function flagGeo(w) {
    const horizon = Math.round(w.rows * 0.8);
    const top = Math.max(2, Math.round(w.rows * 0.12));
    // Phones get a bigger share of the width so the star stays readable.
    const narrow = w.cols < 60;
    const L = Math.round(clamp(Math.min(w.cols * (narrow ? 0.55 : 0.34), ((horizon - top - 3) * 3) / 2), 9, 48));
    const H = Math.round((L * 2) / 3);
    const px = Math.round(clamp(narrow ? w.cols - L - 3 : w.cols * 0.62, 2, w.cols - L - 2));
    return { horizon, top, L, H, px };
  }

  // Limestone karst towers (Ha Long style): steep sides, rounded tops.
  function karstHeights(cols, peaks) {
    const hs = new Array(cols).fill(0);
    for (const p of peaks) {
      for (let x = Math.floor(p.x - p.w * 1.3); x <= Math.ceil(p.x + p.w * 1.3); x++) {
        if (x < 0 || x >= cols) continue;
        // Lean: the left and right flanks fall at different rates.
        const dx = x + 0.5 - p.x;
        const d = Math.abs(dx) / (p.w * (dx < 0 ? 1 + p.lean : 1 - p.lean));
        if (d >= 1) continue;
        // Steep flanks, a broad rounded crown.
        hs[x] = Math.max(hs[x], Math.round(p.h * Math.pow(1 - Math.pow(d, 2.6), 0.55)));
      }
    }
    return hs;
  }

  THEMES.push({
    id: 'vn',
    name: 'Việt Nam',
    dark: false,
    veilScale: 0.5,
    alias: ['co', 'co do', 'co viet nam', 'co do sao vang', 'viet nam', 'vietnam', 'quoc ky', 'to quoc', 'flag'],
    glyphs: ':.;',
    bg(c, w, h, W) {
      const g = flagGeo(W);
      const hy = g.horizon * W.cell;
      const sky = c.createLinearGradient(0, 0, 0, hy);
      sky.addColorStop(0, '#4f9fe0');
      sky.addColorStop(0.55, '#9fd2f2');
      sky.addColorStop(1, '#ffe0b0');
      c.fillStyle = sky;
      c.fillRect(0, 0, w, hy);
      const sea = c.createLinearGradient(0, hy, 0, h);
      sea.addColorStop(0, '#6fb7cc');
      sea.addColorStop(1, '#2c7896');
      c.fillStyle = sea;
      c.fillRect(0, hy, w, h - hy);
      rglow(c, w * 0.82, hy, Math.max(w, h) * 0.45, '#ffd27a', 0.55);
    },
    init(w) {
      const s = w.s;
      const g = flagGeo(w);
      s.mask = [];
      for (let j = 0; j < g.H; j++) {
        const row = [];
        for (let i = 0; i < g.L; i++) {
          // Area coverage (6x6 samples per cell) keeps the thin star points from breaking up.
          let n = 0;
          for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) if (inStar(i + (a + 0.5) / 6, j + (b + 0.5) / 6, g.L / 2, g.H / 2, g.L / 5)) n++;
          row.push(n / 36 >= 0.22);
        }
        s.mask.push(row);
      }
      const cluster = (n, wMin, wMax, hMax) => {
        const out = [];
        for (let c = 0; c < n; c++) {
          const x = rnd(0, w.cols);
          const h = rnd(hMax * 0.55, hMax);
          const wd = rnd(wMin, wMax);
          out.push({ x, w: wd, h, lean: rnd(-0.25, 0.25) });
          if (Math.random() < 0.7) out.push({ x: x + wd * rnd(0.8, 1.3) * (Math.random() < 0.5 ? -1 : 1), w: wd * 0.7, h: h * rnd(0.45, 0.7), lean: rnd(-0.25, 0.25) });
        }
        return out;
      };
      s.far = cluster(Math.round(clamp(w.cols / 14, 2, 8)), 3, 6, Math.max(4, w.rows * 0.16));
      s.near = cluster(Math.round(clamp(w.cols / 22, 1, 5)), 3.5, 7, Math.max(5, w.rows * 0.24));
      s.clouds = Array.from({ length: Math.round(clamp(w.cols / 30, 2, 5)) }, () => {
        const c = cloud(w, true, CLOUD_DAY);
        c.y = rnd(-1, g.horizon * 0.45);
        c.v *= 0.5;
        return c;
      });
      s.birds = Array.from({ length: Math.round(clamp(w.cols / 14, 3, 9)) }, () => ({ x: rnd(0, w.cols), y: rnd(2, g.horizon * 0.5), v: rnd(0.8, 1.8), ph: rnd(0, 6) }));
      s.dust = Array.from({ length: Math.round(clamp(w.cols / 4, 6, 30)) }, () => ({ x: rnd(w.cols * 0.55, w.cols), y: rnd(0, g.horizon), ph: rnd(0, 6), v: rnd(0.1, 0.4) }));
    },
    under(w) {
      const s = w.s;
      const g = flagGeo(w);
      // Rising sun, half behind the mountains.
      const sx = Math.round(w.cols * 0.82);
      const sr = clamp(Math.round(w.rows * 0.07), 2, 5);
      for (let dy = -sr; dy <= 0; dy++) {
        for (let dx = -sr; dx <= sr; dx++) {
          if (Math.hypot(dx, dy) <= sr + 0.3) w.tile(sx + dx, g.horizon - 1 + dy, '#fff0b8', '#f5d27a', w.ch(dx, dy, 31));
        }
      }
      const far = karstHeights(w.cols, s.far);
      const near = karstHeights(w.cols, s.near);
      // Far towers fade into the morning haze; near ones are darker with green crowns.
      for (let x = 0; x < w.cols; x++) {
        for (let k = 0; k < far[x]; k++) w.tile(x, g.horizon - 1 - k, '#a9c4cf', '#97b5c2', w.ch(x, k, 32), 0.8);
      }
      for (let x = 0; x < w.cols; x++) {
        const hgt = near[x];
        for (let k = 0; k < hgt; k++) {
          const crown = k >= hgt - 2 && hgt > 2;
          w.tile(x, g.horizon - 1 - k, crown ? '#6f9e7c' : '#5b8b92', crown ? '#557f62' : '#46737a', w.ch(x, k, 33));
        }
      }
      // Reflections of the near towers on the water.
      for (let x = 0; x < w.cols; x++) {
        for (let k = 0; k < Math.min(near[x], w.rows - g.horizon) * 0.5; k++) w.tile(x, g.horizon + k, '#3f7f8f', null, '', 0.35 - k * 0.06);
      }
    },
    frame(w, dt) {
      const s = w.s;
      const g = flagGeo(w);
      const t = w.t;

      for (const c of s.clouds) {
        c.x += c.v * dt;
        if (c.x > w.cols + 1) c.x = -c.sp.w - rnd(0, 10);
        w.sprite(c.sp, c.x, c.y, { a: c.a * 0.9, seed: c.seed });
      }
      for (const d of s.dust) w.dot(d.x + Math.sin(t * 0.6 + d.ph), d.y - ((t * d.v) % g.horizon), '#fff4c8', 0.25 + 0.25 * Math.sin(t * 2 + d.ph), 0.22);
      for (const b of s.birds) {
        b.x -= b.v * dt;
        if (b.x < -2) {
          b.x = w.cols + rnd(1, 10);
          b.y = rnd(2, g.horizon * 0.5);
        }
        w.glyph(b.x, b.y + Math.sin(t * 1.3 + b.ph) * 0.6, Math.floor(t * 4 + b.ph) % 2 ? 'v' : '-', '#33475b', 0.85);
      }

      // Water: drifting ripples and the sun's glittering path.
      const tick = Math.floor(t * 4);
      const sx = Math.round(w.cols * 0.82);
      for (let y = g.horizon; y < w.rows; y++) {
        const d = y - g.horizon;
        const dir = y % 2 ? 1 : -1;
        for (let x = 0; x < w.cols; x++) {
          if (hash(Math.floor(x + t * 0.8 * dir), y, 41) < 0.08) w.glyph(x, y, '~', '#e6f6fb', 0.55);
        }
        const spread = 1 + d * 0.8;
        for (let x = Math.floor(sx - spread); x <= sx + spread; x++) {
          if (hash(x, y, tick) < 0.3) w.tile(x, y, '#fff0b8', '#f0d27a', '~', 0.65 - d * 0.03);
        }
      }

      // Flagpole with a gold finial and a stone base.
      for (let y = g.top - 1; y <= g.horizon + 1; y++) w.tile(g.px, y, '#ece6d8', '#bdb5a3', '|');
      w.tile(g.px, g.top - 2, '#ffd34d', '#c99a1c', 'o');
      for (let dx = -1; dx <= 1; dx++) w.tile(g.px + dx, g.horizon + 2, '#8d99a6', '#6d7884', '=');

      // The flag: each column rides a sine wave that grows from the pole to the
      // free end, snapped to whole cells; the slope picks one of seven shades.
      const A = Math.max(1, g.H * 0.14);
      const k = (Math.PI * 2.2) / g.L;
      for (let i = 0; i < g.L; i++) {
        const f = Math.pow((i + 1) / g.L, 0.8);
        const ph = i * k - t * 3.4;
        const dy = Math.round((Math.sin(ph) + 0.18 * Math.sin(ph * 2.1 + 1)) * A * f);
        const shade = clamp(Math.round(Math.cos(ph) * (0.6 + f) * 2), -3, 3) + 3;
        const x = g.px + 1 + i;
        for (let j = 0; j < g.H; j++) {
          const star = s.mask[j] && s.mask[j][i];
          const p = (star ? FLAG_YELLOW : FLAG_RED)[shade];
          w.tile(x, g.top + j + dy, p[0], p[1], star ? '*' : w.ch(i, j, 34));
        }
      }
    },
  });


  /* --- Bảo Lộc (Lâm Đồng): đồi chè, rừng thông, sương sớm, thác Đambri, hoa dã quỳ --- */

  // Smooth ridge line: top row of a hill for every column.
  function blRidge(cols, base, amp, bumps) {
    const f = (Math.PI * 2 * bumps) / Math.max(12, cols);
    const p1 = rnd(0, 6.28);
    const p2 = rnd(0, 6.28);
    const p3 = rnd(0, 6.28);
    const out = new Array(cols);
    for (let x = 0; x < cols; x++) {
      const v = 0.58 * Math.sin(x * f + p1) + 0.28 * Math.sin(x * f * 2.3 + p2) + 0.14 * Math.sin(x * f * 5.1 + p3);
      out[x] = Math.round(base - amp * v);
    }
    return out;
  }

  // Pine: stacked tiers that widen downward, with a short trunk.
  function blPine(w, x, baseY, hgt, leaf, leafDk, trunk, seed, a = 1) {
    const tier = Math.max(2, Math.round(hgt / 3.2));
    const crown = Math.max(2, Math.round(hgt * (trunk ? 0.84 : 1)));
    for (let k = 0; k < crown; k++) {
      const y = baseY - hgt + k;
      const maxHalf = Math.max(1, Math.round(hgt * 0.26));
      const half = Math.round(maxHalf * ((k + 1) / crown) * (0.4 + 0.6 * ((k % tier) + 1) / tier));
      for (let dx = -half; dx <= half; dx++) {
        const edge = dx === -half || dx === half;
        w.tile(x + dx, y, edge ? leafDk : leaf, leafDk, k === 0 ? '^' : w.ch(dx, k, seed), a);
      }
    }
    if (trunk) for (let y = baseY - hgt + crown; y < baseY; y++) w.tile(x, y, trunk, '#3a2414', '|', a);
  }

  // Tea palettes: [bush lit, bush shade, glyph, path(soil), top edge]
  const BL_TEA = [
    { lit: '#9cc58a', sh: '#86b37c', fg: '#6f9c66', path: '#c9b48c', top: '#b4d49a' },
    { lit: '#5fae4a', sh: '#4c9a40', fg: '#3b7d32', path: '#b0784a', top: '#7cc25e' },
    { lit: '#3f9538', sh: '#32802f', fg: '#256524', path: '#97603a', top: '#5aae46' },
  ];

  THEMES.push({
    id: 'baoloc',
    name: 'Bảo Lộc',
    dark: false,
    veilScale: 0.55,
    alias: ['bao loc', 'baoloc', 'lam dong', 'lamdong', 'doi che', 'che', 'tra', 'tea', 'da quy', 'daquy', 'thong', 'rung thong', 'dambri', 'thac', 'cao nguyen', 'tay nguyen'],
    glyphs: ':.;',
    bg(c, w, h) {
      const sky = c.createLinearGradient(0, 0, 0, h * 0.72);
      sky.addColorStop(0, '#78b2e4');
      sky.addColorStop(0.5, '#bfe0f2');
      sky.addColorStop(1, '#fde7c2');
      c.fillStyle = sky;
      c.fillRect(0, 0, w, h);
      rglow(c, w * 0.78, h * 0.3, Math.max(w, h) * 0.5, '#ffe3a1', 0.6);
    },
    init(w) {
      const s = w.s;
      const C = w.cols;
      const R = w.rows;
      s.far1 = blRidge(C, R * 0.42, R * 0.09, 2.2);
      s.far2 = blRidge(C, R * 0.5, R * 0.065, 3);
      s.pine = blRidge(C, R * 0.58, R * 0.035, 2.5);
      s.hillA = blRidge(C, R * 0.66, R * 0.045, 1.6);
      s.hillB = blRidge(C, R * 0.77, R * 0.055, 1.3);
      s.front = blRidge(C, R * 0.88, R * 0.05, 1.1);
      for (let x = 0; x < C; x++) {
        // Keep the layers in order so every one stays visible.
        s.far2[x] = Math.max(s.far2[x], s.far1[x] + 2);
        s.pine[x] = Math.max(s.pine[x], s.far2[x] + 2);
        s.hillA[x] = Math.max(s.hillA[x], s.pine[x] + 2);
        s.hillB[x] = Math.max(s.hillB[x], s.hillA[x] + 2);
        s.front[x] = Math.min(R - 1, Math.max(s.front[x], s.hillB[x] + 2));
      }

      // Đambri-like waterfall dropping off the pine ridge on the left.
      const ww = Math.round(clamp(C * 0.03, 2, 4));
      const xw = Math.round(clamp(C * 0.14, 2, C - ww - 3));
      const top = Math.min(...s.pine.slice(xw - 1, xw + ww + 1)) - 1;
      const end = Math.min(...s.hillB.slice(xw - 1, xw + ww + 1)) - 1;
      s.fall = end - top >= 3 ? { x: xw, w: ww, top, end } : null;

      const density = cfg.density || 1;
      s.clouds = Array.from({ length: Math.round(clamp(C / 32, 1, 4)) }, () => {
        const c = cloud(w, true, CLOUD_DAY);
        c.y = rnd(-1, R * 0.18);
        c.v *= 0.45;
        return c;
      });
      s.birds = Array.from({ length: Math.round(clamp(C / 18, 2, 7)) }, () => ({ x: rnd(0, C), y: rnd(2, R * 0.3), v: rnd(0.8, 1.6), ph: rnd(0, 6) }));

      // Morning mist drifting in the valleys between the layers.
      const bands = [s.far2, s.pine, s.hillA, s.hillB];
      const avg = (a) => a.reduce((p, v) => p + v, 0) / a.length;
      s.mist = Array.from({ length: Math.round(clamp(C / 10, 4, 14) * density) }, (_, i) => {
        const b = bands[i % bands.length];
        return { x: rnd(-10, C), y: Math.round(avg(b) + rnd(-1.5, 1)), len: rint(Math.round(clamp(C * 0.1, 5, 12)), Math.round(clamp(C * 0.25, 8, 30))), v: rnd(0.25, 0.7), a: rnd(0.28, 0.5), ph: rnd(0, 6) };
      });

      // Dã quỳ (wild sunflowers) along the front slope and on the near tea hill.
      s.quy = [];
      for (let x = 0; x < C; x++) {
        if (hash(x, 1, 91) < 0.42 * Math.min(1.6, density)) s.quy.push({ x, base: s.front[x], h: rint(1, 3), ph: rnd(0, 6) });
        if (hash(x, 2, 92) < 0.08 * density) s.quy.push({ x, base: s.hillB[x], h: rint(1, 2), ph: rnd(0, 6), far: true });
      }
      s.petals = Array.from({ length: Math.round(clamp(C / 6, 4, 22) * density) }, () => ({ x: rnd(0, C), y: rnd(R * 0.4, R), v: rnd(0.6, 1.6), ph: rnd(0, 6) }));

      // Tea pickers in nón lá walking slowly between the rows.
      s.pickers = Array.from({ length: C < 50 ? 1 : 3 }, (_, i) => ({ x: rnd(C * 0.3, C * 0.9), v: rnd(0.12, 0.28) * (i % 2 ? 1 : -1), shirt: ['#3d6ea8', '#c0473a', '#e2a23b'][i % 3] }));
    },
    under(w) {
      const s = w.s;
      const C = w.cols;
      const R = w.rows;

      // Soft morning sun.
      const sx = Math.round(C * 0.78);
      const sy = Math.round(R * 0.3);
      const sr = clamp(Math.round(R * 0.045), 1, 4);
      for (let dy = -sr; dy <= sr; dy++) for (let dx = -sr; dx <= sr; dx++) if (Math.hypot(dx, dy) <= sr + 0.3) w.tile(sx + dx, sy + dy, '#fff3c4', '#f6d78a', w.ch(dx, dy, 71), 0.9);

      // Far blue ranges of the Lâm Đồng plateau.
      for (let x = 0; x < C; x++) {
        for (let y = s.far1[x]; y < R; y++) w.tile(x, y, '#a9c0d6', '#97b0c8', w.ch(x, y, 72), 0.85);
        for (let y = s.far2[x]; y < R; y++) w.tile(x, y, '#8fb0c2', '#7c9db0', w.ch(x, y, 73), 0.9);
      }
      // Pine ridge with a row of small pines on top.
      for (let x = 0; x < C; x++) for (let y = s.pine[x]; y < R; y++) w.tile(x, y, '#5f8d7e', '#507d6f', w.ch(x, y, 74));
      for (let x = 1; x < C - 1; x++) if (hash(x, 3, 75) < 0.33) blPine(w, x, s.pine[x] + 1, rint(2, 4), '#4f7d6c', '#426d5d', null, 75);

      const tea = (arr, pal, seed) => {
        for (let x = 0; x < C; x++) {
          const top = arr[x];
          const lit = (arr[Math.min(C - 1, x + 1)] || top) - (arr[Math.max(0, x - 1)] || top) >= 0;
          for (let y = top; y < R; y++) {
            const d = y - top;
            if (d === 0) w.tile(x, y, pal.top, pal.fg, w.ch(x, y, seed));
            else if (d % 4 === 0) w.tile(x, y, pal.path, pal.fg, '.');
            else w.tile(x, y, lit ? pal.lit : pal.sh, pal.fg, hash(x, y, seed) < 0.6 ? 'o' : w.ch(x, y, seed));
          }
        }
      };
      tea(s.hillA, BL_TEA[0], 76);
      for (let x = 0; x < C; x++) if (hash(x, 4, 77) < 0.1) blPine(w, x, s.hillA[x] + 1, rint(3, 5), '#3f6f4e', '#335f42', '#6a4a30', 77);

      // Rocky cliff around the waterfall.
      if (s.fall) {
        const f = s.fall;
        for (let y = f.top; y <= f.end; y++) {
          for (let x = f.x - 2; x <= f.x + f.w + 1; x++) w.tile(x, y, hash(x, y, 78) < 0.5 ? '#7a7466' : '#686356', '#57524a', w.ch(x, y, 78));
        }
        for (let x = f.x - 3; x <= f.x + f.w + 2; x++) w.tile(x, f.end + 1, '#9fd3e0', '#e9f7fb', '~');
      }

      tea(s.hillB, BL_TEA[1], 79);
      tea(s.front, BL_TEA[2], 80);

      // Tall foreground pines, the signature of the highlands.
      const big = Math.round(clamp(R * 0.42, 5, 22));
      blPine(w, Math.round(clamp(C * 0.04, 2, 6)), R, big, '#2f5d3a', '#244a2e', '#5a3a24', 81);
      if (C > 50) blPine(w, Math.round(C * 0.95), R, Math.round(big * 0.75), '#346540', '#28502f', '#5a3a24', 82);
    },
    frame(w, dt) {
      const s = w.s;
      const t = w.t;
      const C = w.cols;
      const sp = cfg.speed || 1;
      const m = w.mouse;

      for (const c of s.clouds) {
        c.x += c.v * dt * sp;
        if (c.x > C + 1) c.x = -c.sp.w - rnd(0, 10);
        w.sprite(c.sp, c.x, c.y, { a: c.a * 0.85, seed: c.seed });
      }
      for (const b of s.birds) {
        b.x -= b.v * dt * sp;
        if (b.x < -2) {
          b.x = C + rnd(1, 10);
          b.y = rnd(2, w.rows * 0.3);
        }
        w.glyph(b.x, b.y + Math.sin(t * 1.3 + b.ph) * 0.6, Math.floor(t * 4 + b.ph) % 2 ? 'v' : '-', '#33475b', 0.8);
      }

      // Waterfall: falling streaks scroll down, spray at the bottom.
      if (s.fall) {
        const f = s.fall;
        const tick = Math.floor(t * 9 * sp);
        for (let y = f.top; y <= f.end; y++) {
          for (let i = 0; i < f.w; i++) {
            const r = hash(f.x + i, y - tick, 83);
            w.tile(f.x + i, y, r < 0.3 ? '#ffffff' : '#d6edf5', '#8fc3d6', r < 0.5 ? '|' : '!', 0.95);
          }
        }
        for (let k = 0; k < 6; k++) {
          const ph = t * 2 + k * 1.7;
          w.dot(f.x + f.w / 2 + Math.sin(ph) * (f.w + 1), f.end + 0.5 - Math.abs(Math.cos(ph * 0.7)) * 2, '#ffffff', 0.6, 0.3);
        }
        w.glow(f.x + f.w / 2, f.end, 3 + f.w, '#ffffff', 0.35);
      }

      // Mist: soft bands that drift right; the pointer pushes them along.
      for (const p of s.mist) {
        p.x += p.v * dt * sp;
        if (m && m.active && Math.abs(m.y - p.y) < 3 && m.x > p.x - 2 && m.x < p.x + p.len + 2) p.x += clamp(m.vx, -6, 6) * dt * 2;
        if (p.x > C + 2) p.x = -p.len - rnd(0, 12);
        if (p.x < -p.len - 14) p.x = C;
        const breathe = 0.8 + 0.2 * Math.sin(t * 0.5 + p.ph);
        for (let i = 0; i < p.len; i++) {
          const e = 1 - Math.abs(i - p.len / 2) / (p.len / 2);
          w.tile(p.x + i, p.y, '#ffffff', null, '', p.a * e * breathe);
          if (e > 0.45) w.tile(p.x + i, p.y - 1, '#ffffff', null, '', p.a * (e - 0.45) * breathe);
        }
      }

      // Tea pickers.
      for (const p of s.pickers) {
        p.x += p.v * dt * sp;
        if (p.x < C * 0.22 || p.x > C * 0.92) p.v = -p.v;
        const x = Math.round(p.x);
        const y = s.hillB[clamp(x, 0, C - 1)] + 2 + (Math.floor(t * 2 + x) % 7 === 0 ? 1 : 0);
        w.tile(x, y, '#f1e2b0', '#b99a52', '^');
        w.tile(x, y + 1, p.shirt, '#00000033', '#');
      }

      // Dã quỳ swaying in the wind (stronger near the pointer).
      for (const q of s.quy) {
        let push = Math.sin(t * 1.4 * sp + q.ph + q.x * 0.15) * 0.7;
        if (m && m.active && Math.abs(m.x - q.x) < 5 && Math.abs(m.y - q.base) < 6) push += clamp(m.vx, -3, 3) * 0.6;
        const dx = Math.round(push);
        for (let k = 1; k <= q.h; k++) w.tile(q.x + (k === q.h ? dx : 0), q.base - k, null, '#4f8a2e', k === 1 && q.x % 3 === 0 ? '}' : '|');
        const hx = q.x + dx;
        const hy = q.base - q.h - 1;
        w.tile(hx, hy, q.far ? '#f5cf3a' : '#ffcc1a', '#d07a00', '*', q.far ? 0.85 : 1);
        if (!q.far && w.cols > 40) w.glow(hx, hy, 1.4, '#ffd23f', 0.18);
      }

      // Loose yellow petals carried by the breeze.
      for (const p of s.petals) {
        p.x += p.v * dt * sp;
        p.y += Math.sin(t + p.ph) * 0.02;
        if (p.x > C + 1) {
          p.x = -1;
          p.y = rnd(w.rows * 0.4, w.rows);
        }
        w.dot(p.x, p.y + Math.sin(t * 1.7 + p.ph) * 0.8, '#ffd23f', 0.75, 0.32);
      }
    },
  });

  /* --- Sakura Breeze (Kyoto Spring, Mt. Fuji & Torii) --- */
  const TORII_GATE = sprite(
    [
      '  mmmmmmmmmmmmmm  ',
      ' mMMMMMMMMMMMMMMm ',
      '   r   r    r   r ',
      '   rrrrrrrrrrrrrr ',
      '   R            R ',
      '   R            R ',
      '   R            R ',
      '   R            R ',
      '  bbb          bbb',
    ],
    {
      m: ['#7f1d1d', '#450a0a', '='],
      M: ['#dc2626', '#991b1b', '#'],
      r: ['#ef4444', '#b91c1c', '-'],
      R: ['#dc2626', '#991b1b', '|'],
      b: ['#475569', '#334155', 'b'],
    },
  );

  const SAKURA_BRANCH_BIG = sprite(
    [
      '                                              bbbbbbbbbbbbbb',
      '                                      bbbbbbbbb       bbbbbb',
      '                              kkkkkkbbb                 bbbb',
      '                     FffF       bbkkk   FffF                ',
      '             FffF   fpccpf   kkk    k  fpccpf    FffF       ',
      '            fpccpf   FffF   k      k    FffF    fpccpf      ',
      '        l    FffF         kk      k              FffF       ',
      '      FffF         FffF  k       k     FffF                 ',
      '     fpccpf   l   fpccpf        k     fpccpf    l    d      ',
      '      FffF         FffF                FffF          d      ',
      '                                                     L      ',
      '                                                    lGl     ',
      '                                                     L      ',
    ],
    {
      b: ['#3e2723', '#241411', '#'],
      k: ['#5d4037', '#3e2723', '='],
      f: ['#ffb7c5', '#ffffff', '*'],
      F: ['#f472b6', '#fff1f2', '+'],
      p: ['#fce7f3', '#f472b6', '°'],
      c: ['#e11d48', '#ffffff', 'o'],
      l: ['#86efac', '#15803d', ':'],
      d: ['#1e293b', null, '|'],
      L: ['#b91c1c', '#7f1d1d', '='],
      G: ['#fef08a', '#f59e0b', '*'],
    },
  );

  function fujiHeights(cols, fx, fw, fh) {
    const hs = new Array(cols).fill(0);
    const halfW = fw / 2;
    for (let x = Math.floor(fx - halfW); x <= Math.ceil(fx + halfW); x++) {
      if (x < 0 || x >= cols) continue;
      const u = Math.abs(x + 0.5 - fx) / halfW;
      if (u >= 1) continue;
      let h = fh * Math.pow(1 - Math.pow(u, 1.35), 1.75);
      if (u < 0.1) h *= 0.96;
      hs[x] = Math.round(h);
    }
    return hs;
  }

  function spawnSakuraPetal(w, randomY, fromBranch, isFar) {
    const C = w.cols;
    const R = w.rows;
    const bx = Math.max(0, C - SAKURA_BRANCH_BIG.w);
    const startX = fromBranch ? rnd(bx + 10, C) : rnd(-4, C + 4);
    const startY = fromBranch ? rnd(0, SAKURA_BRANCH_BIG.h) : randomY ? rnd(-5, R + 2) : rnd(-8, -1);
    const z = isFar ? rnd(0.4, 0.6) : rnd(0.8, 1.25);
    return {
      x: startX,
      y: startY,
      vx: rnd(0.8, 1.8) * z,
      vy: rnd(0.6, 1.5) * z,
      swayAmp: rnd(0.7, 2.2),
      swayFreq: rnd(1.2, 2.6),
      ph: rnd(0, Math.PI * 2),
      rot: rnd(0, 6.28),
      rotSpeed: rnd(-2.5, 2.5),
      ch: pick(['*', '+', '°', '.', 'o']),
      bg: isFar ? pick(['#fce7f3', '#fbcfe8', '#fda4af']) : pick(['#ffb7c5', '#fbcfe8', '#fda4af', '#fce7f3', '#f472b6']),
      fg: pick(['#ffffff', '#fff1f2', '#fce7f3']),
      a: isFar ? rnd(0.45, 0.7) : rnd(0.75, 0.98),
      z,
      isFar,
    };
  }

  THEMES.push({
    id: 'sakura',
    name: 'Sakura Breeze',
    dark: false,
    veilScale: 0.55,
    alias: ['sakura', 'hoa', 'anhdao', 'cherry', 'kyoto', 'japan', 'fuji', 'phu si', 'torii'],
    glyphs: '*+:.o~°',
    bg(c, w, h, W) {
      const hy = Math.round(W.rows * 0.76) * W.cell;
      // Spring morning sky with pastel twilight
      const sky = c.createLinearGradient(0, 0, 0, hy);
      sky.addColorStop(0, '#fce7f3');
      sky.addColorStop(0.4, '#fed7aa');
      sky.addColorStop(0.75, '#fef3c7');
      sky.addColorStop(1, '#ffedd5');
      c.fillStyle = sky;
      c.fillRect(0, 0, w, hy);

      // Lake reflection
      const lake = c.createLinearGradient(0, hy, 0, h);
      lake.addColorStop(0, '#fbcfe8');
      lake.addColorStop(0.2, '#93c5fd');
      lake.addColorStop(1, '#2563eb');
      c.fillStyle = lake;
      c.fillRect(0, hy, w, h - hy);

      // Rising Sun glow near Mt. Fuji
      rglow(c, w * 0.32, hy * 0.9, Math.max(w, h) * 0.45, '#fb7185', 0.45);
      // Soft warmth from cherry branch canopy
      rglow(c, w * 0.85, hy * 0.2, Math.max(w, h) * 0.5, '#f472b6', 0.28);
    },
    under(w) {
      const hy = Math.round(w.rows * 0.76);
      const fx = Math.round(w.cols * (w.cols < 60 ? 0.42 : 0.28));
      const fw = Math.round(clamp(w.cols * 0.52, 22, 54));
      const fh = Math.round(clamp(w.rows * 0.36, 10, 24));
      const fujiH = fujiHeights(w.cols, fx, fw, fh);

      // Draw Mt. Fuji
      for (let x = 0; x < w.cols; x++) {
        const h = fujiH[x];
        if (h <= 0) continue;
        for (let y = hy - h; y < hy; y++) {
          const elev = hy - y;
          const isSnow = elev > h * 0.62 || (elev > h * 0.46 && hash(x, y, 7) < 0.38);
          if (isSnow) {
            w.tile(x, y, '#ffffff', '#e2e8f0', '*', 0.96);
          } else {
            const dx = x - fx;
            if (dx < 0) w.tile(x, y, '#818cf8', '#c7d2fe', '/', 0.88);
            else w.tile(x, y, '#4338ca', '#312e81', '\\', 0.92);
          }
        }
        // Lake reflection of Mt. Fuji
        const refH = Math.min(Math.round(h * 0.45), w.rows - hy);
        for (let k = 0; k < refH; k++) {
          w.tile(x, hy + k, '#3b82f6', null, '', 0.28 - k * 0.05);
        }
      }

      // Torii Gate on water edge
      const tx = Math.round(clamp(w.cols * (w.cols < 60 ? 0.05 : 0.12), 1, Math.max(2, w.cols - TORII_GATE.w - 2)));
      const ty = hy - TORII_GATE.h + 2;
      w.sprite(TORII_GATE, tx, ty);

      // Lush Sakura Branch canopy at top-right
      const bx = Math.max(0, w.cols - SAKURA_BRANCH_BIG.w);
      w.sprite(SAKURA_BRANCH_BIG, bx, 0);

      if (w.cols > 50) {
        w.tile(bx - 3, 3, '#f472b6', '#ffffff', '*');
        w.tile(bx - 5, 4, '#ffb7c5', '#fff1f2', '+');
        w.tile(bx - 2, 5, '#e11d48', '#ffffff', 'o');
        w.tile(bx - 6, 2, '#86efac', '#15803d', ':');
      }

      // Fallen petals on the water shore
      for (let x = 0; x < w.cols; x += rint(3, 8)) {
        w.tile(x, w.rows - 1, '#fce7f3', '#f472b6', pick(['*', '+', '°']), 0.65);
      }
    },
    init(w) {
      const s = w.s;
      const count = Math.round(clamp((w.cols * w.rows) / 18, 35, 110) * (cfg.density || 1.0));
      s.petals = Array.from({ length: count }, (_, i) => spawnSakuraPetal(w, true, false, i % 3 === 0));
      s.gustTimer = rnd(4, 8);
      s.gustActive = false;
      s.gustDuration = 0;
      s.gustStrength = 0;
      s.birds = Array.from({ length: Math.round(clamp(w.cols / 18, 2, 6)) }, () => ({
        x: rnd(0, w.cols),
        y: rnd(2, w.rows * 0.35),
        v: rnd(1.0, 2.0),
        ph: rnd(0, 6),
      }));
    },
    frame(w, dt) {
      const s = w.s;
      const speedMul = cfg.speed || 1.0;
      const hy = Math.round(w.rows * 0.76);
      const t = w.t;

      // Hanging lantern subtle sway & warm glow
      const bx = Math.max(0, w.cols - SAKURA_BRANCH_BIG.w);
      const lx = bx + 52;
      const ly = 12;
      w.glow(lx, ly, 7, '#fef08a', 0.55 + 0.15 * Math.sin(t * 3));

      // Birds flying over Mt. Fuji
      for (const b of s.birds) {
        b.x -= b.v * dt * speedMul;
        if (b.x < -3) {
          b.x = w.cols + rnd(2, 10);
          b.y = rnd(2, hy * 0.45);
        }
        w.glyph(b.x, b.y + Math.sin(t * 1.6 + b.ph) * 0.5, Math.floor(t * 4 + b.ph) % 2 ? 'v' : '^', '#334155', 0.85);
      }

      // Wind gust logic
      s.gustTimer -= dt;
      if (s.gustTimer <= 0 && !s.gustActive) {
        s.gustActive = true;
        s.gustDuration = rnd(2.0, 3.2);
        s.gustStrength = rnd(2.8, 4.5);
        s.gustTimer = rnd(6, 12);
        const burst = rint(14, 24);
        for (let k = 0; k < burst; k++) {
          s.petals.push(spawnSakuraPetal(w, false, true, Math.random() < 0.3));
        }
      }

      let currentWind = 1;
      if (s.gustActive) {
        s.gustDuration -= dt;
        if (s.gustDuration <= 0) s.gustActive = false;
        else currentWind = 1 + s.gustStrength * Math.sin((s.gustDuration / 3.0) * Math.PI);
      }

      const totalSpeed = speedMul * currentWind;
      const mouse = w.mouse;
      const hasMouse = mouse && mouse.active;

      // Lake ripples
      for (let y = hy; y < w.rows; y++) {
        const dir = y % 2 ? 1 : -1;
        for (let x = 0; x < w.cols; x += 3) {
          if (hash(Math.floor(x + t * 0.7 * dir), y, 31) < 0.09) {
            w.glyph(x, y, '~', '#fbcfe8', 0.5);
          }
        }
      }

      // Parallax Petals
      const maxPetals = Math.round(clamp((w.cols * w.rows) / 14, 50, 150) * (cfg.density || 1.0));
      if (s.petals.length > maxPetals) s.petals.splice(0, s.petals.length - maxPetals);

      for (let i = 0; i < s.petals.length; i++) {
        const p = s.petals[i];
        p.ph += dt * p.swayFreq * (s.gustActive ? 2.0 : 1.0);
        const sway = Math.sin(p.ph) * p.swayAmp;

        p.x -= (p.vx * totalSpeed + sway * 0.4) * dt;
        p.y += (p.vy * totalSpeed * 0.75 + Math.abs(sway) * 0.25) * dt;
        p.rot += p.rotSpeed * dt * totalSpeed;

        if (hasMouse) {
          const dx = p.x - mouse.x;
          const dy = p.y - mouse.y;
          const dist = Math.hypot(dx, dy);
          if (dist < 12) {
            const force = (1 - dist / 12) * 9 * dt;
            p.x += (dx / (dist + 0.1)) * force + mouse.vx * 0.45 * dt;
            p.y += (dy / (dist + 0.1)) * force + mouse.vy * 0.45 * dt;
            p.rot += 14 * dt;
          }
        }

        if (p.x < -4 || p.y > w.rows + 1) {
          s.petals[i] = spawnSakuraPetal(w, false, Math.random() < 0.65, p.isFar);
          continue;
        }

        const char = Math.cos(p.rot) > 0.2 ? p.ch : Math.cos(p.rot) < -0.2 ? '+' : '°';
        w.tile(p.x, p.y, p.bg, p.fg, char, p.a * p.z);
      }

      if (s.gustActive) {
        for (let k = 0; k < 5; k++) {
          const wx = Math.round(w.cols - ((t * 40 + k * 18) % (w.cols + 24)));
          const wy = Math.round(2 + (k * 4) % (w.rows - 6));
          w.glyph(wx, wy, '~', '#ffffff', 0.45);
          w.glyph(wx + 1, wy, '~', '#fda4af', 0.35);
        }
      }
    },
  });


  /* ----------------------------------------------------------------- galaxy */

  // Smooth value noise built on hash(), for the nebula clouds.
  function gxNoise(x, y, s) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const a = hash(xi, yi, s);
    const b = hash(xi + 1, yi, s);
    const c = hash(xi, yi + 1, s);
    const d = hash(xi + 1, yi + 1, s);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  const gxFbm = (x, y, s) => gxNoise(x, y, s) * 0.55 + gxNoise(x * 2.1, y * 2.1, s + 7) * 0.3 + gxNoise(x * 4.3, y * 4.3, s + 13) * 0.15;

  // Where things sit; shared by the static layer and every frame.
  function gxLayout(w) {
    const narrow = w.cols < 70;
    return {
      bx: Math.round(w.cols * (narrow ? 0.5 : 0.64)),
      by: Math.round(w.rows * 0.42),
      R: clamp(Math.round(Math.min(w.cols / 3, w.rows) * 0.105), 3, 8),
      px: Math.round(w.cols * (narrow ? 0.2 : 0.13)),
      py: Math.round(w.rows * 0.8),
      pr: clamp(Math.round(Math.min(w.cols / 2.5, w.rows) * 0.13), 3, 10),
      gx: Math.round(w.cols * (narrow ? 0.25 : 0.2)),
      gy: Math.round(w.rows * 0.2),
      gs: clamp(Math.round(Math.min(w.cols / 3, w.rows) * 0.09), 3, 8),
    };
  }

  // Ice giant with a tilted ring, lit from the black hole's side.
  function gxPlanet(w, px, py, pr) {
    const bands = ['#312e81', '#4338ca', '#6366f1', '#a5b4fc', '#818cf8', '#3730a3'];
    const ringA = pr * 2.2;
    const ringB = pr * 0.6;
    const spanY = Math.ceil(ringB + ringA * 0.16) + 1;
    const ring = (front) => {
      for (let dy = -spanY; dy <= spanY; dy++) {
        for (let dx = -Math.ceil(ringA); dx <= Math.ceil(ringA); dx++) {
          const ty = dy - dx * 0.16;
          if (front ? ty < 0 : ty >= 0) continue;
          const e = Math.hypot(dx / ringA, ty / ringB);
          if (e < 0.6 || e > 1 || (e > 0.8 && e < 0.86)) continue;
          const col = e < 0.7 ? '#e0e7ff' : e < 0.8 ? '#c4b5fd' : '#94a3b8';
          w.tile(px + dx, py + dy, col, '#475569', e < 0.8 ? '=' : '-', front ? 0.85 : 0.55);
        }
      }
    };
    w.glow(px, py, pr * 2, '#6366f1', 0.28);
    ring(false);
    for (let dy = -pr; dy <= pr; dy++) {
      for (let dx = -pr; dx <= pr; dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 > pr * pr) continue;
        const bi = Math.floor((dy / pr + 1) * 3 + Math.sin(dx * 0.7) * 0.4);
        const band = bands[((bi % bands.length) + bands.length) % bands.length];
        w.tile(px + dx, py + dy, band, '#1e1b4b', hash(dx, dy, 9) < 0.5 ? '~' : '-', 1);
        const lit = ((dx - dy) / pr) * 0.7;
        const shade = clamp(-lit * 0.6 + 0.12, 0, 0.82);
        if (shade > 0.02) w.tile(px + dx, py + dy, '#020617', null, null, shade);
        if (d2 > (pr - 1) * (pr - 1) && lit > 0.25) w.glyph(px + dx, py + dy, '·', '#e0e7ff', 0.7);
      }
    }
    ring(true);
  }

  // Slowly turning spiral galaxy far away.
  function gxSpiral(w, gx, gy, gs, rot) {
    w.glow(gx, gy, gs * 1.8, '#c4b5fd', 0.3);
    for (let arm = 0; arm < 2; arm++) {
      for (let k = 0; k < 30; k++) {
        const f = k / 30;
        const ang = rot + arm * Math.PI + f * 2.6 * Math.PI;
        const r = gs * (0.15 + f * 0.95) + (hash(k, arm, 5) - 0.5) * 0.6;
        const col = f < 0.25 ? '#fef9c3' : f < 0.6 ? '#c4b5fd' : '#60a5fa';
        w.glyph(gx + Math.cos(ang) * r * 1.7, gy + Math.sin(ang) * r * 0.55, f < 0.3 ? '*' : hash(k, arm, 6) < 0.5 ? '·' : '.', col, 0.9 - f * 0.55);
      }
    }
    w.tile(gx, gy, '#fef3c7', '#ffffff', '*', 0.95);
  }

  // Half of the accretion disk. The far half goes behind the shadow, the near half in front of it.
  function gxDisk(w, L, ang, front) {
    const { bx, by, R } = L;
    const rx = R * 3.1;
    const ry = R * 0.6;
    const ein = (R * 1.3) / rx;
    const y0 = front ? 0 : -Math.ceil(ry);
    const y1 = front ? Math.ceil(ry) : -1;
    for (let dy = y0; dy <= y1; dy++) {
      for (let dx = -Math.ceil(rx); dx <= Math.ceil(rx); dx++) {
        const e = Math.hypot(dx / rx, dy / ry);
        if (e > 1 || e < ein) continue;
        const rn = (e - ein) / (1 - ein);
        const th = Math.atan2(dy / ry, dx / rx);
        const beam = 0.78 - 0.42 * Math.cos(th); // Doppler beaming: the side coming toward us is brighter
        const sw = Math.sin(th * 3 - ang * 4 + rn * 8);
        let bg = null;
        let fg;
        let ch;
        if (rn < 0.16) {
          bg = '#fde68a';
          fg = '#ffffff';
          ch = '*';
        } else if (rn < 0.42) {
          bg = sw > 0.2 ? '#f59e0b' : null;
          fg = '#fde68a';
          ch = sw > 0.2 ? '#' : '=';
        } else if (rn < 0.72) {
          fg = sw > 0 ? '#fb923c' : '#f43f5e';
          ch = sw > 0.3 ? '%' : '~';
        } else {
          fg = '#a855f7';
          ch = sw > 0 ? '·' : '.';
        }
        w.tile(bx + dx, by + dy, bg, fg, ch, clamp((1.05 - rn * 0.75) * beam * (0.78 + 0.22 * sw), 0.06, 1));
      }
    }
  }

  // Light from the far side of the disk, bent over the top and under the bottom of the shadow.
  function gxArcs(w, L, t) {
    const { bx, by, R } = L;
    const a = R * 1.75;
    const b = R * 1.45;
    const steps = Math.ceil(Math.PI * a * 1.6);
    for (let k = 0; k <= steps; k++) {
      const phi = (k / steps) * Math.PI;
      const u = Math.cos(phi);
      const h = Math.sin(phi);
      const beam = 0.8 - 0.35 * u;
      const fl = 0.85 + 0.15 * Math.sin(t * 3 + k * 0.4);
      const x = bx + u * a;
      w.tile(x, by - h * b, '#f59e0b', '#fff7ed', '*', clamp(0.92 * beam * fl, 0, 1));
      w.glyph(x, by - h * b - 1, '~', '#fbbf24', 0.4 * beam * h);
      w.glyph(x, by + h * b * 0.82, '~', '#fb923c', 0.55 * beam * fl);
    }
  }

  // The shadow (solid, no tile gaps) and its photon ring.
  function gxHorizon(w, L, t, flash) {
    const { bx, by, R } = L;
    const c = w.cell;
    w.ctx.fillStyle = '#000000';
    for (let dy = -R - 1; dy <= R + 1; dy++) {
      for (let dx = -R - 1; dx <= R + 1; dx++) {
        const d = Math.hypot(dx, dy);
        if (d <= R - 0.2) {
          w.ctx.fillRect((bx + dx) * c, (by + dy) * c, c, c);
        } else if (d <= R + 0.7) {
          const th = Math.atan2(dy, dx);
          w.tile(bx + dx, by + dy, '#fbbf24', '#ffffff', '·', clamp(0.7 + 0.25 * Math.sin(t * 2.5 + th * 3) + flash, 0, 1));
        }
      }
    }
  }

  function gxDust(w, initial) {
    const far = Math.random() < 0.55;
    const sp = far ? 0.25 : 0.6;
    let bvx = rnd(-sp, sp);
    let bvy = rnd(-sp, sp) * 0.6;
    let x = Math.random() * w.cols;
    let y = Math.random() * w.rows;
    if (!initial) {
      const e = rint(0, 3);
      if (e === 0) (x = -1), (bvx = Math.abs(bvx));
      else if (e === 1) (x = w.cols + 1), (bvx = -Math.abs(bvx));
      else if (e === 2) (y = -1), (bvy = Math.abs(bvy));
      else (y = w.rows + 1), (bvy = -Math.abs(bvy));
    }
    return {
      x,
      y,
      vx: bvx,
      vy: bvy,
      bvx,
      bvy,
      far,
      ex: 0,
      sl: 0,
      ch: pick(far ? ['·', '.', '°'] : ['*', '+', '·', '°', '~']),
      color: pick(['#a78bfa', '#f472b6', '#67e8f9', '#93c5fd', '#fde68a', '#e2e8f0']),
      a: far ? rnd(0.25, 0.55) : rnd(0.6, 0.95),
    };
  }

  THEMES.push({
    id: 'galaxy',
    name: 'Cosmic Galaxy',
    dark: true,
    alias: ['galaxy', 'vu tru', 'vutru', 'ngan ha', 'nganha', 'blackhole', 'ho den', 'space', 'nebula', 'cosmos'],
    glyphs: '·*+°~%#@',
    bg(c, w, h) {
      const g = c.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, '#04020a');
      g.addColorStop(0.45, '#0b061d');
      g.addColorStop(0.8, '#06091f');
      g.addColorStop(1, '#02040d');
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
      const v = c.createRadialGradient(w * 0.6, h * 0.45, Math.min(w, h) * 0.2, w * 0.5, h * 0.5, Math.max(w, h) * 0.75);
      v.addColorStop(0, 'rgba(0,0,0,0)');
      v.addColorStop(1, 'rgba(0,0,0,0.55)');
      c.fillStyle = v;
      c.fillRect(0, 0, w, h);
    },
    // Drawn once: nebula clouds and the ringed planet.
    under(w) {
      const L = gxLayout(w);
      w.glow(w.cols * 0.2, w.rows * 0.35, Math.max(w.cols, w.rows) * 0.35, '#7c3aed', 0.22);
      w.glow(w.cols * 0.8, w.rows * 0.75, Math.max(w.cols, w.rows) * 0.35, '#0891b2', 0.18);
      w.glow(w.cols * 0.45, w.rows * 0.15, Math.max(w.cols, w.rows) * 0.25, '#db2777', 0.14);
      const clouds = [
        { s: 101, sx: 0.05, sy: 0.08, bg: '#3b0764', fg: '#a78bfa' },
        { s: 202, sx: 0.07, sy: 0.06, bg: '#500724', fg: '#f472b6' },
        { s: 303, sx: 0.06, sy: 0.09, bg: '#083344', fg: '#67e8f9' },
      ];
      for (let j = 0; j < w.rows; j++) {
        for (let i = 0; i < w.cols; i++) {
          let best = null;
          let bv = 0;
          for (const cl of clouds) {
            const n = gxFbm(i * cl.sx, j * cl.sy, cl.s);
            if (n > bv) (bv = n), (best = cl);
          }
          const k = (bv - 0.56) / 0.3;
          if (k <= 0) continue;
          const ch = k > 0.75 ? '%' : k > 0.45 ? ':' : hash(i, j, 77) < 0.5 ? '.' : '·';
          w.tile(i, j, k > 0.35 ? best.bg : null, best.fg, ch, clamp(k * 0.5, 0.06, 0.45));
        }
      }
      gxPlanet(w, L.px, L.py, L.pr);
    },
    init(w) {
      const density = cfg.density || 1.0;
      const area = w.cols * w.rows;
      w.s = {
        stars: Array.from({ length: Math.round(clamp(area / 12, 60, 180) * density) }, () => ({
          x: Math.random() * w.cols,
          y: Math.random() * w.rows,
          z: pick([0.25, 0.5, 1]),
          tw: rnd(0.8, 3.2),
          ph: Math.random() * Math.PI * 2,
          color: pick(['#ffffff', '#e0e7ff', '#c7d2fe', '#fef08a', '#a5f3fc', '#fbcfe8']),
          ch: pick(['.', '·', '+', '*']),
          base: rnd(0.25, 0.8),
        })),
        hero: Array.from({ length: clamp(Math.round(area / 900), 3, 9) }, () => ({
          x: rint(2, w.cols - 3),
          y: rint(2, w.rows - 3),
          tw: rnd(0.6, 1.6),
          ph: Math.random() * Math.PI * 2,
          color: pick(['#a5f3fc', '#fde68a', '#f9a8d4', '#c4b5fd']),
        })),
        dust: Array.from({ length: Math.round(clamp(area / 9, 70, 200) * density) }, () => gxDust(w, true)),
        meteors: [],
        nextMeteor: rnd(2.0, 5.0),
        trail: [],
        ang: 0,
        flash: 0,
      };
    },
    frame(w, dt) {
      const s = w.s;
      const t = w.t;
      const sp = cfg.speed || 1.0;
      const mouse = w.mouse;
      const hasMouse = !!(mouse && mouse.active);
      const L = gxLayout(w);

      // Black hole aura, breathing slowly
      const breath = 0.85 + 0.15 * Math.sin(t * 0.8);
      w.glow(L.bx, L.by, L.R * 5, '#f59e0b', 0.24 * breath);
      w.glow(L.bx, L.by, L.R * 2.8, '#ec4899', 0.3 * breath);

      // Stars: three depths drifting at different speeds, bent away from the cursor (lensing)
      for (const st of s.stars) {
        st.x -= st.z * 0.12 * dt * sp;
        if (st.x < 0) st.x += w.cols;
        let x = st.x;
        let y = st.y;
        let a = clamp(st.base + Math.sin(t * st.tw + st.ph) * 0.35, 0.05, 1);
        if (hasMouse) {
          const dx = x - mouse.x;
          const dy = y - mouse.y;
          const d = Math.hypot(dx, dy);
          if (d < 7 && d > 0.01) {
            const push = 2.4 * (1 - d / 7);
            x += (dx / d) * push;
            y += (dy / d) * push;
            a = Math.min(1, a + 0.35);
          }
        }
        w.glyph(x, y, st.ch, st.color, a);
      }

      // Bright stars with cross-shaped flares
      for (const h of s.hero) {
        const k = 0.5 + 0.5 * Math.sin(t * h.tw + h.ph);
        w.glow(h.x, h.y, 2.4, h.color, 0.28 * k);
        w.tile(h.x, h.y, null, '#ffffff', '*', 0.7 + 0.3 * k);
        const len = k > 0.6 ? 2 : 1;
        for (let i = 1; i <= len; i++) {
          const a = (0.75 / i) * k;
          w.glyph(h.x - i, h.y, '-', h.color, a);
          w.glyph(h.x + i, h.y, '-', h.color, a);
          w.glyph(h.x, h.y - i, '|', h.color, a);
          w.glyph(h.x, h.y + i, '|', h.color, a);
        }
      }

      gxSpiral(w, L.gx, L.gy, L.gs, -t * 0.08 * sp);

      // Shooting stars
      s.nextMeteor -= dt * sp;
      if (s.nextMeteor <= 0) {
        s.meteors.push({
          x: rnd(w.cols * 0.1, w.cols * 0.9),
          y: rnd(-5, w.rows * 0.3),
          vx: rnd(35, 65),
          vy: rnd(20, 42),
          len: rint(4, 8),
          life: rnd(0.6, 1.2),
          color: pick(['#ffffff', '#a5f3fc', '#fef08a']),
        });
        s.nextMeteor = rnd(3.0, 7.0);
      }
      for (let i = s.meteors.length - 1; i >= 0; i--) {
        const m = s.meteors[i];
        m.life -= dt;
        m.x += m.vx * dt * sp;
        m.y += m.vy * dt * sp;
        if (m.life <= 0 || m.x > w.cols + 10 || m.y > w.rows + 10) {
          s.meteors.splice(i, 1);
          continue;
        }
        for (let k = 0; k < m.len; k++) {
          const a = clamp((m.life / 0.8) * (1 - k / m.len), 0, 1);
          w.glyph(m.x - (m.vx / 35) * k * 0.7, m.y - (m.vy / 20) * k * 0.7, k === 0 ? '*' : k < 3 ? '+' : '~', m.color, a);
        }
      }

      // Black hole: far half of the disk, bent light, shadow, near half of the disk
      s.ang += dt * 0.65 * sp;
      s.flash = Math.max(0, s.flash - dt);
      gxDisk(w, L, s.ang, false);
      gxArcs(w, L, t);
      gxHorizon(w, L, t, s.flash);
      gxDisk(w, L, s.ang, true);

      // Cosmic dust: falls into the black hole, swirls around the cursor, gets flung out when it passes too close
      const damp = Math.pow(0.55, dt);
      for (let i = 0; i < s.dust.length; i++) {
        const p = s.dust[i];
        const inf = p.far ? 0.45 : 1;
        let ax = 0;
        let ay = 0;

        const dx = L.bx - p.x;
        const dy = L.by - p.y;
        const d2 = dx * dx + dy * dy;
        const d = Math.sqrt(d2) || 1;
        if (d < L.R * 0.85) {
          s.flash = 0.3;
          s.dust[i] = gxDust(w, false);
          continue;
        }
        if (d < L.R * 7) {
          const g = (L.R * L.R * 2.2) / (d2 + 2);
          ax += (dx / d) * g - (dy / d) * g * 1.3;
          ay += (dy / d) * g + (dx / d) * g * 1.3;
        }

        if (hasMouse) {
          const mx = mouse.x - p.x;
          const my = mouse.y - p.y;
          const md = Math.hypot(mx, my);
          if (md < 22 && md > 0.05) {
            const ux = mx / md;
            const uy = my / md;
            const n = 1 - md / 22;
            const g = (55 * n * n) / (md + 1.2);
            ax += (ux * 0.9 - uy * 1.6) * g + mouse.vx * 0.6 * n;
            ay += (uy * 0.9 + ux * 1.6) * g + mouse.vy * 0.6 * n;
            if (md < 1.4 && p.sl <= 0) {
              // Gravitational slingshot
              const v = rnd(16, 26);
              p.vx = -uy * v - ux * v * 0.35;
              p.vy = ux * v - uy * v * 0.35;
              p.sl = 1.2;
              p.ex = 0.9;
            } else if (md < 6) {
              p.ex = Math.max(p.ex, 0.25);
            }
          }
        }

        p.vx += ax * dt * inf;
        p.vy += ay * dt * inf;
        p.vx = p.bvx + (p.vx - p.bvx) * damp;
        p.vy = p.bvy + (p.vy - p.bvy) * damp;
        const v = Math.hypot(p.vx, p.vy);
        if (v > 32) {
          p.vx *= 32 / v;
          p.vy *= 32 / v;
        }
        p.x += p.vx * dt * sp;
        p.y += p.vy * dt * sp;
        p.ex -= dt;
        p.sl -= dt;

        if (p.x < -8 || p.x > w.cols + 8 || p.y < -8 || p.y > w.rows + 8) {
          s.dust[i] = gxDust(w, false);
          continue;
        }

        if (p.ex > 0) {
          const hot = p.ex > 0.3;
          w.glyph(p.x - p.vx * 0.05, p.y - p.vy * 0.05, '·', p.color, 0.5);
          w.glyph(p.x, p.y, hot ? '*' : '+', hot ? (i % 2 ? '#67e8f9' : '#fde68a') : p.color, 1);
        } else {
          w.glyph(p.x, p.y, p.ch, p.color, p.a);
        }
      }

      // The cursor: a small singularity with its own spinning ring and a fading trail
      if (hasMouse) s.trail.push({ x: mouse.x, y: mouse.y, life: 0.6 });
      if (s.trail.length > 40) s.trail.splice(0, s.trail.length - 40);
      for (let i = s.trail.length - 1; i >= 0; i--) {
        const p = s.trail[i];
        p.life -= dt;
        if (p.life <= 0) {
          s.trail.splice(i, 1);
          continue;
        }
        w.glyph(p.x, p.y, '·', '#a78bfa', p.life * 1.1);
      }
      if (hasMouse) {
        w.glow(mouse.x, mouse.y, 7, '#7c3aed', 0.4);
        w.glow(mouse.x, mouse.y, 3, '#22d3ee', 0.5);
        for (let k = 0; k < 14; k++) {
          const a = (k / 14) * Math.PI * 2 + t * 2.4;
          const sy = Math.sin(a);
          w.glyph(mouse.x + Math.cos(a) * 2.8, mouse.y + sy * 1.2, sy > 0 ? '*' : '·', sy > 0 ? '#67e8f9' : '#c4b5fd', sy > 0 ? 0.95 : 0.5);
        }
        w.tile(mouse.x, mouse.y, '#000000', '#67e8f9', '•', 1);
      }
    },
  });

  // Hoi An by night: strings of silk lanterns over the old town, paper flower
  // lanterns (hoa dang) and a sampan drifting down the Hoai river.
  const LANTERN_COLS = [
    ['#d8342a', '#9f1f18', '#ff6a4d'],
    ['#ef7d22', '#b9560f', '#ffa95c'],
    ['#f5bd2e', '#c08d12', '#ffe07a'],
    ['#e8487f', '#aa2a58', '#ff8db0'],
    ['#1f9d94', '#13706a', '#56d6c8'],
  ];
  const lanternPal = (c) => ({
    L: [c[0], c[1]],
    B: [c[2], c[0]],
    c: ['#c9a14a', '#8a6c2a', '='],
    t: [null, '#e6c36a', '|'],
  });
  const LANTERN = sprite([' ccc ', 'LLLLL', 'LBBBL', 'LBBBL', 'LLLLL', ' ccc ', '  t  '], null);
  const LANTERN_SMALL = sprite([' c ', 'LBL', 'LBL', ' t '], null);
  const FLOWER = sprite([' f ', 'PpP'], null);
  const flowerPal = (petal, edge) => ({
    f: ['#fff1a8', '#f2b431', '*'],
    P: [petal, edge],
    p: ['#ffd66b', '#d9a22e'],
  });
  const FLOWER_PALS = [flowerPal('#ff9fcb', '#d9628f'), flowerPal('#fff4ea', '#d8c6b4'), flowerPal('#ff8a6b', '#cf5a3e')];
  const SAMPAN = sprite(['          L   ', '    rrrr  |   ', '  rrrrrrrr|   ', 'hhhhhhhhhhhhhh', ' hhhhhhhhhhhh '], {
    L: ['#ff6a4d', '#d8342a'],
    '|': [null, '#a8896a', '|'],
    r: ['#3a2c22', '#2a1f18'],
    h: ['#1c1512', '#2c211b'],
  });

  function hoianGeo(w) {
    const river = Math.round(w.rows * 0.74);
    const houseMax = clamp(Math.round(w.rows * 0.16), 2, 10);
    const small = w.rows < 28;
    const lh = small ? 4 : 7;
    const n = clamp(Math.round(w.rows / 22), 1, 3);
    const roofTop = river - houseMax - 2;
    return { river, houseMax, small, lh, n, step: Math.max(1, (roofTop - lh - 3) / n) };
  }

  THEMES.push({
    id: 'hoian',
    name: 'Hội An',
    dark: true,
    alias: ['hoi an', 'pho co', 'den long', 'den', 'hoa dang', 'lantern', 'lanterns'],
    glyphs: '*+:.',
    bg(c, w, h, W) {
      const g = hoianGeo(W);
      const ry = g.river * W.cell;
      vgrad(c, w, ry, ['#0c0a26', '#1f1438', '#4a2340']);
      const water = c.createLinearGradient(0, ry, 0, h);
      water.addColorStop(0, '#2c1a33');
      water.addColorStop(1, '#0a0a20');
      c.fillStyle = water;
      c.fillRect(0, ry, w, h - ry);
      rglow(c, w * 0.5, ry, Math.max(w, h) * 0.55, '#ff9a4d', 0.2);
    },
    init(w) {
      const s = w.s;
      const g = hoianGeo(w);
      const C = w.cols;

      s.houses = [];
      for (let x = rint(-4, 0); x < C; ) {
        const wd = rint(6, 12);
        s.houses.push({ x, w: wd, h: rint(Math.ceil(g.houseMax * 0.5), g.houseMax), tone: rint(0, 2) });
        x += wd;
      }
      s.windows = [];
      for (const hs of s.houses) {
        for (let wx = hs.x + 2; wx < hs.x + hs.w - 1; wx += 3) {
          for (let wy = g.river - hs.h + 1; wy < g.river - 1; wy += 3) {
            if (Math.random() < 0.65) s.windows.push({ x: wx, y: wy, ph: rnd(0, 6), f: rnd(0.4, 1.3) });
          }
        }
      }

      s.strings = [];
      s.lanterns = [];
      for (let k = 0; k < g.n; k++) {
        const str = { y0: Math.round(k * g.step), sag: g.small ? 1 : rnd(2, 3.2), a: 0.55 + (0.3 * (k + 1)) / g.n };
        s.strings.push(str);
        for (let x = rnd(0, 5); x < C; x += rnd(9, 14)) {
          const u = (x / Math.max(1, C)) * 2 - 1;
          const col = pick(LANTERN_COLS);
          s.lanterns.push({ x, y: str.y0 + str.sag * (1 - u * u), a: str.a, col, pal: lanternPal(col), ph: rnd(0, 6), seed: rint(1, 99) });
        }
      }

      s.stars = Array.from({ length: Math.round(clamp((w.cols * w.rows) / 160, 6, 50)) }, () => ({
        x: rint(0, C - 1),
        y: rint(0, Math.max(0, g.river - g.houseMax - 3)),
        ch: pick(['.', '+', '·']),
        ph: rnd(0, 6),
        f: rnd(0.6, 1.8),
      }));

      const water = w.rows - g.river;
      s.flowers = Array.from({ length: Math.round(clamp(C / 9, 3, 14)) }, () => ({
        x: rnd(-3, C),
        y: rint(g.river + 1, Math.max(g.river + 1, w.rows - 2)),
        v: rnd(0.3, 0.8),
        ph: rnd(0, 6),
        pal: pick(FLOWER_PALS),
      })).sort((a, b) => a.y - b.y);
      s.boat = water >= 8 ? { x: rnd(-14, C), y: g.river + 1, v: rnd(0.35, 0.6), ph: rnd(0, 6) } : null;
    },
    under(w) {
      const s = w.s;
      const g = hoianGeo(w);
      const WALLS = [['#3b2a20', '#4a3527'], ['#46321f', '#574027'], ['#33261f', '#433228']];
      for (const hs of s.houses) {
        const wall = WALLS[hs.tone];
        for (let x = hs.x; x < hs.x + hs.w; x++) {
          for (let y = g.river - hs.h; y < g.river; y++) w.tile(x, y, wall[0], wall[1], w.ch(x, y, 51));
        }
        // Pitched roof of old tiles, one row narrower on each side per step.
        for (let k = 0; k < 2; k++) {
          for (let x = hs.x - 1 + k * 2; x <= hs.x + hs.w - k * 2; x++) w.tile(x, g.river - hs.h - 1 - k, k ? '#6d3324' : '#7f3d2a', '#55261a', '=');
        }
      }
      // Stone embankment, with the town's dark reflection under it.
      for (let x = 0; x < w.cols; x++) {
        w.tile(x, g.river, '#40362f', '#2f2722', '_');
        for (let y = g.river + 1; y < Math.min(w.rows, g.river + 3); y++) w.tile(x, y, '#120d1c', null, '', 0.5 - (y - g.river) * 0.14);
      }
      // Wires, sagging between the eaves.
      for (const str of s.strings) {
        for (let x = 0; x < w.cols; x++) {
          const u = (x / Math.max(1, w.cols)) * 2 - 1;
          w.glyph(x, str.y0 + str.sag * (1 - u * u), '-', '#8d7a68', str.a * 0.6);
        }
      }
    },
    frame(w, dt) {
      const s = w.s;
      const g = hoianGeo(w);
      const t = w.t;
      const sp = g.small ? LANTERN_SMALL : LANTERN;
      const mid = (sp.w - 1) / 2;
      const tick = Math.floor(t * 4);

      for (const st of s.stars) w.glyph(st.x, st.y, st.ch, '#f4e8d0', 0.2 + 0.6 * (0.5 + 0.5 * Math.sin(t * st.f + st.ph)));
      for (const wn of s.windows) w.tile(wn.x, wn.y, '#ffc65c', '#d99a2f', '#', 0.55 + 0.35 * Math.sin(t * wn.f + wn.ph));

      // River: slow ripples and the shimmer of every lantern's light.
      for (let y = g.river + 1; y < w.rows; y++) {
        const dir = y % 2 ? 1 : -1;
        for (let x = 0; x < w.cols; x++) {
          if (hash(Math.floor(x + t * 0.6 * dir), y, 61) < 0.06) w.glyph(x, y, '~', '#6d5a86', 0.6);
        }
      }
      for (const l of s.lanterns) {
        const x = Math.round(l.x + mid);
        for (let y = g.river + 1; y < w.rows; y++) {
          const d = y - g.river;
          if (hash(x + (d >> 1), y, tick + l.seed) < 0.34) w.tile(x + rint(-1, 1), y, l.col[0], l.col[1], '~', Math.max(0.08, 0.42 - d * 0.018));
        }
      }

      if (s.boat) {
        const b = s.boat;
        b.x += b.v * dt;
        if (b.x > w.cols + 1) b.x = -15;
        const y = b.y + Math.sin(t * 0.9 + b.ph) * 0.4;
        w.glow(b.x + 10, y, 3.5, '#ff8a4d', 0.4 + 0.08 * Math.sin(t * 3));
        w.sprite(SAMPAN, b.x, y, { seed: 6 });
      }

      for (const f of s.flowers) {
        f.x += f.v * dt;
        if (f.x > w.cols + 1) f.x = -4;
        const y = f.y + Math.sin(t * 1.1 + f.ph) * 0.35;
        w.glow(f.x + 1, y, 3, '#ffbf66', 0.34 + 0.12 * Math.sin(t * 4 + f.ph));
        w.sprite(FLOWER, f.x, y - 1, { pal: f.pal, seed: 8 });
      }

      for (const l of s.lanterns) {
        const sway = Math.sin(t * 0.8 + l.ph) * 0.8;
        const flick = 0.3 + 0.07 * Math.sin(t * 2.6 + l.ph) + 0.03 * Math.sin(t * 7.3 + l.ph * 2);
        w.glow(l.x + mid + sway, l.y + sp.h / 2 - 0.5, g.small ? 3.5 : 6, l.col[2], flick * l.a);
        w.sprite(sp, l.x + sway, l.y, { pal: l.pal, a: l.a, seed: l.seed });
      }
    },
  });

  // Christmas Eve at blue hour, painted as fine pixel art: a snowy village of
  // wooden houses with lit windows, a big decorated tree with twinkling lights
  // and a star, street lanterns, snowy branches strung with fairy lights in the
  // top corners, and snow falling. The pointer blows the snow aside.
  // Smooth 1D noise, for aurora rays.
  function nxRay(x, s) {
    const i = Math.floor(x);
    const f = x - i;
    const u = f * f * (3 - 2 * f);
    return hash(i, 7, s) * (1 - u) + hash(i + 1, 7, s) * u;
  }
  const nxHex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const nxMix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const NX_BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const nxB = (x, y) => NX_BAYER[(y & 3) * 4 + (x & 3)] / 16;
  const NX = {
    skyTop: nxHex('#142347'),
    skyMid: nxHex('#29457c'),
    skyLow: nxHex('#6f8fc4'),
    star: nxHex('#e8eeff'),
    hillFar: nxHex('#4d6aa3'),
    hillNear: nxHex('#3a5590'),
    pineFar: nxHex('#2c4677'),
    snow: nxHex('#eef3fb'),
    snowShade: nxHex('#b7c6e4'),
    snowDeep: nxHex('#93a8d4'),
    wall: nxHex('#7a4b31'),
    wallDark: nxHex('#5a3423'),
    beam: nxHex('#3e241a'),
    window: nxHex('#ffcc66'),
    windowHot: nxHex('#fff0b8'),
    door: nxHex('#3a2116'),
    roofUnder: nxHex('#6c7fae'),
    tree: nxHex('#1d4733'),
    treeDark: nxHex('#143424'),
    treeLit: nxHex('#2c5f44'),
    trunk: nxHex('#3b2619'),
    post: nxHex('#1e2236'),
    lamp: nxHex('#ffd27a'),
    branch: nxHex('#2a2129'),
    gold: nxHex('#ffd34d'),
  };
  const NX_BULBS = ['#fff1c4', '#ffe9a8', '#ffe9a8', '#ffd34d', '#ffd34d', '#ffc861'];

  // Paints the still scene into a PW x PH pixel buffer and records where the
  // lights are, so the frame can make them twinkle.
  function nxPaint(PW, PH, seed, wide) {
    const img = new Uint8ClampedArray(PW * PH * 4);
    const put = (x, y, col, a = 1) => {
      x = Math.round(x);
      y = Math.round(y);
      if (x < 0 || y < 0 || x >= PW || y >= PH) return;
      const i = (y * PW + x) * 4;
      if (a >= 1) {
        img[i] = col[0];
        img[i + 1] = col[1];
        img[i + 2] = col[2];
      } else {
        img[i] += (col[0] - img[i]) * a;
        img[i + 1] += (col[1] - img[i + 1]) * a;
        img[i + 2] += (col[2] - img[i + 2]) * a;
      }
      img[i + 3] = 255;
    };
    const H = (a, b) => hash(a, b, seed);
    // Things in front of the falling snow and of Santa (the corner branches) go
    // into a second, transparent buffer.
    const over = new Uint8ClampedArray(PW * PH * 4);
    const putO = (x, y, col) => {
      x = Math.round(x);
      y = Math.round(y);
      if (x < 0 || y < 0 || x >= PW || y >= PH) return;
      const i = (y * PW + x) * 4;
      over[i] = col[0];
      over[i + 1] = col[1];
      over[i + 2] = col[2];
      over[i + 3] = 255;
    };
    const cones = [];
    const glints = [];
    const lights = [];
    const chimneys = [];
    const glows = [];

    // Blue-hour sky in dithered bands, a few stars up high.
    for (let y = 0; y < PH; y++) {
      for (let x = 0; x < PW; x++) {
        const t = y / (PH * 0.7);
        const q = Math.round(clamp(t, 0, 1) * 10 + nxB(x, y) - 0.5) / 10;
        put(x, y, q < 0.55 ? nxMix(NX.skyTop, NX.skyMid, q / 0.55) : nxMix(NX.skyMid, NX.skyLow, (q - 0.55) / 0.45));
      }
    }
    const twinkles = [];
    for (let i = 0; i < PW * PH * 0.0012; i++) {
      const x = H(i, 1) * PW;
      const y = H(i, 2) * PH * 0.35;
      put(x, y, NX.star, 0.4 + H(i, 3) * 0.6);
      if (H(i, 4) < 0.3) twinkles.push({ x, y, ph: H(i, 5) * 6, f: 1 + H(i, 6) * 2 });
    }

    // A full moon with a soft dithered halo, low enough for Santa to cross it.
    const moon = (mx, my, r) => {
      for (let y = Math.floor(my - r * 2); y <= my + r * 2; y++) {
        for (let x = Math.floor(mx - r * 2); x <= mx + r * 2; x++) {
          const d = Math.hypot(x - mx, y - my);
          if (d <= r) {
            const shade = (x - mx) * 0.55 + (y - my) * 0.75 > r * 0.35;
            const crater = hash(Math.floor((x - mx + r) / Math.max(2, r * 0.35)), Math.floor((y - my + r) / Math.max(2, r * 0.35)), seed + 7) < 0.3 && nxB(x, y) < 0.5;
            put(x, y, crater ? nxHex('#d6cfb2') : shade && nxB(x, y) < 0.6 ? nxHex('#e2dcc2') : nxHex('#f6f2df'));
          } else if (d <= r * 1.9 && nxB(x, y) < (1 - (d - r) / (r * 0.9)) * 0.55) put(x, y, nxHex('#c9d6f0'), 0.45);
        }
      }
      glows.push({ x: mx, y: my, r: r * 4.5, c: '#dbe6ff', a: 0.32, moon: true });
    };
    moon(PW * (wide ? 0.42 : 0.3), PH * 0.17, Math.max(4, PH * 0.065));

    // Distant mountains with snowy caps, lit on the moon's side.
    const range = (base, height, col, shade, snowLit, snowShade, n, sd) => {
      const peaks = [];
      for (let i = 0; i < n; i++) peaks.push({ x: H(i, sd) * PW * 1.1 - PW * 0.05, h: height * (0.55 + 0.45 * H(i, sd + 1)), w: PW * (0.07 + 0.07 * H(i, sd + 2)) });
      for (let x = 0; x < PW; x++) {
        let best = 0;
        let pk = peaks[0];
        for (const p of peaks) {
          const v = p.h * (1 - Math.abs(x - p.x) / p.w);
          if (v > best) {
            best = v;
            pk = p;
          }
        }
        const lit = x < pk.x;
        const top = Math.round(base - best + (H(x, sd + 3) - 0.5) * 1.4);
        const cap = pk.h * 0.33 * (0.7 + 0.6 * H(x >> 1, sd + 4));
        for (let y = Math.max(0, top); y < PH; y++) {
          const capped = y - top < cap * (best / pk.h);
          put(x, y, capped ? (lit ? snowLit : snowShade) : lit ? col : shade);
        }
      }
    };
    range(PH * 0.6, PH * 0.2, nxHex('#5f7bb2'), nxHex('#4c659c'), nxHex('#dfe7f6'), nxHex('#a9bbdc'), Math.max(4, Math.round(PW / 45)), 300);

    const ground = (x) => PH * (0.8 - 0.02 * Math.sin((x / PW) * 3.4 + H(9, 9) * 6));
    // Far snowy hills with rows of snow-capped pines.
    [
      [0.6, 0.05, NX.hillFar, 0.05],
      [0.68, 0.045, NX.hillNear, 0.075],
    ].forEach(([base, amp, col, ph], k) => {
      const p = [H(k, 20) * 6, H(k, 21) * 6];
      const ridge = (x) => PH * (base - amp * (0.5 + 0.35 * Math.sin((x / PW) * 6 + p[0]) + 0.15 * Math.sin((x / PW) * 17 + p[1])));
      const top = new Float32Array(PW);
      for (let x = 0; x < PW; x++) top[x] = ridge(x);
      const pineH = Math.max(3, PH * ph);
      const snowTips = [];
      for (let cx = H(k, 30) * pineH; cx < PW; cx += pineH * (0.35 + 0.4 * H(Math.round(cx), k + 40))) {
        if (H(Math.round(cx), k + 50) < 0.3) continue;
        const c = Math.round(cx);
        const h = pineH * (0.6 + 0.5 * H(c, k + 60));
        const tip = ridge(c) - h;
        for (let d = 0; d <= h; d++) {
          const half = Math.floor(d * 0.36) - ((d % 4) === 0 && d > 0 ? 1 : 0);
          for (let dx = -half; dx <= half; dx++) {
            const x = c + dx;
            if (x < 0 || x >= PW) continue;
            if (tip + d < top[x]) {
              top[x] = tip + d;
              if ((d % 4) === 1 || d === 0) snowTips.push([x, tip + d]);
            }
          }
        }
      }
      for (let x = 0; x < PW; x++) {
        for (let y = Math.max(0, Math.round(top[x])); y < PH; y++) put(x, y, col);
        // Snow lies on the open ground between the pines.
        if (Math.abs(top[x] - ridge(x)) < 0.5) put(x, Math.round(top[x]), nxMix(col, NX.snow, 0.3 - k * 0.08));
      }
      for (const [x, y] of snowTips) put(x, y, nxMix(col, NX.snow, 0.6));
      // Distant village glow at the foot of the hills.
      for (let y = Math.round(PH * (base + 0.02)); y < PH * (base + 0.08); y++) {
        for (let x = 0; x < PW; x++) if (nxB(x, y) < 0.25 * (1 - k * 0.4)) put(x, y, nxMix(col, NX.skyLow, 0.5), 0.6);
      }
    });

    // Snowy ground with soft blue shadows and sparkles.
    for (let x = 0; x < PW; x++) {
      const g = Math.round(ground(x));
      for (let y = g; y < PH; y++) {
        const t = (y - g) / (PH - g + 1);
        let col = NX.snow;
        // Soft drifts: broad shadowed hollows, dithered only along their edges.
        const sh = 0.5 + 0.5 * Math.sin(x * 0.035 + Math.sin(y * 0.09) * 2 + H(1, 1) * 6) * Math.cos(y * 0.07 + x * 0.01);
        if (sh > 0.78 || (sh > 0.68 && nxB(x, y) < (sh - 0.68) * 10)) col = NX.snowShade;
        if (y === g) col = nxMix(NX.snow, NX.skyLow, 0.25);
        put(x, y, col);
        if (H(x, y + 999) < 0.004) put(x, y, [255, 255, 255]);
      }
    }

    // Wooden houses with thick snow on their roofs and lit windows.
    const s = Math.max(1, Math.round(PH / 130));
    const house = (x0, w, wallH) => {
      const g = Math.round(Math.min(ground(x0), ground(x0 + w)));
      const roofH = Math.round(w * 0.42);
      const top = g - wallH;
      for (let y = top; y < g; y++) {
        for (let x = x0; x < x0 + w; x++) {
          const beam = (x - x0) % (6 * s) === 0 || y === top || x === x0 + w - 1;
          put(x, y, beam ? NX.beam : x > x0 + w * 0.6 ? NX.wallDark : NX.wall);
        }
      }
      // Windows two per floor, a door in the middle.
      const ww = 3 * s;
      const wh = 4 * s;
      const rows = Math.max(1, Math.floor((wallH - 2 * s) / (wh + 3 * s)));
      for (let r = 0; r < rows; r++) {
        const wy = top + 2 * s + r * (wh + 3 * s);
        for (const fx of [0.18, 0.66]) {
          const wx = Math.round(x0 + w * fx);
          for (let y = wy; y < wy + wh; y++) for (let x = wx; x < wx + ww; x++) put(x, y, (x - wx) === Math.floor(ww / 2) || (y - wy) === Math.floor(wh / 2) ? NX.beam : y > wy + wh / 2 ? NX.windowHot : NX.window);
          glows.push({ x: wx + ww / 2, y: wy + wh / 2, r: 6 * s, c: '#ffbf5a', a: 0.45 });
        }
      }
      const dx = Math.round(x0 + w / 2 - 2 * s);
      for (let y = g - 6 * s; y < g; y++) for (let x = dx; x < dx + 4 * s; x++) put(x, y, NX.door);
      // A wreath on the door with a red bow.
      const wcx = dx + 2 * s - 0.5;
      const wcy = g - 4 * s;
      for (let y = Math.floor(wcy - 2 * s); y <= wcy + 2 * s; y++) {
        for (let x = Math.floor(wcx - 2 * s); x <= wcx + 2 * s; x++) {
          const d = Math.hypot(x - wcx, y - wcy);
          if (d <= 1.7 * s && d >= 0.8 * s) put(x, y, H(x, y) < 0.15 ? nxHex('#d8443c') : nxHex('#2f6b3a'));
        }
      }
      put(wcx, wcy + 1.5 * s, nxHex('#d8443c'));
      // Gable roof: dark underside, then a deep layer of snow with a soft edge.
      for (let d = 0; d <= roofH; d++) {
        const half = (d / roofH) * (w / 2 + 2 * s);
        const y = top - roofH + d;
        for (let x = Math.round(x0 + w / 2 - half); x <= x0 + w / 2 + half; x++) put(x, y, d > roofH - 2 * s ? NX.roofUnder : y < top - roofH + d + 1 && H(x, y) < 0.2 ? NX.snowShade : NX.snow);
      }
      // Icicle drips and a string of lights along the eaves.
      for (let x = x0 - 2 * s; x <= x0 + w + 2 * s; x++) if (H(x, top) < 0.25) for (let k = 0; k < 1 + H(x, 3) * 2 * s; k++) put(x, top + 1 + k, NX.snowShade);
      for (let d = 2; d <= roofH; d += 2 * s) {
        const half = (d / roofH) * (w / 2 + 2 * s);
        const y = top - roofH + d + 1;
        lights.push({ x: x0 + w / 2 - half, y, c: pick(NX_BULBS), ph: H(d, x0) * 6 });
        lights.push({ x: x0 + w / 2 + half, y, c: pick(NX_BULBS), ph: H(d, x0 + 1) * 6 });
      }
      // Chimney with a cap of snow.
      const cx = Math.round(x0 + w * 0.72);
      const cTop = top - Math.round(roofH * 0.75);
      for (let y = cTop; y < cTop + 4 * s; y++) for (let x = cx; x < cx + 3 * s; x++) put(x, y, y < cTop + s ? NX.snow : NX.beam);
      chimneys.push({ x: cx + 1.5 * s, y: cTop - 1 });
    };

    // A back row of smaller houses and a church, tinted blue by the distance.
    const far = (c) => nxMix(c, NX.skyLow, 0.42);
    const backHouse = (x0, w, h, y0) => {
      const roofH = Math.round(w * 0.45);
      for (let y = y0 - h; y < y0; y++) for (let x = x0; x < x0 + w; x++) put(x, y, far(x > x0 + w * 0.6 ? NX.wallDark : NX.wall));
      for (let d = 0; d <= roofH; d++) {
        const half = (d / roofH) * (w / 2 + s);
        for (let x = Math.round(x0 + w / 2 - half); x <= x0 + w / 2 + half; x++) put(x, y0 - h - roofH + d, far(d > roofH - s ? NX.roofUnder : NX.snow));
      }
      for (const fx of [0.25, 0.65]) {
        const wx = Math.round(x0 + w * fx);
        for (let y = y0 - h + s; y < y0 - h + 3 * s; y++) for (let x = wx; x < wx + 2 * s; x++) put(x, y, NX.window);
        glows.push({ x: wx + s, y: y0 - h + 2 * s, r: 3 * s, c: '#ffbf5a', a: 0.25 });
      }
    };
    const church = (x0, w, h, y0) => {
      backHouse(x0 + w * 0.3, w * 0.7, h * 0.8, y0);
      const tw = Math.max(3, Math.round(w * 0.32));
      const th = h * 1.7;
      for (let y = Math.round(y0 - th); y < y0; y++) for (let x = x0; x < x0 + tw; x++) put(x, y, far(x > x0 + tw * 0.6 ? NX.wallDark : nxHex('#9a6a48')));
      const sh = th * 0.55;
      for (let d = 0; d <= sh; d++) {
        const half = (d / sh) * (tw / 2 + 1);
        for (let x = Math.round(x0 + tw / 2 - half); x <= x0 + tw / 2 + half; x++) put(x, y0 - th - sh + d, far(x > x0 + tw / 2 ? NX.snowShade : NX.snow));
      }
      const cx = Math.round(x0 + tw / 2);
      const cy = Math.round(y0 - th - sh);
      for (let k = 1; k <= 3 * s; k++) put(cx, cy - k, NX.gold);
      for (let k = -s; k <= s; k++) put(cx + k, cy - 2 * s, NX.gold);
      for (let y = Math.round(y0 - th * 0.75); y < y0 - th * 0.75 + 4 * s; y++) for (let x = cx - s; x < cx + s; x++) put(x, y, NX.window);
      glows.push({ x: cx, y: y0 - th * 0.7, r: 5 * s, c: '#ffcf70', a: 0.35 });
    };

    // Snow-laden pines between the houses.
    const snowPine = (cx, base, h) => {
      for (let y = Math.round(base - h * 0.1); y < base; y++) put(cx, y, NX.trunk);
      const tiers = 4;
      for (let k = 0; k < tiers; k++) {
        const ty = base - h + k * h * 0.22;
        const th = h * 0.34;
        const tw = h * (0.16 + k * 0.07);
        for (let d = 0; d < th; d++) {
          const half = (d / th) * tw;
          for (let x = Math.round(cx - half); x <= cx + half; x++) {
            const u = (x - cx) / Math.max(1, half);
            let col = u < -0.3 ? nxHex('#2c5a44') : u > 0.4 ? nxHex('#163527') : nxHex('#1f4433');
            if (d < 2 || (d < th * 0.5 && H(x, Math.round(ty + d)) < 0.25)) col = d < 1 || u < 0.3 ? NX.snow : NX.snowShade;
            put(x, ty + d, col);
          }
        }
      }
    };

    // A wooden fence with snow on its posts and rails.
    const fence = (x0, x1, y) => {
      const post = nxHex('#6b4a34');
      const dark = nxHex('#4a3224');
      for (let x = Math.round(x0); x <= x1; x++) {
        put(x, y - 2 * s, dark);
        put(x, y - 4 * s, post);
        put(x, y - 4 * s - 1, NX.snow);
      }
      for (let x = Math.round(x0); x <= x1; x += 5 * s) {
        for (let k = 0; k < 6 * s; k++) for (let a = 0; a < s; a++) put(x + a, y - k, a ? dark : post);
        for (let a = -1; a <= s; a++) put(x + a, y - 6 * s, NX.snow);
      }
    };

    // The tree: tiers of dark needles, snow on each tier, lights in a spiral.
    const tree = (cx, base, h) => {
      const tipY = base - h;
      for (let y = Math.round(base - h * 0.08); y < base; y++) for (let x = Math.round(cx - h * 0.03); x <= cx + h * 0.03; x++) put(x, y, NX.trunk);
      const half = (d) => {
        const tier = h / 6;
        const k = d % tier;
        return (d / h) * h * 0.36 * (0.75 + 0.25 * (k / tier)) + 1;
      };
      for (let d = 0; d < h * 0.92; d++) {
        const y = tipY + d;
        const hw = half(d);
        for (let x = Math.round(cx - hw); x <= cx + hw; x++) {
          const u = (x - cx) / hw;
          const tierTop = (d % (h / 6)) < 1.5;
          let col = u < -0.2 ? NX.treeLit : u > 0.45 ? NX.treeDark : NX.tree;
          if (tierTop && H(x, y) < 0.7) col = NX.snow;
          else if (H(x, y + 3) < 0.05) col = NX.snowShade;
          put(x, y, col);
        }
      }
      // Lights wind around the tree; only the front of the spiral shows.
      const nb = Math.round(clamp(h * 9, 120, 520));
      for (let i = 0; i < nb; i++) {
        const t = i / nb;
        const d = t * h * 0.9;
        const ang = t * Math.PI * 2 * 7.5;
        if (Math.cos(ang) < -0.2) continue;
        lights.push({ x: cx + Math.sin(ang) * half(d) * 0.92, y: tipY + d, c: pick(NX_BULBS), ph: H(i, 77) * 6, big: true });
      }
      // Baubles.
      for (let i = 0; i < h * 0.25; i++) {
        const d = h * (0.15 + 0.75 * H(i, 88));
        const x = cx + (H(i, 89) * 2 - 1) * half(d) * 0.8;
        put(x, tipY + d, nxHex(pick(['#e0393e', '#ffd34d', '#e0393e', '#c8d4ff'])));
      }
      // The star.
      const r = Math.max(2, h * 0.05);
      for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
        const a = Math.atan2(y, x);
        const rr = r * (0.5 + 0.5 * Math.abs(Math.cos(a * 2.5)));
        if (Math.hypot(x, y) <= rr) put(cx + x, tipY - r * 0.6 + y, NX.gold);
      }
      glows.push({ x: cx, y: tipY - r * 0.6, r: r * 4, c: '#ffd34d', a: 0.55, star: true });
      glows.push({ x: cx, y: base - h * 0.45, r: h * 0.7, c: '#ffb347', a: 0.28 });
      // Presents piled at the foot of the tree, ribbons and a dusting of snow.
      const gs = Math.max(2, Math.round(h * 0.06));
      const gifts = [
        [-0.32, 1.3, 1.0, '#c8323a', '#f2c14e'],
        [-0.12, 1.0, 0.8, '#2f7a4a', '#f2f2f2'],
        [0.08, 1.5, 1.2, '#f2c14e', '#c8323a'],
        [0.28, 1.1, 0.9, '#4a6fc4', '#f2c14e'],
        [-0.22, 0.8, 0.7, '#e7e7ef', '#c8323a'],
      ];
      for (const [fx, fw, fh, box, rib] of gifts) {
        const gw = Math.round(gs * 2 * fw);
        const gh = Math.round(gs * 1.6 * fh);
        const gx = Math.round(cx + fx * h * 0.5 - gw / 2);
        const gy = Math.round(base + 1 - gh);
        const bc = nxHex(box);
        const rc = nxHex(rib);
        for (let y = gy; y < gy + gh; y++) {
          for (let x = gx; x < gx + gw; x++) {
            const rib1 = x === gx + Math.floor(gw / 2);
            const rib2 = y === gy + Math.floor(gh / 2);
            put(x, y, rib1 || rib2 ? rc : x > gx + gw * 0.65 ? nxMix(bc, [0, 0, 0], 0.25) : bc);
          }
        }
        for (let x = gx; x < gx + gw; x++) if (H(x, gy) < 0.6) put(x, gy, NX.snow);
        put(gx + Math.floor(gw / 2) - 1, gy - 1, rc);
        put(gx + Math.floor(gw / 2) + 1, gy - 1, rc);
      }
      return { x: cx, tipY, r };
    };

    // Street lanterns.
    const lantern = (x, g, h) => {
      for (let y = g - h; y < g; y++) put(x, y, NX.post);
      put(x - 1, g - 1, NX.post);
      put(x + 1, g - 1, NX.post);
      const w = Math.max(2, Math.round(h * 0.08));
      for (let y = g - h - w * 2; y < g - h; y++) for (let k = -w; k <= w; k++) put(x + k, y, Math.abs(k) === w ? NX.post : NX.lamp);
      for (let k = -w - 1; k <= w + 1; k++) put(x + k, g - h - w * 2 - 1, NX.snow);
      glows.push({ x, y: g - h - w, r: h * 0.45, c: '#ffc861', a: 0.5, lamp: true });
      // A soft cone of light down to the snow; flakes passing through it light up.
      const top = g - h - w;
      const spread = h * 0.42;
      cones.push({ x, top, bottom: g, spread });
      const warm = nxHex('#ffdca0');
      for (let y = Math.round(top); y < g; y++) {
        const k = (y - top) / (g - top);
        const half = 1 + spread * k;
        for (let xx = Math.round(x - half); xx <= x + half; xx++) {
          const e = Math.abs(xx - x) / half;
          const a = (1 - e) * (0.22 - k * 0.12);
          if (nxB(xx, y) < a * 2.2) put(xx, y, warm, 0.35);
        }
      }
    };

    // Snowy branches reaching in from the top corners, strung with fairy lights.
    const branch = (x, y, ang, len, th, depth) => {
      let px = x;
      let py = y;
      for (let i = 0; i < len; i++) {
        ang += (H(Math.round(px), Math.round(py)) - 0.5) * 0.25;
        px += Math.cos(ang);
        py += Math.sin(ang) * 0.9 + 0.12;
        // Branches stay in the top corners, clear of the tree's star.
        if (py > PH * 0.26) break;
        const t = Math.max(1, th * (1 - i / len));
        for (let k = -t / 2; k <= t / 2; k++) putO(px, py + k, NX.branch);
        putO(px, py - t / 2 - 1, NX.snow);
        if (H(i, depth + Math.round(x)) < 0.3) putO(px, py - t / 2 - 2, NX.snowShade);
        if (i % 3 === 0) lights.push({ x: px, y: py + t / 2 + 1, c: '#ffe9a8', ph: H(i, Math.round(px)) * 6, fairy: true });
        if (depth < 2 && i > len * 0.25 && H(i, depth * 31 + Math.round(x)) < 0.05) branch(px, py, ang + (H(i, 5) < 0.5 ? -0.6 : 0.6), len * 0.45, t * 0.7, depth + 1);
      }
    };

    // Warm light spilling onto the snow, dithered so it reads as pixel art.
    const pool = (cx, cy, rx, ry, a) => {
      const warm = nxHex('#ffc77a');
      for (let y = Math.floor(cy - ry); y <= cy + ry; y++) {
        for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
          if (y < ground(x)) continue;
          const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
          if (d >= 1) continue;
          const v = Math.round(Math.pow(1 - d, 0.8) * a * 8 + nxB(x, y) - 0.5) / 8;
          if (v > 0) put(x, y, warm, v);
        }
      }
    };

    // A cute snowman (our own design, chibi proportions): a big round head with
    // shiny eyes, rosy cheeks and a smile, a knitted beanie with a pompom, a
    // striped scarf, a small round body and stick arms, one waving, with mittens.
    const snowman = (cx, gy, size) => {
      const u = Math.max(1, Math.floor(size / 26));
      const outline = nxHex('#8296c4');
      const coal = nxHex('#1d1a22');
      const P = (x, y, col) => {
        for (let a = 0; a < u; a++) for (let b = 0; b < u; b++) put(cx + x * u + a, gy + y * u + b, col);
      };
      const ball = (oy, r) => {
        for (let y = -r - 1; y <= r + 1; y++) {
          for (let x = -r - 1; x <= r + 1; x++) {
            const d = Math.hypot(x, y * 1.05);
            if (d > r + 0.5) continue;
            const edge = d > r - 0.5;
            const shade = x * 0.6 + y * 0.8 > r * 0.45;
            P(x, oy + y, edge ? outline : shade ? NX.snowShade : NX.snow);
          }
        }
      };
      // Shadow on the snow, then body and head.
      for (let x = -9; x <= 11; x++) P(x, 0, NX.snowShade);
      ball(-6, 6);
      ball(-18, 7.5);
      // Little feet.
      for (const fx of [-3, 2]) for (let x = 0; x < 3; x++) P(fx + x, -1, x === 0 || x === 2 ? outline : NX.snow);
      // Buttons.
      P(0, -8, coal);
      P(0, -5, coal);
      // Face: round shiny eyes, rosy cheeks, a little carrot and a small smile.
      const hy = -18;
      for (const ex of [-3, 2]) {
        P(ex, hy - 1, coal); P(ex + 1, hy - 1, coal);
        P(ex, hy, coal); P(ex + 1, hy, coal);
        P(ex + 1, hy - 1, [255, 255, 255]);
      }
      const pink = nxHex('#f3a6b6');
      P(-5, hy + 1, pink); P(-4, hy + 1, pink);
      P(4, hy + 1, pink); P(5, hy + 1, pink);
      const carrot = nxHex('#f08a24');
      P(0, hy + 1, carrot); P(1, hy + 1, carrot); P(2, hy + 1, nxHex('#d9701a'));
      for (const [x, y] of [[-1, 3], [0, 4], [1, 4], [2, 3]]) P(x, hy + y, coal);
      // Beanie: a small ribbed red cap with a white trim and pompom.
      const red = nxHex('#d8383f');
      const redDark = nxHex('#a92a33');
      for (let y = -9; y <= -6; y++) {
        const half = Math.round(Math.sqrt(Math.max(0, 1 - Math.pow((y + 5.5) / 4.5, 2))) * 6);
        for (let x = -half; x <= half; x++) P(x, hy + y, (x & 1) ? redDark : red);
      }
      for (let x = -6; x <= 6; x++) P(x, hy - 5, Math.abs(x) === 6 ? outline : NX.snow);
      for (let y = -12; y <= -10; y++) for (let x = -1; x <= 1; x++) if (Math.abs(x) + Math.abs(y + 11) < 3) P(x, hy + y, Math.abs(x) + Math.abs(y + 11) === 2 ? NX.snowShade : NX.snow);
      // Striped scarf around the neck, its tail hanging to one side.
      const green = nxHex('#3f8a4a');
      for (let x = -6; x <= 6; x++) { P(x, -11, (x + 6) % 4 < 2 ? red : green); P(x, -12, (x + 6) % 4 < 2 ? red : green); }
      for (let y = -10; y <= -6; y++) { P(3, y, y % 2 ? red : green); P(4, y, y % 2 ? red : green); }
      P(3, -5, redDark); P(4, -5, redDark);
      // Stick arms with mittens: the left one waves.
      const stick = nxHex('#5a3a24');
      for (let k = 0; k < 6; k++) P(-6 - k, -8 - k, stick);
      P(-9, -12, stick); P(-10, -10, stick);
      for (const [x, y] of [[-12, -14], [-13, -14], [-12, -15], [-13, -15]]) P(x, y, red);
      for (let k = 0; k < 6; k++) P(6 + k, -7 + Math.floor(k / 2), stick);
      P(9, -6, stick);
      for (const [x, y] of [[12, -4], [13, -4], [12, -5], [13, -5]]) P(x, y, red);
    };
    // Warm light from the ground-floor windows falling on the snow in front.
    const spill = (x0, w) => {
      const g = Math.round(Math.min(ground(x0), ground(x0 + w)));
      const warm = nxHex('#ffcf85');
      for (let y = g; y < g + PH * 0.05; y++) {
        const k = (y - g) / (PH * 0.05);
        for (let x = Math.round(x0 - k * w * 0.15); x <= x0 + w + k * w * 0.15; x++) if (nxB(x, y) < (1 - k) * 0.5) put(x, y, warm, 0.5);
      }
    };
    // A trodden path across the snow with footprints, winding toward the tree.
    const path = (x0, y0, x1, y1) => {
      const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
      for (let i = 0; i <= n; i++) {
        const k = i / n;
        const x = x0 + (x1 - x0) * k + Math.sin(k * 5) * PW * 0.02;
        const y = y0 + (y1 - y0) * k;
        const wdt = 1 + (1 - k) * PH * 0.02;
        for (let d = -wdt; d <= wdt; d++) if (nxB(Math.round(x + d), Math.round(y)) < 0.55) put(x + d, y, NX.snowShade, 0.7);
        if (i % 4 === 0) put(x + (i % 8 === 0 ? -1 : 1) * wdt * 0.4, y, NX.snowDeep);
      }
    };
    // Moonlight glinting off the snow: spots the frame makes sparkle.
    for (let i = 0; i < PW * 0.25; i++) {
      const x = H(i, 300) * PW;
      const y = ground(x) + 2 + H(i, 301) * (PH - ground(x) - 3);
      glints.push({ x, y, ph: H(i, 302) * 6, f: 0.6 + H(i, 303) * 1.5 });
    }
    const gl = (x) => Math.round(ground(x));
    if (wide) {
      path(PW * 0.45, PH - 1, PW * 0.78, gl(PW * 0.8) + 2);
      pool(PW * 0.28, gl(PW * 0.28) + PH * 0.04, PW * 0.08, PH * 0.06, 0.8);
      pool(PW * 0.56, gl(PW * 0.56) + PH * 0.035, PW * 0.07, PH * 0.05, 0.75);
      pool(PW * 0.85, gl(PW * 0.85) + PH * 0.04, PW * 0.14, PH * 0.08, 0.7);
      pool(PW * 0.09, gl(PW * 0.09) + PH * 0.04, PW * 0.09, PH * 0.05, 0.45);
      pool(PW * 0.68, gl(PW * 0.68) + PH * 0.04, PW * 0.08, PH * 0.05, 0.45);
      const by = Math.round(PH * 0.76);
      for (const [fx, fw, fh] of [[0.2, 0.06, 0.07], [0.34, 0.055, 0.06], [0.44, 0.06, 0.075], [0.66, 0.05, 0.06], [0.76, 0.06, 0.07]]) backHouse(Math.round(PW * fx), Math.round(Math.min(PW * fw, PH * 0.3)), Math.round(PH * fh), by);
      church(Math.round(PW * 0.52), Math.round(Math.min(PW * 0.07, PH * 0.35)), Math.round(PH * 0.09), by);
      for (const [fx, fh] of [[0.255, 0.16], [0.4, 0.12], [0.6, 0.14], [0.79, 0.18], [0.985, 0.2]]) snowPine(PW * fx, gl(PW * fx) + 1, PH * fh);
      spill(Math.round(PW * 0.03), Math.round(Math.min(PW * 0.11, PH * 0.55)));
      spill(Math.round(PW * 0.16), Math.round(Math.min(PW * 0.09, PH * 0.55)));
      spill(Math.round(PW * 0.62), Math.round(Math.min(PW * 0.11, PH * 0.55)));
      house(Math.round(PW * 0.03), Math.round(Math.min(PW * 0.11, PH * 0.55)), Math.round(PH * 0.16));
      house(Math.round(PW * 0.16), Math.round(Math.min(PW * 0.09, PH * 0.55)), Math.round(PH * 0.12));
      house(Math.round(PW * 0.62), Math.round(Math.min(PW * 0.11, PH * 0.55)), Math.round(PH * 0.15));
      lantern(Math.round(PW * 0.28), gl(PW * 0.28), Math.round(PH * 0.2));
      lantern(Math.round(PW * 0.56), gl(PW * 0.56), Math.round(PH * 0.17));
      const tr = tree(PW * 0.85, gl(PW * 0.85) + 2, PH * 0.5);
      if (PH >= 80) fence(0, PW * 0.24, Math.round(PH * 0.91));
      if (PH >= 80) snowman(PW * 0.3, PH * 0.96, PH * 0.3);
      branch(-2, PH * 0.02, 0.35, PW * 0.32, Math.max(3, PH * 0.025), 0);
      branch(-2, PH * 0.12, 0.15, PW * 0.22, Math.max(2, PH * 0.018), 1);
      branch(PW + 2, PH * 0.02, Math.PI - 0.25, PW * 0.2, Math.max(3, PH * 0.022), 0);
      return { img, over, lights, glows, star: tr, twinkles, chimneys, cones, glints, walk: [[PW * 0.41, PW * 0.55], [PW * 0.6, PW * 0.73]], keepOut: [[PW * 0.18, PW * 0.41], [PW * 0.74, PW * 1.02]], ground };
    }
    pool(PW * 0.72, gl(PW * 0.72) + PH * 0.03, PW * 0.3, PH * 0.05, 0.7);
    pool(PW * 0.42, gl(PW * 0.42) + PH * 0.03, PW * 0.18, PH * 0.04, 0.7);
    const by = Math.round(PH * 0.765);
    backHouse(Math.round(PW * 0.38), Math.round(PW * 0.14), Math.round(PH * 0.045), by);
    church(Math.round(PW * 0.55), Math.round(PW * 0.16), Math.round(PH * 0.06), by);
    for (const [fx, fh] of [[0.36, 0.09], [0.97, 0.12]]) snowPine(PW * fx, gl(PW * fx) + 1, PH * fh);
    path(PW * 0.5, PH - 1, PW * 0.68, gl(PW * 0.68) + 2);
    spill(Math.round(PW * 0.04), Math.round(Math.min(PW * 0.3, PH * 0.55)));
    house(Math.round(PW * 0.04), Math.round(Math.min(PW * 0.3, PH * 0.55)), Math.round(PH * 0.11));
    lantern(Math.round(PW * 0.42), gl(PW * 0.42), Math.round(PH * 0.14));
    const tr = tree(PW * 0.72, gl(PW * 0.72) + 2, PH * 0.38);
    if (PH >= 80) snowman(PW * 0.24, PH * 0.95, Math.min(PH * 0.22, PW * 0.42));
    branch(-2, PH * 0.02, 0.45, PW * 0.5, Math.max(2, PH * 0.015), 1);
    return { img, over, lights, glows, star: tr, twinkles, chimneys, cones, glints, walk: [[PW * 0.4, PW * 0.47]], keepOut: [[PW * 0.06, PW * 0.4], [PW * 0.5, PW * 1.02]], ground };
  }

  // Santa's sleigh and three reindeer, facing right, Rudolph in the lead. The
  // reindeer gallop on a four-step cycle and bob out of step with each other;
  // reins run from Santa's mitten through the team.
  const NX_DEER_TOP = [
    '..............a...a.....',
    '.............aAa.aAa....',
    '..............aAAAa.....',
    '...........oi..oooo.....',
    '...........oiobbbbbo....',
    '............obbbbebbo...',
    '............obbbbbbLno..',
    '..........oobbbbbbcco...',
    '.t..oooooobbbbbbccoo....',
    'tttobbbbbbbbbbhhcco.....',
    '.tobLLLLLbbbbHgHco......',
    '..obbbbbbbbbbbBBo.......',
    '..oBccccccccBBBBo.......',
    '...oBBBBBBBBBBBo........',
  ];
  const NX_DEER_LEGS = [
    ['..oBo.......oBo........', '.oBo.........oBo.......', 'oBo...........oBo......', 'kk.............kk......'],
    ['...oBo.....oBo.........', '...oBo.....oBo.........', '...oBo.....oBo.........', '...kk......kk..........'],
    ['....oBo...oBo..........', '.....oBooBo............', '......kkkk.............', '.......................'],
  ];
  const NX_SLEIGH = [
    '..............ww..................',
    '.............wRRo.................',
    '............oRRRRo................',
    '...........oRRRRRRo...............',
    '..........owwwwwwwwo..............',
    '..........owKKKKeKwo..............',
    '..........owwKKKKpKo..............',
    '...gGg....owwwwwwwwo..............',
    '..gGgGgqq.owwwwwwwoRRo..........ss',
    '..GGGGqqq.oRRwwwwRRRRmm........sYYs',
    '.oSSSqqqooRRRRwwRRRRRRo.......sY..s',
    'oSSSSSSSSoRRRkkykkRRRo.......sY.ss.',
    'oSSSSSSSSSSSSSSSSSSSSSSSS.....sYs..',
    'oSYYYYYYYYYYYYYYYYYYYYYSSSssssYs...',
    'oSYrrrrrrrrrrrrrrrrrrrYSSSSSSSs....',
    'oSYYYYYYYYYYYYYYYYYYYYYSSSSSSs.....',
    '.oSSSSSSSSSSSSSSSSSSSSSSSSSso......',
    '..ooooooooooooooooooooooooo........',
    '....d...........d........d.........',
    '.YYYYYYYYYYYYYYYYYYYYYYYYYYYYYY....',
    '..............................YY...',
    '.............................YY....',
  ];
  const NX_SANTA_PAL = {
    o: '#2a170e', b: '#8b5a33', B: '#6a4124', L: '#b07a4a', c: '#ead1a8', a: '#ecd8ae', A: '#b89d72',
    e: '#0d0806', n: '#2b1a12', h: '#b8262f', H: '#7e1820', g: '#f5c542', G: '#d8443c', t: '#f5efe4', k: '#1e120b', i: '#d79a8a',
    w: '#f7f7f7', R: '#d23a3a', K: '#f2c9a0', p: '#e98a8a', m: '#2f7a3e', y: '#f5c542',
    S: '#c22c2c', s: '#e8b84a', Y: '#e8b84a', r: '#9e1f22', q: '#2f8a4a', d: '#5a3a24',
  };
  const NX_GAIT = [0, 1, 2, 1];
  function nxTeam(c, P, x0, y0, u, t, noseOn, wave) {
    const px = (x, y, col) => {
      c.fillStyle = col;
      c.fillRect(Math.round(x0 + x * u) * P, Math.round(y0 + y * u) * P, u * P, u * P);
    };
    const sprite = (rows, ox, oy, red) =>
      rows.forEach((row, j) => {
        for (let i = 0; i < row.length; i++) {
          const ch = row[i];
          const col = ch === 'n' && red ? (noseOn ? '#ff3b30' : '#b8261f') : NX_SANTA_PAL[ch];
          if (col) px(ox + i, oy + j, col);
        }
      });
    const deer = [0, 1, 2].map((k) => ({ x: 36 + k * 24, y: -3 + Math.round(Math.sin(t * 9 + k * 1.7)), f: NX_GAIT[Math.floor(t * 9 + k) % 4] }));
    // Reins first, so the animals sit on top of them.
    const rein = (ax, ay, bx, by) => {
      const n = Math.ceil(Math.abs(bx - ax));
      for (let i = 0; i <= n; i++) {
        const k = i / n;
        px(ax + (bx - ax) * k, ay + (by - ay) * k + Math.sin(Math.PI * k) * 1.2, '#c9a477');
      }
    };
    rein(22, 9, deer[0].x + 14, deer[0].y + 9);
    for (let k = 0; k < 2; k++) rein(deer[k].x + 14, deer[k].y + 9, deer[k + 1].x + 14, deer[k + 1].y + 9);
    sprite(NX_SLEIGH, 0, 0, false);
    // Santa's free arm, raised to wave: two poses swapped quickly.
    if (wave) {
      const up = Math.floor(t * 7) % 2;
      const arm = up ? [[9, 8], [8, 7], [7, 6], [7, 5]] : [[9, 8], [9, 7], [9, 6], [10, 5]];
      arm.forEach(([x, y], i) => {
        px(x - 1, y, '#2a170e');
        px(x, y, i === 0 ? '#d23a3a' : i < 3 ? '#d23a3a' : '#2f7a3e');
      });
      const [hx, hy] = arm[3];
      px(hx, hy - 1, '#2f7a3e');
      px(hx + 1, hy, '#2f7a3e');
    }
    // A little lantern hanging from the sleigh's curled front.
    px(29, 7, '#2a170e');
    px(28, 8, '#b8862a');
    px(29, 8, '#b8862a');
    px(30, 8, '#b8862a');
    px(28, 9, '#b8862a');
    px(29, 9, '#ffe9a8');
    px(30, 9, '#b8862a');
    px(29, 10, '#b8862a');
    deer.forEach((d, k) => {
      sprite(NX_DEER_TOP, d.x, d.y, k === 2);
      sprite(NX_DEER_LEGS[d.f], d.x, d.y + 14, false);
    });
    return {
      nose: { x: deer[2].x + 21.5, y: deer[2].y + 6.5 },
      tail: { x: 2, y: 19.5 },
      sack: { x: 3, y: 9 },
      lantern: { x: 29.5, y: 9.5 },
      noses: deer.map((d) => ({ x: d.x + 22, y: d.y + 6 })),
      bells: deer.map((d) => ({ x: d.x + 14.5, y: d.y + 10.5 })),
    };
  }

  // Villagers out for an evening stroll, two walking frames each, facing right.
  const NX_WALKER = [
    ['.hh.', 'hhhh', '.ff.', 'sccs', '.cc.', '.cc.', '.cc.', 'l..l'],
    ['.hh.', 'hhhh', '.ff.', 'sccs', '.cc.', '.cc.', '.cc.', '.ll.'],
  ];

  // Two orientations of a six-armed snow crystal, 7 x 7.
  const NX_CRYSTAL = [
    ['...a...', '.a.a.a.', '..aaa..', 'aaaoaaa', '..aaa..', '.a.a.a.', '...a...'],
    ['a.....a', '.a.a.a.', '..aaa..', '.aaoaa.', '..aaa..', '.a.a.a.', 'a.....a'],
  ];

  THEMES.push({
    id: 'noel',
    name: 'Giáng sinh',
    dark: true,
    alias: ['noel', 'giang sinh', 'christmas', 'xmas', 'cay thong', 'tuyet', 'snow', 'mua dong', 'winter'],
    glyphs: '*+.',
    bg(c, w, h, W) {
      const s = W.s;
      const buf = document.createElement('canvas');
      buf.width = s.PW;
      buf.height = s.PH;
      const bx = buf.getContext('2d');
      const id = bx.createImageData(s.PW, s.PH);
      id.data.set(s.art.img);
      bx.putImageData(id, 0, 0);
      c.imageSmoothingEnabled = false;
      c.drawImage(buf, 0, 0, s.PW * s.P, s.PH * s.P);
      c.imageSmoothingEnabled = true;
    },
    over(W) {
      const s = W.s;
      const buf = document.createElement('canvas');
      buf.width = s.PW;
      buf.height = s.PH;
      const bx = buf.getContext('2d');
      const id = bx.createImageData(s.PW, s.PH);
      id.data.set(s.art.over);
      bx.putImageData(id, 0, 0);
      W.ctx.imageSmoothingEnabled = false;
      W.ctx.drawImage(buf, 0, 0, s.PW * s.P, s.PH * s.P);
      W.ctx.imageSmoothingEnabled = true;
    },
    init(w) {
      const s = w.s;
      s.P = w.cell >= 11 ? 4 : Math.max(1, Math.round(w.cell / 3));
      s.PW = Math.ceil(w.w / s.P);
      s.PH = Math.ceil(w.h / s.P);
      s.seed = rint(1, 9999);
      s.art = nxPaint(s.PW, s.PH, s.seed, s.PW >= 180);
      s.smoke = [];
      s.puff = 0;
      // Aurora on a coarse grid, drawn smoothed and additive.
      s.AW = Math.ceil(s.PW / 3);
      s.AH = Math.ceil((s.PH * 0.4) / 3);
      s.aur = document.createElement('canvas');
      s.aur.width = s.AW;
      s.aur.height = s.AH;
      s.aurCtx = s.aur.getContext('2d');
      s.aurImg = s.aurCtx.createImageData(s.AW, s.AH);
      s.meteor = { wait: rnd(4, 9), t: 0, x: 0, y: 0 };
      s.wind = { now: 1.2, target: 1.2, left: rnd(4, 8) };
      s.gifts = [];
      s.bursts = [];
      s.breath = [];
      s.bokeh = Array.from({ length: s.PW >= 180 ? 7 : 3 }, () => ({ x: rnd(0, s.PW), y: rnd(0, s.PH), r: rnd(2.5, 5), v: rnd(3, 6), ph: rnd(0, 6) }));
      s.walkers = s.art.walk.map(([a, b], i) => ({ a, b, x: rnd(a, b), dir: i % 2 ? -1 : 1, v: rnd(2.5, 4), coat: ['#b8323a', '#3b5fa8', '#2f7a4a'][i % 3] }));
      const n = Math.round(clamp((s.PW * s.PH) / 60, 40, 2000) * (cfg.density || 1));
      s.santa = { x: -115 * Math.max(1, Math.floor(Math.min(s.PH / 150, s.PW / 260))), wait: rnd(1, 2), sparks: [] };
      s.flakes = Array.from({ length: n }, () => ({
        x: rnd(0, s.PW),
        y: rnd(0, s.PH),
        z: Math.random(),
        ph: rnd(0, 6),
        vx: 0,
      }));
    },
    frame(w, dt) {
      const s = w.s;
      const t = w.t;
      const c = w.ctx;
      const P = s.P;
      const toCell = (v) => (v * P) / w.cell;
      const sp = cfg.speed || 1;

      // Aurora: slow curtains of green fading to violet, with drifting rays.
      {
        const A = s.aurImg.data;
        const AW = s.AW;
        const AH = s.AH;
        for (let x = 0; x < AW; x++) {
          const u = x / AW;
          const base = AH * (0.55 + 0.18 * Math.sin(u * 5 + t * 0.12) + 0.08 * Math.sin(u * 13 - t * 0.2));
          const ray = 0.45 + 0.55 * nxRay(x * 0.35 + t * 0.6, s.seed);
          const edge = Math.min(1, u * 6, (1 - u) * 6);
          for (let y = 0; y < AH; y++) {
            const d = (base - y) / (AH * 0.5);
            let a = 0;
            if (d > -0.08 && d < 1) a = (d < 0 ? 1 + d / 0.08 : Math.pow(1 - d, 1.6)) * ray * edge;
            const i = (y * AW + x) * 4;
            const k = Math.max(0, Math.min(1, d));
            A[i] = 60 + 90 * k;
            A[i + 1] = 255 - 150 * k;
            A[i + 2] = 170 + 60 * k;
            A[i + 3] = a * 170;
          }
        }
        s.aurCtx.putImageData(s.aurImg, 0, 0);
        c.save();
        c.globalCompositeOperation = 'lighter';
        c.globalAlpha = 0.7 + 0.15 * Math.sin(t * 0.3);
        c.imageSmoothingEnabled = true;
        c.drawImage(s.aur, 0, 0, s.AW * 3 * P, s.AH * 3 * P);
        c.restore();
      }

      // Now and then a shooting star.
      const mt = s.meteor;
      if (mt.wait > 0) {
        mt.wait -= dt;
        if (mt.wait <= 0) {
          mt.t = 0;
          mt.x = rnd(s.PW * 0.15, s.PW * 0.7);
          mt.y = rnd(s.PH * 0.03, s.PH * 0.15);
        }
      } else {
        mt.t += dt;
        const k = mt.t / 0.9;
        for (let i = 0; i < 14; i++) {
          const q = Math.max(0, k * 1.4 - i * 0.03);
          c.globalAlpha = Math.max(0, (1 - i / 14) * (1 - k));
          c.fillStyle = i < 2 ? '#ffffff' : '#cfe0ff';
          c.fillRect(Math.round(mt.x + q * s.PW * 0.25) * P, Math.round(mt.y + q * s.PH * 0.1) * P, P, P);
        }
        c.globalAlpha = 1;
        if (k >= 1) mt.wait = rnd(8, 20);
      }

      // Warm light: windows, lanterns, the star and the glow around the tree.
      for (const g of s.art.glows) {
        const flick = g.moon ? 0 : g.lamp ? 0.06 * Math.sin(t * 3 + g.x) : g.star ? 0.15 * Math.sin(t * 1.7) : 0.04 * Math.sin(t * 2.3 + g.y);
        w.glow(toCell(g.x) - 0.5, toCell(g.y) - 0.5, toCell(g.r), g.c, g.a + flick);
      }

      // Slow rays turning around the star on the tree.
      if (s.art.star) {
        const st = s.art.star;
        const sx = st.x;
        const sy = st.tipY - st.r * 0.6;
        c.fillStyle = '#ffe9a8';
        for (let k = 0; k < 8; k++) {
          const ang = t * 0.25 + (k * Math.PI) / 4;
          const len = st.r * (k % 2 ? 2.2 : 3.4);
          for (let d = st.r * 1.1; d < len; d += 1) {
            c.globalAlpha = 0.5 * (1 - d / len);
            c.fillRect(Math.round(sx + Math.cos(ang) * d) * P, Math.round(sy + Math.sin(ang) * d) * P, P, P);
          }
        }
        c.globalAlpha = 1;
      }

      // Moonlight glinting on the snow.
      for (const g of s.art.glints) {
        const v = Math.sin(t * g.f + g.ph);
        if (v < 0.75) continue;
        const a = (v - 0.75) * 4;
        c.globalAlpha = a;
        c.fillStyle = '#ffffff';
        c.fillRect(Math.round(g.x) * P, Math.round(g.y) * P, P, P);
        if (a > 0.6) {
          c.globalAlpha = a * 0.5;
          c.fillRect(Math.round(g.x - 1) * P, Math.round(g.y) * P, P, P);
          c.fillRect(Math.round(g.x + 1) * P, Math.round(g.y) * P, P, P);
        }
      }
      c.globalAlpha = 1;

      // Villagers strolling along the street, a little lantern in hand.
      for (const v of s.walkers) {
        v.x += v.dir * v.v * dt * sp;
        if (v.x > v.b) v.dir = -1;
        if (v.x < v.a) v.dir = 1;
        const g = s.art.ground ? s.art.ground(v.x) : s.PH * 0.8;
        const frameW = NX_WALKER[Math.floor(t * 4 + v.a) % 2];
        const pal = { h: '#3a2a24', f: '#f2c9a0', s: '#e8e8f0', c: v.coat, l: '#1e1a22' };
        const x0 = Math.round(v.x);
        const y0 = Math.round(g - frameW.length + 1);
        frameW.forEach((row, j) => {
          for (let i = 0; i < row.length; i++) {
            const col = pal[row[i]];
            if (!col) continue;
            c.fillStyle = col;
            c.fillRect((v.dir > 0 ? x0 + i : x0 + 3 - i) * P, (y0 + j) * P, P, P);
          }
        });
        const lx = v.dir > 0 ? x0 + 4 : x0 - 1;
        c.fillStyle = '#ffd27a';
        c.fillRect(lx * P, (y0 + 5) * P, P, P);
        w.glow(toCell(lx) - 0.5, toCell(y0 + 5) - 0.5, toCell(3), '#ffc861', 0.4 + 0.1 * Math.sin(t * 6 + v.a));
      }

      // A few stars twinkle.
      c.fillStyle = '#ffffff';
      for (const st of s.art.twinkles) {
        const v = Math.max(0, Math.sin(t * st.f + st.ph));
        if (v < 0.2) continue;
        c.globalAlpha = v;
        c.fillRect(Math.round(st.x) * P, Math.round(st.y) * P, P, P);
        if (v > 0.85) {
          c.globalAlpha = (v - 0.85) * 4;
          c.fillRect(Math.round(st.x - 1) * P, Math.round(st.y) * P, P, P);
          c.fillRect(Math.round(st.x + 1) * P, Math.round(st.y) * P, P, P);
          c.fillRect(Math.round(st.x) * P, Math.round(st.y - 1) * P, P, P);
          c.fillRect(Math.round(st.x) * P, Math.round(st.y + 1) * P, P, P);
        }
      }
      c.globalAlpha = 1;

      // Chimney smoke drifting up into the cold air.
      s.puff = (s.puff || 0) - dt;
      if (s.puff <= 0) {
        s.puff = 0.5;
        for (const ch of s.art.chimneys) s.smoke.push({ x: ch.x, y: ch.y, age: 0, life: rnd(3.5, 5.5), wob: rnd(0, 6) });
      }
      for (const p of s.smoke) {
        p.age += dt;
        p.y -= dt * 2.6;
        p.x += dt * (0.8 + Math.sin(t * 0.7 + p.wob) * 0.5 + p.age * 0.3);
        const k = p.age / p.life;
        w.glow(toCell(p.x) - 0.5, toCell(p.y) - 0.5, toCell(1.5 + k * 4), '#c7d1ea', 0.5 * (1 - k));
      }
      s.smoke = s.smoke.filter((p) => p.age < p.life);

      // Twinkling bulbs: each fades on its own beat; the big ones get a halo.
      for (const l of s.art.lights) {
        const v = 0.5 + 0.5 * Math.sin(t * (l.fairy ? 2.2 : 3.1) + l.ph);
        const on = v > 0.25;
        c.globalAlpha = on ? 0.7 + 0.3 * v : 0.3;
        c.fillStyle = l.c;
        c.fillRect(Math.round(l.x) * P, Math.round(l.y) * P, P, P);
        if (on && v > 0.45) w.glow(toCell(l.x) - 0.5, toCell(l.y) - 0.5, toCell(l.big ? 3 : 2.4), l.c, (l.big ? 0.4 : 0.32) * v);
      }
      c.globalAlpha = 1;

      // Santa crosses the sky now and then: he waves (more so when the pointer
      // is near), drops presents on little parachutes, the reindeer puff
      // breath in the cold, and a trail of golden dust and stars follows.
      const sa = s.santa;
      const u = Math.max(1, Math.floor(Math.min(s.PH / 150, s.PW / 260)));
      const ground = s.art.ground || (() => s.PH * 0.8);
      if (sa.wait > 0) sa.wait -= dt;
      else {
        sa.x += dt * s.PW * 0.05 * sp;
        const y = s.PH * 0.14 + Math.sin(sa.x * 0.025) * s.PH * 0.035;
        for (const k of sa.sparks) {
          k.age += dt;
          k.y += dt * 3;
          k.x -= dt * 2;
          c.globalAlpha = Math.max(0, 1 - k.age / 2.2);
          c.fillStyle = k.age < 0.4 ? '#fffbe0' : k.age < 1 ? '#ffe07a' : '#e8b84a';
          const X = Math.round(k.x);
          const Y = Math.round(k.y);
          c.fillRect(X * P, Y * P, P, P);
          if (k.star && k.age < 1.2) {
            c.fillRect((X - 1) * P, Y * P, P, P);
            c.fillRect((X + 1) * P, Y * P, P, P);
            c.fillRect(X * P, (Y - 1) * P, P, P);
            c.fillRect(X * P, (Y + 1) * P, P, P);
          }
        }
        c.globalAlpha = 1;
        const near = m0 => m0 && m0.active && Math.hypot((m0.x * w.cell) / P - (sa.x + 15 * u), (m0.y * w.cell) / P - (y + 8 * u)) < 40 * u;
        const waving = near(w.mouse) || t % 6 < 1.8;
        const at = nxTeam(c, P, sa.x, y, u, t, Math.sin(t * 5) > -0.3, waving);
        if (Math.random() < dt * 45) sa.sparks.push({ x: sa.x + rnd(-1, 3) * u, y: y + at.tail.y * u + rnd(-2, 1) * u, age: 0, star: Math.random() < 0.15 });
        w.glow(toCell(sa.x + at.nose.x * u) - 0.5, toCell(y + at.nose.y * u) - 0.5, toCell(3 * u), '#ff3b30', 0.5 + 0.25 * Math.sin(t * 5));
        w.glow(toCell(sa.x + at.lantern.x * u) - 0.5, toCell(y + at.lantern.y * u) - 0.5, toCell(4 * u), '#ffc861', 0.5 + 0.1 * Math.sin(t * 7));
        // Bells catch the light now and then.
        for (const bl of at.bells) if (Math.sin(t * 3 + bl.x) > 0.96) w.glow(toCell(sa.x + bl.x * u) - 0.5, toCell(y + bl.y * u) - 0.5, toCell(2 * u), '#fff4c2', 0.7);
        // Breath from each reindeer's nose, left behind in the cold air.
        sa.breathT = (sa.breathT || 0) - dt;
        if (sa.breathT <= 0) {
          sa.breathT = 0.35;
          for (const n of at.noses) s.breath.push({ x: sa.x + n.x * u, y: y + n.y * u, age: 0 });
        }
        // Presents, one every few seconds while he is over the village.
        sa.giftT = (sa.giftT || rnd(1, 2)) - dt;
        const dropX = sa.x + at.sack.x * u;
        const clear = !(s.art.keepOut || []).some(([a, b]) => dropX > a - 3 && dropX < b + 3);
        if (sa.giftT <= 0 && clear && dropX > s.PW * 0.03) {
          sa.giftT = near(w.mouse) ? 0.8 : rnd(2.2, 3.6);
          s.gifts.push({ x: dropX, y: y + at.sack.y * u, vy: 0, age: 0, ph: rnd(0, 6), box: pick(['#c8323a', '#2f7a4a', '#f2c14e', '#4a6fc4']), rib: pick(['#f2c14e', '#ffffff', '#c8323a']) });
        }
        if (sa.x > s.PW + 10) {
          sa.x = -115 * u;
          sa.wait = rnd(14, 26);
          sa.sparks = [];
        }
      }
      sa.sparks = sa.sparks.filter((k) => k.age < 2.2);
      for (const b of s.breath) {
        b.age += dt;
        b.x -= dt * 1.5;
        b.y -= dt * 0.8;
        w.glow(toCell(b.x) - 0.5, toCell(b.y) - 0.5, toCell(1 + b.age * 3), '#eef3fb', 0.45 * (1 - b.age / 0.9));
      }
      s.breath = s.breath.filter((b) => b.age < 0.9);
      // Falling presents: a short drop, then the parachute opens and they sway down.
      for (const g of s.gifts) {
        g.age += dt;
        const open = g.age > 0.45;
        // Free fall at first, then the canopy slows it to a gentle drift.
        g.vy = open ? g.vy + (5 - g.vy) * Math.min(1, dt * 4) : g.vy + dt * 30;
        g.y += g.vy * dt;
        const sway = open ? Math.sin(g.age * 2 + g.ph) * 1.6 : 0;
        const X = Math.round(g.x + sway);
        const Y = Math.round(g.y);
        if (open) {
          // Canopy in red and white stripes, with two lines to the box.
          const can = ['.rwr.', 'rwrwr'];
          can.forEach((row, j) => {
            for (let i = 0; i < row.length; i++) {
              if (row[i] === '.') continue;
              c.fillStyle = row[i] === 'r' ? '#d23a3a' : '#f6f6f6';
              c.fillRect((X - 2 + i) * P, (Y - 5 + j) * P, P, P);
            }
          });
          c.fillStyle = '#dfe6f2';
          c.fillRect((X - 2) * P, (Y - 3) * P, P, P);
          c.fillRect((X + 2) * P, (Y - 3) * P, P, P);
          c.fillRect((X - 1) * P, (Y - 2) * P, P, P);
          c.fillRect((X + 1) * P, (Y - 2) * P, P, P);
        }
        for (let j = 0; j < 3; j++) {
          for (let i = 0; i < 3; i++) {
            c.fillStyle = i === 1 || j === 1 ? g.rib : g.box;
            c.fillRect((X - 1 + i) * P, (Y - 1 + j) * P, P, P);
          }
        }
        if (g.y >= ground(g.x) - 1) {
          g.done = true;
          for (let k = 0; k < 10; k++) {
            const a = (k / 10) * Math.PI * 2;
            s.bursts.push({ x: X, y: Y, vx: Math.cos(a) * rnd(6, 12), vy: Math.sin(a) * rnd(6, 12) - 4, age: 0 });
          }
        }
      }
      s.gifts = s.gifts.filter((g) => !g.done && g.y < s.PH + 5);
      // Sparkles where a present lands.
      for (const b of s.bursts) {
        b.age += dt;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.vy += dt * 20;
        c.globalAlpha = Math.max(0, 1 - b.age / 0.8);
        c.fillStyle = b.age < 0.3 ? '#ffffff' : '#ffe07a';
        c.fillRect(Math.round(b.x) * P, Math.round(b.y) * P, P, P);
      }
      c.globalAlpha = 1;
      s.bursts = s.bursts.filter((b) => b.age < 0.8);

      // Wind: calm most of the time, with a gust every few seconds.
      const wd = s.wind;
      wd.left -= dt;
      if (wd.left <= 0) {
        wd.target = Math.random() < 0.35 ? rnd(5, 9) : rnd(0.6, 1.8);
        wd.left = wd.target > 4 ? rnd(2, 3.5) : rnd(6, 12);
      }
      wd.now += (wd.target - wd.now) * Math.min(1, dt * 0.8);

      // Snow in four depths: far specks, mid flakes, near flakes and, closest,
      // six-armed crystals that turn as they fall. The pointer makes them swirl.
      const m = w.mouse;
      const mx = m && m.active ? (m.x * w.cell) / P : -999;
      const my = m && m.active ? (m.y * w.cell) / P : -999;
      const rad = Math.max(10, s.PH * 0.11);
      for (const f of s.flakes) {
        const layer = f.z < 0.45 ? 0 : f.z < 0.85 ? 1 : f.z < 0.965 ? 2 : 3;
        const v = (3 + f.z * 10) * sp;
        f.y += v * dt;
        f.x += (Math.sin(t * 0.8 + f.ph) * (1 + f.z * 2) + wd.now * (0.4 + f.z) + f.vx) * dt;
        const dx = f.x - mx;
        const dy = f.y - my;
        const d = Math.hypot(dx, dy);
        if (d < rad && d > 0.01) {
          const k = (1 - d / rad) * 55;
          // Push outward and around, so the snow whirls about the pointer.
          f.vx += ((dx / d) * 0.6 - (dy / d) * 0.9) * k * dt;
          f.y += ((dy / d) * 0.4 + (dx / d) * 0.7) * k * dt;
        }
        f.vx *= Math.pow(0.2, dt);
        if (f.y > s.PH + 4) {
          f.y = -4;
          f.x = rnd(-20, s.PW);
        }
        if (f.x > s.PW + 4) f.x -= s.PW + 8;
        if (f.x < -6) f.x += s.PW + 8;
        let lit = false;
        for (const cn of s.art.cones) {
          if (f.y < cn.top || f.y > cn.bottom) continue;
          const half = 1 + cn.spread * ((f.y - cn.top) / (cn.bottom - cn.top));
          if (Math.abs(f.x - cn.x) < half) {
            lit = true;
            break;
          }
        }
        const X = Math.round(f.x);
        const Y = Math.round(f.y);
        if (layer === 3) {
          // A crystal: two orientations swapped as it turns, catching the light now and then.
          const art = NX_CRYSTAL[Math.floor(t * 2.2 + f.ph) % 2];
          const glint = Math.max(0, Math.sin(t * 1.3 + f.ph * 3)) > 0.93;
          c.globalAlpha = lit || glint ? 1 : 0.85;
          for (let j = 0; j < art.length; j++) {
            for (let i = 0; i < art[j].length; i++) {
              const ch = art[j][i];
              if (ch === '.') continue;
              c.fillStyle = ch === 'o' ? '#ffffff' : lit ? '#ffe7b8' : glint ? '#ffffff' : '#dbe8ff';
              c.fillRect((X + i - 3) * P, (Y + j - 3) * P, P, P);
            }
          }
          if (lit || glint) w.glow(toCell(X) - 0.5, toCell(Y) - 0.5, toCell(4), lit ? '#ffd27a' : '#ffffff', 0.35);
          continue;
        }
        c.globalAlpha = lit ? 1 : [0.35, 0.65, 0.95][layer];
        c.fillStyle = lit ? '#ffe7b8' : layer === 0 ? '#c9d6f0' : '#ffffff';
        if (layer === 2) {
          // A soft round flake: a plus of four pixels around a bright centre.
          c.fillRect(X * P, (Y - 1) * P, P, P);
          c.fillRect((X - 1) * P, Y * P, P * 3, P);
          c.fillRect(X * P, (Y + 1) * P, P, P);
        } else c.fillRect(X * P, Y * P, P, P);
      }
      c.globalAlpha = 1;

      // A few big, out-of-focus flakes drifting close to the viewer.
      for (const b of s.bokeh) {
        b.y += b.v * dt * sp;
        b.x += (Math.sin(t * 0.5 + b.ph) * 2 + 1) * dt;
        if (b.y > s.PH + 8) {
          b.y = -8;
          b.x = rnd(0, s.PW);
        }
        w.glow(toCell(b.x) - 0.5, toCell(b.y) - 0.5, toCell(b.r), '#ffffff', 0.22);
      }
    },
  });

  const ITEMS = THEMES.map((t) => t.id).concat('off');
  const byId = (id) => THEMES.find((t) => t.id === id);

  /* --------------------------------------------------------------- settings */

  const KEY = 'pixel-themes:v1';
  const cfg = { theme: 'vn', veil: 0.2, glass: 0.72, motion: true, button: true, density: 1.0, speed: 1.0, autoCycle: false };
  try {
    Object.assign(cfg, JSON.parse(localStorage.getItem(KEY) || '{}'));
  } catch (e) {
    /* storage blocked: keep defaults */
  }
  if (!ITEMS.includes(cfg.theme)) cfg.theme = 'vn';
  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(cfg));
    } catch (e) {
      /* ignore */
    }
  };

  /* ----------------------------------------------------------------- styles */

  const PAGE_CSS = `
html[data-pxt-on], html[data-pxt-on] body { background-color: transparent !important; background-image: none !important; }
html[data-pxt-on] [data-pxt="clear"] { background-color: transparent !important; background-image: none !important; }
html[data-pxt-on] [data-pxt="glass"] {
  background-color: rgba(var(--pxt-rgb), var(--pxt-alpha, .72)) !important;
  background-image: none !important;
  -webkit-backdrop-filter: blur(var(--pxt-blur, 12px)) saturate(1.35);
  backdrop-filter: blur(var(--pxt-blur, 12px)) saturate(1.35);
}
canvas[data-pxt-ui="bg"] { position: fixed !important; top: 0 !important; left: 0 !important; width: 100% !important; height: 100% !important; z-index: -1 !important; pointer-events: none !important; display: none; }
html[data-pxt-on] canvas[data-pxt-ui="bg"] { display: block !important; }
`;

  const UI_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
.fab {
  position: fixed; right: 12px; top: 50%; transform: translateY(-50%); z-index: 2147483000;
  width: 36px; height: 36px; padding: 0; border-radius: 10px; cursor: pointer;
  border: 1px solid rgba(255,255,255,.4); background: rgba(24,24,28,.35);
  -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
  display: grid; grid-template-columns: repeat(3, 6px); grid-auto-rows: 6px; gap: 2px; place-content: center;
  opacity: .6; transition: opacity .2s;
}
.fab:hover, .fab:focus-visible { opacity: 1; }
.fab i { display: block; border-radius: 1.5px; }
.panel {
  position: fixed; left: 50%; transform: translateX(-50%); z-index: 2147483001;
  width: min(760px, calc(100vw - 20px)); padding: 10px 10px 8px; border-radius: 14px;
  color: #1d1d1f; background: rgba(255,255,255,.88); border: 1px solid rgba(0,0,0,.08);
  box-shadow: 0 12px 40px rgba(0,0,0,.2);
  -webkit-backdrop-filter: blur(18px) saturate(1.4); backdrop-filter: blur(18px) saturate(1.4);
  font: 12px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
.panel.dark { color: #f2f2f2; background: rgba(30,30,32,.88); border-color: rgba(255,255,255,.1); }
.hd { display: flex; align-items: center; gap: 10px; padding: 0 4px 8px; }
.cmd { font: 600 11px/1 ui-monospace, Menlo, Consolas, monospace; padding: 4px 6px; border-radius: 5px; background: rgba(127,127,127,.18); }
.ttl { opacity: .7; }
.hint { margin-left: auto; opacity: .55; font-size: 11px; white-space: nowrap; }
.note { padding: 0 4px 6px; font-size: 11px; opacity: .7; }
.list { position: relative; display: flex; flex-wrap: wrap; gap: 10px 8px; max-height: min(52vh, 420px); overflow-y: auto; padding: 3px 3px 8px; scrollbar-width: thin; }
.it { flex: 0 0 auto; width: 84px; padding: 0; border: 0; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.th { display: block; width: 84px; height: 54px; border-radius: 8px; overflow: hidden; outline: 2px solid transparent; outline-offset: 1px; background: rgba(127,127,127,.2); }
.th canvas { display: block; width: 100%; height: 100%; }
.it:hover .th { outline-color: rgba(47,124,246,.45); }
.it.sel .th { outline-color: #2f7cf6; }
.nm { display: block; margin-top: 4px; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.it.cur .nm::after { content: " \\2713"; color: #2f7cf6; }
.off { display: grid; place-items: center; height: 100%; font-weight: 600; letter-spacing: .08em; opacity: .7;
  background: repeating-linear-gradient(45deg, rgba(127,127,127,.22) 0 6px, transparent 6px 12px); }
.ctl { display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: center; padding: 8px 4px 0; border-top: 1px solid rgba(127,127,127,.2); }
.ctl label { display: flex; align-items: center; gap: 6px; font-size: 11px; opacity: .85; cursor: pointer; }
.ctl input[type=range] { width: 96px; accent-color: #2f7cf6; }
.ctl input[type=checkbox] { accent-color: #2f7cf6; }
@media (pointer: coarse) {
  .hint { display: none; }
  .fab { width: 42px; height: 42px; grid-template-columns: repeat(3, 7px); grid-auto-rows: 7px; }
  .it, .th { width: 92px; }
  .th { height: 60px; }
  .ctl input[type=range] { width: 120px; }
}
`;

  function sheet(css, target) {
    try {
      const s = new CSSStyleSheet();
      s.replaceSync(css);
      target.adoptedStyleSheets = [...target.adoptedStyleSheets, s];
      return;
    } catch (e) {
      /* older browser: fall back to a <style> element */
    }
    const el = document.createElement('style');
    el.textContent = css;
    (target === document ? document.head || document.documentElement : target).appendChild(el);
  }

  /* ---------------------------------------------------- background scanner */

  const probe = document.createElement('canvas');
  probe.width = probe.height = 1;
  const pctx = probe.getContext('2d', { willReadFrequently: true });
  const colors = new Map();

  // Any CSS color (rgb, hsl, oklch, ...) -> {r, g, b, a}.
  function toRGBA(s) {
    if (!s || s === 'transparent') return null;
    if (colors.has(s)) return colors.get(s);
    let v = null;
    const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(s);
    if (m) {
      v = { r: +m[1], g: +m[2], b: +m[3], a: m[4] == null ? 1 : m[5] ? m[4] / 100 : +m[4] };
    } else {
      pctx.fillStyle = '#010203';
      pctx.fillStyle = s;
      if (pctx.fillStyle !== '#010203') {
        pctx.clearRect(0, 0, 1, 1);
        pctx.fillRect(0, 0, 1, 1);
        const d = pctx.getImageData(0, 0, 1, 1).data;
        v = { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
      }
    }
    if (colors.size > 500) colors.clear();
    colors.set(s, v);
    return v;
  }

  const lum = (c) => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;

  // Saturated colors are buttons / badges: leave them alone.
  function accent(c) {
    const r = c.r / 255;
    const g = c.g / 255;
    const b = c.b / 255;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const l = (mx + mn) / 2;
    const d = mx - mn;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    return s > 0.4 && l > 0.18 && l < 0.85;
  }

  const SKIP = /^(IMG|VIDEO|CANVAS|SVG|IFRAME|PICTURE|INPUT|SELECT|OPTION|SCRIPT|STYLE|LINK|META|HEAD|BR|HR|PATH|G|USE|HTML|BODY)$/i;
  const UI_SEL = 'button, a, label, [role="button"], [role="menuitem"], [role="option"], [role="tab"]';
  const OVERLAY_SEL = 'dialog, [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [aria-modal="true"], [data-radix-popper-content-wrapper]';

  const glassColor = new WeakMap();

  function mark(el, kind, c) {
    if (kind === 'glass') {
      glassColor.set(el, c);
      el.style.setProperty('--pxt-rgb', `${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}`);
    }
    el.setAttribute('data-pxt', kind);
  }

  function classify(el, vw, vh, area) {
    if (el.nodeType !== 1 || el.hasAttribute('data-pxt') || el.hasAttribute('data-pxt-ui') || SKIP.test(el.tagName)) return;
    const cs = getComputedStyle(el);
    // Inline boxes (code chips, highlights) keep their look: a blurred inline box
    // that wraps across lines would blur the text next to it.
    if (cs.display === 'none' || cs.display === 'inline' || cs.display === 'contents' || cs.visibility === 'hidden') return;
    const img = cs.backgroundImage;
    const grad = img !== 'none' && /gradient/.test(img);
    if (img !== 'none' && !grad) return;
    const c = toRGBA(cs.backgroundColor);
    const solid = c && c.a >= 0.6;
    if (!solid && !grad) return;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    const ratio = (Math.min(r.width, vw) * Math.min(r.height, vh)) / area;
    const ui = el.matches(UI_SEL);
    // Drawers, popovers and modals float above other content, so they need glass, not a hole.
    const floating = el.closest(OVERLAY_SEL) || ((cs.position === 'fixed' || cs.position === 'absolute') && cs.zIndex !== 'auto' && ratio < 0.95);

    if (ratio >= 0.4 && !floating) return mark(el, 'clear');
    if (!solid) {
      // Fade gradients (e.g. above the composer) would paint a band of solid color.
      if (!ui && ratio >= 0.02) mark(el, 'clear');
      return;
    }
    if (ratio < 0.0015 || accent(c) || (ui && ratio < 0.03)) return;
    const outer = el.parentElement && el.parentElement.closest('[data-pxt="glass"]');
    if (outer) {
      // Same-colored wrapper inside a glass panel: drop it so the alpha doesn't stack.
      const o = glassColor.get(outer);
      if (!o || Math.abs(o.r - c.r) + Math.abs(o.g - c.g) + Math.abs(o.b - c.b) < 24) return mark(el, 'clear');
      if (ratio < 0.02) return;
    }
    mark(el, 'glass', c);
  }

  // The veil and the picker follow the page's light/dark mode, read from its text color.
  function computeDark() {
    const els = document.body ? document.body.querySelectorAll('p, li, h1, h2, h3, button, a') : [];
    let n = 0;
    let light = 0;
    for (const el of els) {
      if (n >= 24) break;
      if (!el.textContent.trim()) continue;
      const c = toRGBA(getComputedStyle(el).color);
      if (!c || c.a < 0.3) continue;
      n++;
      if (lum(c) > 0.55) light++;
    }
    if (!n) {
      const c = document.body && toRGBA(getComputedStyle(document.body).color);
      return c ? lum(c) > 0.55 : matchMedia('(prefers-color-scheme: dark)').matches;
    }
    return light / n > 0.5;
  }

  let scanning = false;
  let sampleTimer = 0;
  let flushTimer = 0;
  const deepQ = new Set();
  const shallowQ = new Set();

  const mo = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'childList') {
        for (const n of m.addedNodes) if (n.nodeType === 1) deepQ.add(n);
      } else if (m.target.nodeType === 1 && !m.target.hasAttribute('data-pxt')) {
        shallowQ.add(m.target);
      }
    }
    if (!flushTimer) flushTimer = setTimeout(flush, 250);
  });

  function flush() {
    flushTimer = 0;
    const vw = innerWidth;
    const vh = innerHeight;
    const area = vw * vh;
    let budget = 3000;
    for (const el of deepQ) {
      if (!el.isConnected) continue;
      classify(el, vw, vh, area);
      const all = el.getElementsByTagName('*');
      for (let i = 0; i < all.length && budget > 0; i++, budget--) classify(all[i], vw, vh, area);
    }
    for (const el of shallowQ) if (el.isConnected) classify(el, vw, vh, area);
    deepQ.clear();
    shallowQ.clear();
  }

  function fullScan() {
    const all = document.body.getElementsByTagName('*');
    const vw = innerWidth;
    const vh = innerHeight;
    const area = vw * vh;
    let i = 0;
    (function chunk() {
      if (!scanning) return;
      const end = Math.min(all.length, i + 600);
      for (; i < end; i++) classify(all[i], vw, vh, area);
      if (i < all.length && i < 20000) setTimeout(chunk, 16);
    })();
  }

  // Catches elements that were hidden during the first scan and shown later.
  function sample() {
    if (document.hidden) return;
    const vw = innerWidth;
    const vh = innerHeight;
    const area = vw * vh;
    const seen = new Set();
    for (let i = 1; i < 7; i++) {
      for (let j = 1; j < 9; j++) {
        const stack = document.elementsFromPoint((i / 7) * vw, (j / 9) * vh);
        for (let k = stack.length - 1; k >= 0; k--) {
          if (seen.has(stack[k])) continue;
          seen.add(stack[k]);
          classify(stack[k], vw, vh, area);
        }
      }
    }
    const d = computeDark();
    if (d !== siteDark) {
      siteDark = d;
      syncPanel();
      if (!raf) paint(0);
    }
  }

  function startScan() {
    if (scanning) return;
    scanning = true;
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    fullScan();
    sampleTimer = setInterval(sample, 3000);
    setTimeout(sample, 600);
  }

  function stopScan() {
    if (!scanning) return;
    scanning = false;
    mo.disconnect();
    clearInterval(sampleTimer);
    clearTimeout(flushTimer);
    flushTimer = 0;
    deepQ.clear();
    shallowQ.clear();
  }

  /* --------------------------------------------------------------- renderer */

  const root = document.documentElement;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const FPS = matchMedia('(pointer: coarse)').matches ? 10 : 12;
  let siteDark = false;
  let canvas = null;
  let world = null;
  let curId = 'off';
  let raf = 0;
  let last = 0;

  function measure() {
    const w = canvas.clientWidth || innerWidth;
    const h = canvas.clientHeight || innerHeight;
    const cell = Math.min(w, h) < 560 ? 11 : 14;
    // Keep the backing store under ~6M pixels on big screens.
    const dpr = clamp(Math.min(devicePixelRatio || 1, 2, Math.sqrt(6e6 / (w * h))), 1, 2);
    return { w, h, cell, dpr };
  }

  function ensureCanvas() {
    if (canvas && canvas.isConnected) return;
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.setAttribute('data-pxt-ui', 'bg');
      canvas.setAttribute('aria-hidden', 'true');
      world = new World(canvas);
      if (window.ResizeObserver) new ResizeObserver(onResize).observe(canvas);
      addEventListener('resize', onResize);
    }
    root.appendChild(canvas);
  }

  let resizeTimer = 0;
  function onResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resizeNow, 120);
  }

  function resizeNow() {
    if (!world || !world.th || curId === 'off') return;
    const m = measure();
    if (Math.abs(m.w - world.w) < 1 && Math.abs(m.h - world.h) < 1 && m.dpr === world.dpr) return;
    const { cols, rows, cell } = world;
    world.resize(m.w, m.h, m.cell, m.dpr);
    // Small changes (mobile toolbars) keep the scene; big ones rebuild it.
    if (m.cell !== cell || Math.abs(world.cols - cols) / cols > 0.25 || Math.abs(world.rows - rows) / rows > 0.25) world.setTheme(world.th);
    paint(0);
    if (open) place();
  }

  let mouse = { x: -999, y: -999, vx: 0, vy: 0, last: 0, active: false };
  window.addEventListener(
    'pointermove',
    (e) => {
      const now = performance.now();
      const dt = Math.max(0.016, (now - (mouse.last || now)) / 1000);
      const nx = e.clientX;
      const ny = e.clientY;
      if (mouse.last && dt > 0) {
        mouse.vx = clamp((nx - mouse.x) / dt / 30, -10, 10);
        mouse.vy = clamp((ny - mouse.y) / dt / 30, -10, 10);
      }
      mouse.x = nx;
      mouse.y = ny;
      mouse.last = now;
      mouse.active = true;
    },
    { passive: true },
  );

  function paint(dt) {
    if (!world || !world.th) return;
    world.veilColor = siteDark ? '#141413' : '#fbfaf6';
    world.veil = clamp(cfg.veil * (world.th.veilScale || 1) + (world.th.dark === siteDark ? 0 : 0.42), 0, 0.9);
    const now = performance.now();
    world.mouse = {
      x: mouse.x / world.cell,
      y: mouse.y / world.cell,
      vx: mouse.vx || 0,
      vy: mouse.vy || 0,
      active: mouse.active && now - mouse.last < 800,
    };
    mouse.vx *= 0.85;
    mouse.vy *= 0.85;
    world.draw(dt);
  }

  const running = () => curId !== 'off' && cfg.motion && !reduce.matches && !document.hidden;

  function loop(now) {
    raf = 0;
    if (!running()) return;
    raf = requestAnimationFrame(loop);
    if (last && now - last < 1000 / FPS - 2) return;
    const dt = last ? Math.min(0.2, (now - last) / 1000) : 1 / FPS;
    last = now;
    paint(dt);
  }

  function startLoop() {
    if (!raf && running()) {
      last = 0;
      raf = requestAnimationFrame(loop);
    }
  }

  function stopLoop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  document.addEventListener('visibilitychange', () => (document.hidden ? stopLoop() : startLoop()));

  function applyTheme(id) {
    const th = byId(id);
    if (!th) {
      root.removeAttribute('data-pxt-on');
      stopLoop();
      stopScan();
      curId = 'off';
      syncPanel();
      return;
    }
    ensureCanvas();
    root.setAttribute('data-pxt-on', '');
    root.style.setProperty('--pxt-alpha', String(cfg.glass));
    root.style.setProperty('--pxt-blur', cfg.glass >= 0.95 ? '0px' : '12px');
    siteDark = computeDark();
    const m = measure();
    if (m.w !== world.w || m.h !== world.h || m.dpr !== world.dpr || m.cell !== world.cell) world.resize(m.w, m.h, m.cell, m.dpr);
    if (curId !== id) {
      world.setTheme(th);
      curId = id;
    }
    syncPanel();
    startScan();
    paint(0);
    startLoop();
  }

  /* --------------------------------------------------------------------- UI */

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const k in props || {}) {
      const v = props[k];
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else if (v != null && v !== false) el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid);
    return el;
  }

  const FAB_COLORS = ['#86c3f2', '#ffffff', '#d97757', '#34b6c4', '#ff8fc8', '#d9ff6e', '#b49cff', '#fff2c7', '#ff7b2e'];

  let host = null;
  let fab = null;
  let panel = null;
  let note = null;
  let list = null;
  let items = [];
  let open = false;
  let fromCmd = false;
  let editor = null;
  let anchor = null;
  let sel = 0;

  function thumb(th) {
    const cv = document.createElement('canvas');
    const w = new World(cv);
    w.resize(92, 60, 4, 2);
    w.setTheme(th);
    w.draw(0.5);
    w.draw(0.5);
    return cv;
  }

  function buildUI() {
    host = h('div', { 'data-pxt-ui': 'host' });
    const sh = host.attachShadow({ mode: 'open' });
    sheet(UI_CSS, sh);

    fab = h(
      'button',
      { class: 'fab', type: 'button', title: 'Pixel themes  (/theme · Alt+T)', 'aria-label': 'Đổi hình nền pixel', onclick: () => (open ? closePicker(false) : openPicker(null, false)) },
      FAB_COLORS.map((c) => {
        const i = h('i');
        i.style.setProperty('background', c);
        return i;
      }),
    );
    fab.hidden = !cfg.button;

    panel = h('div', { class: 'panel', role: 'dialog', 'aria-label': 'Chọn hình nền pixel', hidden: true });
    sh.append(fab, panel);
    root.appendChild(host);
  }

  function buildPanel() {
    list = h('div', { class: 'list', role: 'listbox', 'aria-label': 'Themes' });
    items = ITEMS.map((id, i) => {
      const th = byId(id);
      const btn = h(
        'button',
        {
          class: 'it',
          type: 'button',
          role: 'option',
          onclick: () => {
            sel = i;
            commit(id);
            if (fromCmd) {
              fromCmd = false;
              clearEditor(editor);
            }
          },
        },
        h('span', { class: 'th' }, th ? thumb(th) : h('span', { class: 'off' }, 'OFF')),
        h('span', { class: 'nm' }, th ? th.name : 'Tắt'),
      );
      list.append(btn);
      return btn;
    });

    const range = (label, min, max, key, after) =>
      h(
        'label',
        null,
        label,
        h('input', {
          type: 'range',
          min,
          max,
          step: '0.05',
          value: String(cfg[key]),
          oninput: (e) => {
            cfg[key] = +e.target.value;
            save();
            after();
          },
        }),
      );
    const check = (label, key, after) =>
      h(
        'label',
        null,
        h('input', {
          type: 'checkbox',
          checked: cfg[key],
          onchange: (e) => {
            cfg[key] = e.target.checked;
            save();
            after();
          },
        }),
        label,
      );

    note = h('div', { class: 'note', hidden: true });
    panel.append(
      h('div', { class: 'hd' }, h('span', { class: 'cmd' }, '/theme'), h('span', { class: 'ttl' }, 'Pixel wallpapers'), h('span', { class: 'hint' }, '← → chọn · ↵ áp dụng · esc đóng')),
      note,
      list,
      h(
        'div',
        { class: 'ctl' },
        range('Làm dịu nền', '0', '0.8', 'veil', () => {
          if (!raf) paint(0);
        }),
        range('Độ đục khung', '0.3', '0.95', 'glass', () => {
          root.style.setProperty('--pxt-alpha', String(cfg.glass));
          root.style.setProperty('--pxt-blur', cfg.glass >= 0.95 ? '0px' : '12px');
        }),
        range('Mật độ', '0.5', '2.0', 'density', () => {
          if (world && world.th && world.th.init) world.th.init(world);
          if (!raf) paint(0);
        }),
        range('Tốc độ', '0.5', '2.0', 'speed', () => {}),
        check('Chuyển động', 'motion', () => {
          if (cfg.motion) startLoop();
          else stopLoop();
        }),
        check('Tự đổi ngày/đêm', 'autoCycle', () => {
          checkAutoCycle(true);
        }),
        check('Nút nổi', 'button', () => {
          fab.hidden = !cfg.button;
        }),
      ),
    );
  }

  function syncPanel() {
    if (!panel) return;
    panel.classList.toggle('dark', siteDark);
    if (!note) return;
    const th = byId(curId);
    note.hidden = !th || th.dark === siteDark;
    note.textContent = th && th.dark ? 'Theme tối: bật giao diện Dark của trang để màu rõ hơn.' : 'Theme sáng: hợp với giao diện Light của trang hơn.';
  }

  function highlight() {
    syncPanel();
    items.forEach((b, i) => {
      b.classList.toggle('sel', i === sel);
      b.classList.toggle('cur', ITEMS[i] === cfg.theme);
      b.setAttribute('aria-selected', String(i === sel));
    });
    // The grid wraps; on a short screen it scrolls vertically to keep the selection in view.
    const b = items[sel];
    if (b && list) {
      const T = b.offsetTop;
      const B = T + b.offsetHeight;
      if (T < list.scrollTop) list.scrollTop = T - 4;
      else if (B > list.scrollTop + list.clientHeight) list.scrollTop = B - list.clientHeight + 4;
    }
  }

  function place() {
    const a = anchor && anchor.isConnected ? (anchor.closest('fieldset, form') || anchor).getBoundingClientRect() : null;
    const ph = panel.offsetHeight;
    const pw = panel.offsetWidth;
    const vh = innerHeight;
    const vw = document.documentElement.clientWidth || innerWidth;
    let top = vh - ph - 96;
    if (a && a.top - ph - 10 > 8) top = a.top - ph - 10;
    else if (a && a.bottom + ph + 10 < vh) top = a.bottom + 10;
    panel.style.setProperty('top', Math.max(8, top) + 'px');
    panel.style.setProperty('left', clamp(a ? a.left + a.width / 2 : vw / 2, pw / 2 + 10, vw - pw / 2 - 10) + 'px');
  }

  function openPicker(anchorEl, cmd) {
    if (!items.length) buildPanel();
    open = true;
    fromCmd = !!cmd;
    anchor = anchorEl;
    sel = Math.max(0, ITEMS.indexOf(cfg.theme));
    panel.hidden = false;
    highlight();
    place();
  }

  function closePicker(keep) {
    if (!open) return;
    if (!keep && curId !== cfg.theme) applyTheme(cfg.theme);
    open = false;
    fromCmd = false;
    anchor = null;
    panel.hidden = true;
  }

  function move(d) {
    sel = (sel + d + ITEMS.length) % ITEMS.length;
    applyTheme(ITEMS[sel]); // live preview, saved only on Enter / click
    highlight();
  }

  function commit(id) {
    cfg.theme = id;
    save();
    applyTheme(id);
    if (open) highlight();
  }

  function findTheme(q) {
    q = strip(q);
    if (!q) return -1;
    if (/^(off|tat|none|0)$/.test(q)) return ITEMS.indexOf('off');
    const exact = THEMES.findIndex((t) => t.id === q || strip(t.name) === q || t.alias.includes(q));
    if (exact >= 0) return exact;
    return THEMES.findIndex((t) => t.id.startsWith(q) || strip(t.name).includes(q) || t.alias.some((a) => a.startsWith(q)));
  }

  /* ------------------------------------------------------- /theme command */

  // "/thêm" and "/nen" are there because Vietnamese Telex keyboards turn "theme" into "thêm".
  const CMD = /^\/(theme|thêm|them|nen|nền)(?:\s+(.*))?$/iu;

  function editableRoot(t) {
    if (!t || t.nodeType !== 1) return null;
    if (t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && /^(text|search)$/i.test(t.type))) return t;
    return t.closest('[contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]');
  }

  const textOf = (el) => (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' ? el.value : el.innerText || '');

  function clearEditor(el) {
    if (!el || !el.isConnected) return;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(range);
    if (!document.execCommand('delete', false)) el.textContent = '';
  }

  function runCommand(text) {
    const m = CMD.exec(String(text).normalize('NFC').trim());
    if (!m) return false;
    const i = m[2] ? findTheme(m[2]) : -1;
    if (i >= 0) commit(ITEMS[i]);
    else openPicker(null, false);
    return true;
  }

  document.addEventListener(
    'input',
    (e) => {
      const el = editableRoot(e.target);
      if (!el || (host && host.contains(el))) return;
      const m = CMD.exec(textOf(el).normalize('NFC').trim());
      if (m) {
        editor = el;
        if (!open) openPicker(el, true);
        fromCmd = true;
        const i = m[2] ? findTheme(m[2]) : -1;
        if (i >= 0 && i !== sel) {
          sel = i;
          applyTheme(ITEMS[i]);
          highlight();
        }
      } else if (open && fromCmd) {
        closePicker(false);
      }
    },
    true,
  );

  addEventListener(
    'keydown',
    (e) => {
      if (e.altKey && e.shiftKey && (e.code === 'ArrowRight' || e.key === 'ArrowRight')) {
        e.preventDefault();
        const curIdx = Math.max(0, ITEMS.indexOf(cfg.theme));
        const nextIdx = (curIdx + 1) % ITEMS.length;
        commit(ITEMS[nextIdx]);
        return;
      }
      if (e.altKey && e.shiftKey && (e.code === 'ArrowLeft' || e.key === 'ArrowLeft')) {
        e.preventDefault();
        const curIdx = Math.max(0, ITEMS.indexOf(cfg.theme));
        const prevIdx = (curIdx - 1 + ITEMS.length) % ITEMS.length;
        commit(ITEMS[prevIdx]);
        return;
      }
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyT') {
        e.preventDefault();
        if (open) closePicker(false);
        else openPicker(editableRoot(document.activeElement), false);
        return;
      }
      if (!open || e.isComposing) return;
      const target = e.composedPath()[0];
      if (target && target.tagName === 'INPUT' && target.type === 'range') return;
      // Opened from the button while the user types elsewhere: only Esc belongs to us.
      if (!fromCmd && editableRoot(document.activeElement) && e.key !== 'Escape') return;
      const stop = () => {
        e.preventDefault();
        e.stopImmediatePropagation();
      };
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        stop();
        move(e.key === 'ArrowRight' ? 1 : -1);
      } else if (e.key === 'Enter' && !e.shiftKey) {
        stop();
        const wasCmd = fromCmd;
        commit(ITEMS[sel]);
        closePicker(true);
        if (wasCmd) clearEditor(editor);
      } else if (e.key === 'Escape') {
        stop();
        closePicker(false);
      }
    },
    true,
  );

  document.addEventListener(
    'pointerdown',
    (e) => {
      if (open && !e.composedPath().includes(host) && !(fromCmd && e.composedPath().includes(editor))) closePicker(false);
    },
    true,
  );

  addEventListener('resize', () => open && place());
  if (window.visualViewport) visualViewport.addEventListener('resize', () => open && place());
  reduce.addEventListener && reduce.addEventListener('change', () => (running() ? startLoop() : (stopLoop(), paint(0))));

  /* ------------------------------------------------------------------- boot */

  window.__pixelThemes = {
    themes: ITEMS.slice(),
    get current() {
      return cfg.theme;
    },
    set(id) {
      if (!ITEMS.includes(id)) return false;
      commit(id);
      return true;
    },
    open: () => openPicker(null, false),
    close: () => closePicker(true),
    command: runCommand,
  };

  function checkAutoCycle(force) {
    if (!cfg.autoCycle) return;
    const hr = new Date().getHours();
    const isDay = hr >= 6 && hr < 18;
    const target = isDay ? 'sakura' : 'hoian';
    if (cfg.theme !== target || force) {
      commit(target);
    }
  }

  function boot() {
    if (!document.body) {
      setTimeout(boot, 50);
      return;
    }
    sheet(PAGE_CSS, document);
    buildUI();
    if (cfg.autoCycle) checkAutoCycle();
    applyTheme(cfg.theme);
    setInterval(checkAutoCycle, 60000);
    say('✅ Pixel Themes đã chạy. Bấm Alt+T (hoặc nút ô vuông màu ở cạnh phải) để chọn theme.');
  }

  boot();
})();
