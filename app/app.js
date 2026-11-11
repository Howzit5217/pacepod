'use strict';
/*
 * PacePod on the web, for iPhones (and computers): the Android app's pill, full screen, reading the phone's GPS
 * speed while the page is open. iPhones don't let anything float over other apps, and Safari stops GPS once you
 * switch away, so here the pill is the whole page, and the page keeps the screen on while it's open.
 *
 * Ported from the Android app: the pill's look (PillView.kt), the colour zones and number formatting
 * (SpeedFormat.kt), the speed alerts and when they ring (AlertRules and Buzzer in Alerts.kt) and the Speed and Speed
 * alerts settings. Settings stay on this device; the location never leaves it.
 */

// ---- Speeds and how they show (SpeedFormat.kt). Speeds are kept in mph. ----

const MPS_TO_MPH = 2.2369363;
const KMH_PER_MPH = 1.609344;
/** Slower than this (m/s) is standing still: GPS drift, not movement. */
const MIN_MOVING_MPS = 0.45;
const SCALE = [1, 10, 100];
/** The number only moves on once the speed is this many steps past it, so a boundary doesn't flicker. */
const HOLD_STEPS = 0.65;
const SLOW_FROM_MIN_MPH = 0.5;
/** "Speed up below" stays at least this far under the top speed. */
const SLOW_GAP_MPH = 2;
/** The slow zone is at least this wide. */
const MIN_ZONE_MPH = 0.5;
const MAX_SHOWN = 99.9;
const MPH_COUNTRIES = ['US', 'PR', 'GU', 'VI', 'AS', 'MP', 'GB', 'LR', 'MM'];

const Zone = { OK: 'ok', NEAR: 'near', OVER: 'over', SLOW: 'slow' };

const mphOf = (mps) => (mps < MIN_MOVING_MPS ? 0 : mps * MPS_TO_MPH);
const shown = (mph, kmh) => (kmh ? mph * KMH_PER_MPH : mph);
const toMph = (value, kmh) => (kmh ? value / KMH_PER_MPH : value);
const unitName = (kmh) => (kmh ? 'km/h' : 'mph');
const tenths = (v) => Math.round(v * 10) / 10;

function text(value, decimals) {
  const d = Math.max(0, Math.min(2, decimals));
  const t = Math.round(value * SCALE[d]);
  if (d === 0) return String(t);
  return Math.floor(t / SCALE[d]) + '.' + String(t % SCALE[d]).padStart(d, '0');
}

/** "20" or "20.3". */
function limitText(limit) {
  const t = Math.round(limit * 10);
  return t % 10 === 0 ? String(t / 10) : Math.floor(t / 10) + '.' + (t % 10);
}

function steady(value, held, decimals) {
  const scale = SCALE[decimals];
  const rounded = Math.round(value * scale) / scale;
  if (Number.isNaN(held) || rounded === 0) return rounded;
  return Math.abs(value - held) < HOLD_STEPS / scale ? held : rounded;
}

/** Yellow from the warning point, red past the top speed, yellow too in the slow zone. */
function zoneOf(mph, s) {
  if (s.limit > 0 && mph > s.limit) return Zone.OVER;
  if (s.limit > 0 && mph >= (s.limit * s.warnPercent) / 100) return Zone.NEAR;
  if (s.slowBelow > 0 && mph < s.slowBelow && mph >= slowFrom(s)) return Zone.SLOW;
  return Zone.OK;
}

/** The highest "speed up below" allowed, in the unit shown, rounded down to the tenth. */
function slowCap(limit, kmh) {
  if (limit <= 0) return MAX_SHOWN;
  const cap = shown(limit - SLOW_GAP_MPH, kmh);
  return cap <= 0 ? 0 : Math.min(Math.floor(cap * 10 + 1e-3) / 10, MAX_SHOWN);
}

/** Where the slow zone starts (mph): half of "up to" until it's set, and always under it. */
function slowFrom(s) {
  const from = s.slowFrom < 0 ? s.slowBelow * 0.5 : s.slowFrom;
  return Math.min(Math.max(from, SLOW_FROM_MIN_MPH), Math.max(SLOW_FROM_MIN_MPH, s.slowBelow - MIN_ZONE_MPH));
}

// ---- Settings, kept on this device. ----

const CAN_BUZZ = typeof navigator.vibrate === 'function';
const STORE = 'pacepod.settings';

function regionUsesMph() {
  const lang = (navigator.languages && navigator.languages[0]) || navigator.language || 'en-US';
  const region = lang.split('-')[1];
  return !region || MPH_COUNTRIES.includes(region.toUpperCase());
}

const settings = Object.assign(
  {
    limit: 0,
    warnPercent: 95,
    kmh: !regionUsesMph(),
    decimals: 1,
    alerts: false,
    alertWith: CAN_BUZZ ? 'both' : 'sound',
    fastSound: 0,
    slowSound: 0,
    atYellow: false,
    slowBelow: 0,
    slowFrom: -1,
  },
  (() => {
    try {
      return JSON.parse(localStorage.getItem(STORE)) || {};
    } catch (e) {
      return {};
    }
  })(),
);
if (!CAN_BUZZ) settings.alertWith = 'sound';

function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify(settings));
  } catch (e) {
    // Private browsing: settings just last as long as the page.
  }
  pill.configure();
  alerts.applySettings();
  showSettings();
}

// ---- The pill (PillView.kt): green glass, a white gauge badge, the speed, the top-speed bubble. ----

const rgb = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
const css = (c, a = 1) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;
const mixRgb = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function palette(body, rim, ring, gauge, track, accent, shadow, shadowAlpha) {
  return {
    body: body.map(rgb),
    rim: rgb(rim),
    ring: rgb(ring),
    gauge: rgb(gauge),
    track: rgb(track),
    accent: rgb(accent),
    shadow: rgb(shadow),
    shadowAlpha,
  };
}

// The game's green glass (the map behind it taken out), and the same glass in amber and red.
const GREEN = palette(
  [0x2d7f4f, 0x2a784a, 0x1f5f3a, 0x165a38, 0x135b3a, 0x1a7454, 0x1e8160, 0x19906e, 0x23a274, 0x2ab57c],
  0x52d18f, 0xa6e8c1, 0x23995a, 0xd3eedd, 0x0d5c31, 0x062a17, 0.55,
);
const YELLOW = palette(
  [0xc9a030, 0xc49a1e, 0xb78a0c, 0xae8208, 0xad8107, 0xbd920c, 0xcea214, 0xdeb21c, 0xedc12a, 0xf9d23e],
  0xffde70, 0xffe9a6, 0xf2b300, 0xfbebb8, 0x8a5a00, 0x442c00, 0.6,
);
const RED = palette(
  [0xba4a4a, 0xb44646, 0x922626, 0x841e1e, 0x821c1c, 0x9a2828, 0xb03434, 0xc84040, 0xda4e4e, 0xee6262],
  0xff8a8a, 0xffc4bf, 0xe23b3b, 0xf9d2ce, 0x7e1414, 0x460808, 0.6,
);
const PALETTE_FOR = { ok: GREEN, near: YELLOW, slow: YELLOW, over: RED };

const BODY_STOPS = [0, 0.08, 0.32, 0.42, 0.55, 0.67, 0.77, 0.86, 0.92, 1];
const BODY_ALPHA = [0.8, 0.78, 0.82, 0.92, 0.95, 0.92, 0.86, 0.8, 0.82, 0.9];
const RIM_STOPS = [0, 0.35, 0.75, 1];
const RIM_RAMP = [0, 0, 0.75, 1];
const GLOSS_STOPS = [0, 0.22, 0.39, 0.55, 0.75, 1];
const GLOSS_ALPHA = [0.42, 0.48, 0.36, 0.22, 0.09, 0];
const WHITE = [255, 255, 255];
const ICON_EDGE = rgb(0xeaf7ef);
const NEEDLE = rgb(0xf2546a);
const NEEDLE_DIM = rgb(0xa9b5ae);
const BAND_WARN = rgb(0xfad772);
const BAND_OVER = rgb(0xf6a49c);
const BADGE_TINT = rgb(0xa0afaa);
const WARN_TINT = rgb(0xffc04a);
const LIMIT_AT = 1 / 1.2;
const START = (150 * Math.PI) / 180;
const SWEEP = (240 * Math.PI) / 180;
const GAUGE_MPH = 30;
const SAMPLES = ['88', '88.8', '88.88'];
const FONT = 'Nunito, "SF Pro Rounded", ui-rounded, system-ui, sans-serif';
const RECOLOR_MS = 450;

class Pill {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.number = '--';
    this.needle = 0;
    this.zone = Zone.OK;
    this.dim = true;
    this.warn = false;
    this.from = GREEN;
    this.to = GREEN;
    this.blendAt = -Infinity;
  }

  /** Picks up the unit, decimals and top speed, and sizes the pill to fit the screen. */
  configure() {
    this.unit = unitName(settings.kmh);
    this.decimals = settings.decimals;
    this.limit = settings.limit > 0 ? limitText(shown(settings.limit, settings.kmh)) : null;
    this.warnRatio = settings.warnPercent / 100;
    this.fit();
  }

  fit() {
    // Everything scales with the height, so lay out once at the app's 38 and scale to the room there is.
    const at38 = this.layout(38);
    const room = Math.min(window.innerWidth * 0.92, 640);
    const tall = Math.min(window.innerHeight * 0.34, 190);
    this.layout(Math.max(24, Math.min(38 * (room / at38.width), 38 * (tall / at38.height))));
    const dpr = window.devicePixelRatio || 1;
    this.canvas.style.width = this.cssW + 'px';
    this.canvas.style.height = this.cssH + 'px';
    this.canvas.width = Math.ceil(this.cssW * dpr);
    this.canvas.height = Math.ceil(this.cssH * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  layout(h) {
    const c = this.ctx;
    const s = h / 38;
    this.h = h;
    this.s = s;
    this.margin = 4 * s;
    this.inset = 3.2 * s;
    this.iconR = h / 2 - this.inset;
    this.gap = 6 * s;
    this.unitGap = 3.5 * s;
    this.badgeR = h * 0.33;
    this.numSize = h * 0.54;
    this.unitSize = h * 0.31;
    c.font = `800 ${this.numSize}px ${FONT}`;
    this.slot = Math.max(c.measureText(SAMPLES[this.decimals]).width, c.measureText(this.number).width);
    const eight = c.measureText('8');
    const capHeight = eight.actualBoundingBoxAscent || this.numSize * 0.7;
    c.font = `800 ${this.unitSize}px ${FONT}`;
    this.unitW = c.measureText(this.unit).width;
    const badge = this.warn || this.limit != null;
    this.right = badge ? this.badgeR * 1.05 + 2 * s : h * 0.4;
    this.w = this.inset + this.iconR * 2 + this.gap + this.slot + this.unitGap + this.unitW + this.right;
    this.baseline = this.margin + h / 2 + capHeight / 2;
    this.overX = badge ? this.badgeR * 0.9 + 2 * s : 0;
    this.overY = badge ? this.badgeR * 0.85 + 2 * s : 0;
    this.cssW = this.margin * 2 + this.w + this.overX;
    this.cssH = this.margin * 2 + h + this.overY;
    return { width: this.cssW, height: this.cssH };
  }

  /** [needle] is 0..1 around the gauge. */
  setReading(number, needle, zone, dim) {
    if (zone !== this.zone) {
      this.from = this.current();
      this.to = PALETTE_FOR[zone];
      this.blendAt = performance.now();
      if (zone === Zone.OVER) this.bounce();
      loop.wake();
    }
    const grew = number.length > this.number.length;
    this.number = number;
    this.needle = Math.max(0, Math.min(1, needle));
    this.zone = zone;
    this.dim = dim;
    if (grew) this.fit();
  }

  setWarn(warn) {
    if (warn === this.warn) return;
    this.warn = warn;
    if (warn) {
      this.number = '--';
      this.dim = true;
    }
    this.fit();
  }

  /** Still fading from one colour to the next. */
  get recolouring() {
    return performance.now() - this.blendAt < RECOLOR_MS;
  }

  current() {
    const t = Math.min(1, (performance.now() - this.blendAt) / RECOLOR_MS);
    if (t >= 1) return this.to;
    const e = 0.5 - Math.cos(t * Math.PI) / 2; // ease in and out
    const a = this.from;
    const b = this.to;
    return {
      body: a.body.map((c, i) => mixRgb(c, b.body[i], e)),
      rim: mixRgb(a.rim, b.rim, e),
      ring: mixRgb(a.ring, b.ring, e),
      gauge: mixRgb(a.gauge, b.gauge, e),
      track: mixRgb(a.track, b.track, e),
      accent: mixRgb(a.accent, b.accent, e),
      shadow: mixRgb(a.shadow, b.shadow, e),
      shadowAlpha: a.shadowAlpha + (b.shadowAlpha - a.shadowAlpha) * e,
    };
  }

  /** A quick squash and spring, when you go past your top speed. */
  bounce() {
    if (!this.canvas.animate) return;
    this.canvas.animate(
      [{ transform: 'scale(1)' }, { transform: 'scale(1.07)', offset: 0.28 }, { transform: 'scale(1)' }],
      { duration: 390, easing: 'ease-out' },
    );
  }

  pillPath(x, y, w, h) {
    const c = this.ctx;
    const r = h / 2;
    c.beginPath();
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y);
    c.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2);
    c.lineTo(x + r, y + h);
    c.arc(x + r, y + r, r, Math.PI / 2, (3 * Math.PI) / 2);
    c.closePath();
  }

  draw() {
    const c = this.ctx;
    const p = this.current();
    const { h, s, margin, w, iconR } = this;
    const top = margin;
    c.clearRect(0, 0, this.cssW, this.cssH);

    // The glass: tinted body, a glow rising from the lower edge, a wash of light over the top third and a fine line
    // of light around the edge.
    const body = c.createLinearGradient(0, top, 0, top + h);
    BODY_STOPS.forEach((at, i) => body.addColorStop(at, css(p.body[i], BODY_ALPHA[i])));
    this.pillPath(margin, top, w, h);
    c.fillStyle = body;
    c.fill();
    c.save();
    this.pillPath(margin, top, w, h);
    c.clip();
    const rim = c.createLinearGradient(0, top, 0, top + h);
    RIM_STOPS.forEach((at, i) => rim.addColorStop(at, css(p.rim, 0.6 * RIM_RAMP[i])));
    c.lineWidth = h * 0.07;
    c.strokeStyle = rim;
    this.pillPath(margin, top, w, h);
    c.stroke();
    const gloss = c.createLinearGradient(0, top, 0, top + h * 0.36);
    GLOSS_STOPS.forEach((at, i) => gloss.addColorStop(at, css(WHITE, GLOSS_ALPHA[i])));
    c.fillStyle = gloss;
    c.fillRect(margin, top, w, h * 0.36);
    const edge = c.createLinearGradient(0, top, 0, top + h);
    edge.addColorStop(0, css(WHITE, 0.35));
    edge.addColorStop(0.5, css(p.rim, 0.12));
    edge.addColorStop(1, css(p.rim, 0.5));
    c.lineWidth = h * 0.06;
    c.strokeStyle = edge;
    this.pillPath(margin, top, w, h);
    c.stroke();
    c.restore();

    // The white badge and its dial: yellow from the warning point to the top speed, red beyond it.
    const cx = margin + this.inset + iconR;
    const cy = top + h / 2;
    const face = c.createRadialGradient(cx - iconR * 0.3, cy - iconR * 0.35, 0, cx - iconR * 0.3, cy - iconR * 0.35, iconR * 1.4);
    face.addColorStop(0, css(WHITE));
    face.addColorStop(1, css(ICON_EDGE));
    c.fillStyle = face;
    c.beginPath();
    c.arc(cx, cy, iconR, 0, Math.PI * 2);
    c.fill();
    c.lineWidth = 2.2 * s;
    c.strokeStyle = css(p.ring);
    c.beginPath();
    c.arc(cx, cy, iconR - c.lineWidth / 2, 0, Math.PI * 2);
    c.stroke();

    const gr = iconR * 0.54;
    const gy = cy + iconR * 0.07;
    const band = iconR * 0.17;
    const arc = (from, sweep, colour, cap) => {
      c.lineWidth = band;
      c.lineCap = cap;
      c.strokeStyle = css(colour);
      c.beginPath();
      c.arc(cx, gy, gr, from, from + sweep);
      c.stroke();
    };
    if (this.limit != null) {
      const warnA = SWEEP * LIMIT_AT * this.warnRatio;
      const limitA = SWEEP * LIMIT_AT;
      arc(START, limitA, p.track, 'round');
      arc(START + warnA, limitA - warnA, BAND_WARN, 'butt');
      arc(START + limitA, SWEEP - limitA, BAND_OVER, 'butt');
      c.fillStyle = css(BAND_OVER);
      c.beginPath();
      c.arc(cx + Math.cos(START + SWEEP) * gr, gy + Math.sin(START + SWEEP) * gr, band / 2, 0, Math.PI * 2);
      c.fill();
    } else {
      arc(START, SWEEP, p.track, 'round');
    }

    // The working speedometer on the badge: the arc fills with speed and the needle sweeps to it.
    if (this.needle > 0.004) arc(START, SWEEP * this.needle, this.dim ? NEEDLE_DIM : p.gauge, 'round');
    if (this.limit != null) {
      const a = START + SWEEP * LIMIT_AT;
      c.lineWidth = iconR * 0.08;
      c.lineCap = 'round';
      c.strokeStyle = css(p.accent);
      c.beginPath();
      c.moveTo(cx + Math.cos(a) * (gr - band), gy + Math.sin(a) * (gr - band));
      c.lineTo(cx + Math.cos(a) * (gr + band), gy + Math.sin(a) * (gr + band));
      c.stroke();
    }
    const needleColour = this.dim ? NEEDLE_DIM : this.zone === Zone.OVER ? p.accent : NEEDLE;
    const na = START + SWEEP * this.needle;
    c.lineWidth = iconR * 0.15;
    c.lineCap = 'round';
    c.strokeStyle = css(needleColour);
    c.beginPath();
    c.moveTo(cx, gy);
    c.lineTo(cx + Math.cos(na) * gr * 0.8, gy + Math.sin(na) * gr * 0.8);
    c.stroke();
    c.fillStyle = css(needleColour);
    c.beginPath();
    c.arc(cx, gy, iconR * 0.14, 0, Math.PI * 2);
    c.fill();

    // "18.4 mph", centred between the badge and the bubble.
    const ax = cx + iconR + this.gap;
    const bx = margin + w - this.right;
    const x0 = ax + (bx - ax - (this.slot + this.unitGap + this.unitW)) / 2;
    c.save();
    c.shadowColor = css(p.shadow, p.shadowAlpha);
    c.shadowBlur = 1.4 * s * 2;
    c.shadowOffsetY = 1.1 * s;
    c.textBaseline = 'alphabetic';
    c.font = `800 ${this.numSize}px ${FONT}`;
    c.textAlign = 'right';
    c.fillStyle = this.dim ? css(WHITE, 0.55) : css(WHITE);
    c.fillText(this.number, x0 + this.slot, this.baseline);
    c.font = `800 ${this.unitSize}px ${FONT}`;
    c.textAlign = 'left';
    c.fillStyle = this.dim ? css(WHITE, 0.5) : css(WHITE, 0.92);
    c.fillText(this.unit, x0 + this.slot + this.unitGap, this.baseline);
    c.restore();

    // The top-speed bubble (or "GPS" while there's no GPS).
    const label = this.warn ? 'GPS' : this.limit;
    if (label != null) {
      const R = this.badgeR;
      const bcx = margin + w - R * 0.1;
      const bcy = top + h - R * 0.15;
      const tint = this.warn ? WARN_TINT : BADGE_TINT;
      const glass = c.createRadialGradient(bcx, bcy, 0, bcx, bcy, R);
      glass.addColorStop(0, css(tint, 0.84));
      glass.addColorStop(0.45, css(tint, 0.9));
      glass.addColorStop(1, css(tint, 0.94));
      c.fillStyle = glass;
      c.beginPath();
      c.arc(bcx, bcy, R, 0, Math.PI * 2);
      c.fill();
      const shine = c.createRadialGradient(bcx - R * 0.35, bcy - R * 0.45, 0, bcx - R * 0.35, bcy - R * 0.45, R * 0.55);
      shine.addColorStop(0, css(WHITE, 0.55));
      shine.addColorStop(1, css(WHITE, 0));
      c.fillStyle = shine;
      c.beginPath();
      c.arc(bcx, bcy, R, 0, Math.PI * 2);
      c.fill();
      c.lineWidth = 1.4 * s;
      c.strokeStyle = css(WHITE, 0.85);
      c.beginPath();
      c.arc(bcx, bcy, R - c.lineWidth / 2, 0, Math.PI * 2);
      c.stroke();
      let size = h * 0.27;
      c.font = `800 ${size}px ${FONT}`;
      const room = R * 2 - 6 * s;
      const tw = c.measureText(label).width;
      if (tw > room) {
        size *= room / tw;
        c.font = `800 ${size}px ${FONT}`;
      }
      c.save();
      c.shadowColor = 'rgba(32,48,40,0.6)';
      c.shadowBlur = 1.2 * s * 2;
      c.shadowOffsetY = 0.6 * s;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillStyle = css(WHITE);
      c.fillText(label, bcx, bcy + size * 0.04);
      c.restore();
    }
  }
}

// ---- When alerts ring (AlertRules in Alerts.kt). Times in ms. ----

const Kind = { OVER: 'over', NEAR: 'near', SLOW: 'slow' };
const OVER_AFTER_MS = 3000;
const SLOW_AFTER_MS = 4000;
const GAP_MS = 3000;
const RINGS_PER_ROUND = 3;
const ROUND_PAUSE_MS = 10000;
const NEVER = -1e15;

/**
 * Too fast: once you've been over the top speed for 3 seconds. Too slow: once you've been in the slow zone for 4.
 * Yellow (if asked): one heads-up on the way up. While it lasts it rings in rounds: a ring, 3 seconds' quiet after
 * it ends, a ring, 3 seconds, a ring, then 10 seconds' quiet. A reading that isn't live never alerts.
 */
class AlertRules {
  constructor() {
    this.ringMs = { over: 2000, near: 1000, slow: 2000 };
    this.lastRingAt = NEVER;
    this.lastRingMs = 0;
    this.reset();
  }

  next(mph, zone, live, atYellow, slowBelow, from, now) {
    if (!live) return null;
    const was = this.lastZone;
    this.lastZone = zone;
    this.overSince = zone !== Zone.OVER ? NEVER : this.overSince === NEVER ? now : this.overSince;
    const tooSlow = slowBelow > 0 && mph < slowBelow && mph >= from;
    this.slowSince = !tooSlow ? NEVER : this.slowSince === NEVER ? now : this.slowSince;
    const lastEnd = this.lastRingAt + this.lastRingMs;
    let wanted = null;
    if (zone === Zone.OVER && now - this.overSince >= OVER_AFTER_MS) wanted = Kind.OVER;
    else if (tooSlow && now - this.slowSince >= SLOW_AFTER_MS) wanted = Kind.SLOW;
    if (wanted == null) {
      this.run = null;
      this.rings = 0;
      const headsUp = zone === Zone.NEAR && was === Zone.OK && atYellow && now >= lastEnd + GAP_MS;
      return headsUp ? this.ring(Kind.NEAR, now) : null;
    }
    if (wanted !== this.run) {
      this.run = wanted;
      this.rings = 0;
    }
    const quiet = this.rings > 0 && this.rings % RINGS_PER_ROUND === 0 ? ROUND_PAUSE_MS : GAP_MS;
    if (now < lastEnd + quiet) return null;
    this.rings++;
    return this.ring(wanted, now);
  }

  reset() {
    this.lastZone = Zone.OK;
    this.overSince = NEVER;
    this.slowSince = NEVER;
    this.run = null;
    this.rings = 0;
  }

  ring(kind, now) {
    this.lastRingAt = now;
    this.lastRingMs = this.ringMs[kind];
    return kind;
  }
}

// ---- Playing them: a buzz (on phones that can) and/or a sound. ----

const SOUND_SETS = ['sparkle', 'arcade', 'bubbles', 'marimba'];
const SOUND_NAMES = ['Sparkle', 'Arcade', 'Bubbles', 'Marimba'];
const SOUND_MS = 2000;
// Off/on pairs in ms, from the Android app's buzzes (the web can't set how hard).
const BUZZ = { over: [380, 130, 380, 130, 380], near: [150, 120, 150], slow: [110, 90, 110, 90, 240] };
const buzzMs = (kind) => BUZZ[kind].reduce((a, b) => a + b, 0);

class Alerts {
  constructor() {
    this.rules = new AlertRules();
    this.audio = null;
    this.buffers = new Map();
    this.applySettings();
  }

  applySettings() {
    for (const kind of Object.values(Kind)) {
      const buzz = settings.alertWith !== 'sound' && CAN_BUZZ ? buzzMs(kind) : 0;
      const tone = settings.alertWith === 'buzz' ? 0 : SOUND_MS;
      this.rules.ringMs[kind] = Math.max(buzz, tone);
    }
    if (!settings.alerts) this.rules.reset();
  }

  /** Sound needs a tap before it may play (Safari's rule), so this runs from one. */
  unlock() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!this.audio) this.audio = new Ctx();
    if (this.audio.state === 'suspended') this.audio.resume();
    // A moment of silence, which is what actually unlocks it on older iPhones.
    const src = this.audio.createBufferSource();
    src.buffer = this.audio.createBuffer(1, 1, 22050);
    src.connect(this.audio.destination);
    src.start(0);
    this.load(SOUND_SETS[settings.fastSound] + '_over');
    this.load(SOUND_SETS[settings.fastSound] + '_near');
    this.load(SOUND_SETS[settings.slowSound] + '_slow');
  }

  load(name) {
    if (!this.audio) return Promise.resolve(null);
    if (!this.buffers.has(name)) {
      const loading = fetch('sounds/' + name + '.m4a')
        .then((r) => r.arrayBuffer())
        .then((data) => new Promise((ok, fail) => this.audio.decodeAudioData(data, ok, fail)))
        .catch(() => {
          this.buffers.delete(name); // try again next time
          return null;
        });
      this.buffers.set(name, loading);
    }
    return this.buffers.get(name);
  }

  check(mph, zone, live, now) {
    if (!settings.alerts) return;
    const kind = this.rules.next(mph, zone, live, settings.atYellow, settings.slowBelow, slowFrom(settings), now);
    if (kind) this.play(kind);
  }

  play(kind, withWhat = settings.alertWith) {
    if (withWhat !== 'sound' && CAN_BUZZ) navigator.vibrate(BUZZ[kind]);
    if (withWhat !== 'buzz') this.sound(SOUND_SETS[kind === Kind.SLOW ? settings.slowSound : settings.fastSound], kind);
  }

  sound(set, kind) {
    if (!this.audio) return;
    if (this.audio.state === 'suspended') this.audio.resume();
    const asked = performance.now();
    this.load(set + '_' + kind).then((buffer) => {
      // One that took too long to load would only ring late; skip it.
      if (!buffer || performance.now() - asked > 1500) return;
      const src = this.audio.createBufferSource();
      src.buffer = buffer;
      src.connect(this.audio.destination);
      src.start(0);
    });
  }
}

// ---- GPS, the reading and the screen. ----

const canvas = document.getElementById('pill');
const statusLine = document.getElementById('status');
const pill = new Pill(canvas);
const alerts = new Alerts();

/** A fix this old (ms) still counts as live; older, the reading dims. */
const GPS_FRESH_MS = 3000;
const GLIDE_S = 0.15;
const SNAP_MPH = 0.05;
const TICK_MS = 100;

const gps = { mph: 0, at: NEVER, watch: null, failed: false };
/** The latest reading's colour zone, and whether it's dimmed (no fresh fix behind it). */
const reading = { zone: Zone.OK, dim: true };
let shownMph = -1;
let targetMph = -1;
let held = NaN;
let wakeLock = null;

function setStatus(message) {
  statusLine.textContent = message || '';
  statusLine.hidden = !message;
}

function onFix(position) {
  const speed = position.coords.speed;
  gps.failed = false;
  pill.setWarn(false);
  // Only the chip's own speed: working it out from positions is far too jumpy standing still.
  if (speed == null || Number.isNaN(speed) || speed < 0) {
    setStatus('Waiting for GPS speed… it shows once you start moving.');
    return;
  }
  setStatus('');
  gps.mph = mphOf(speed);
  gps.at = performance.now();
  tick();
}

function onGpsError(error) {
  if (error.code === error.PERMISSION_DENIED) {
    gps.failed = true;
    pill.setWarn(true);
    setStatus(
      /iPhone|iPad|iPod/.test(navigator.userAgent)
        ? 'Location is off for PacePod. Turn it on in Settings › Privacy & Security › Location Services › Safari Websites (While Using), then reload.'
        : 'Location is off for this page. Allow it in the browser’s site settings, then reload.',
    );
  } else {
    setStatus('Looking for GPS… outdoors with a clear sky works best.');
  }
}

function startGps() {
  if (!('geolocation' in navigator)) {
    pill.setWarn(true);
    setStatus('This browser can’t read your location.');
    return;
  }
  if (gps.watch != null) navigator.geolocation.clearWatch(gps.watch);
  gps.watch = navigator.geolocation.watchPosition(onFix, onGpsError, {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 30000,
  });
}

async function keepScreenOn() {
  if (!('wakeLock' in navigator) || wakeLock || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch (e) {
    // Low battery mode, or not allowed: the screen sleeps as it normally would.
  }
}

/** Ten times a second: where the reading should be, its colour, and whether an alert is due. */
function tick() {
  const now = performance.now();
  const live = !gps.failed && now - gps.at <= GPS_FRESH_MS;
  if (gps.at === NEVER) {
    pill.setReading('--', 0, Zone.OK, true);
    pill.draw();
    return;
  }
  targetMph = gps.mph;
  // The colour follows the real speed, not the glide.
  reading.zone = zoneOf(targetMph, settings);
  reading.dim = !live;
  alerts.check(targetMph, reading.zone, live, now);
  if (shownMph < 0 || Math.abs(targetMph - shownMph) < SNAP_MPH) shownMph = targetMph;
  render();
  loop.wake();
}

function render() {
  const fullScale = settings.limit > 0 ? settings.limit / LIMIT_AT : GAUGE_MPH;
  held = steady(shown(shownMph, settings.kmh), held, settings.decimals);
  pill.setReading(text(held, settings.decimals), shownMph / fullScale, reading.zone, reading.dim);
}

/** Glides the needle and number to each new reading frame by frame, and stops drawing once they're there. */
const loop = {
  running: false,
  last: 0,
  wake() {
    if (this.running) return;
    this.running = true;
    this.last = 0;
    requestAnimationFrame((t) => this.frame(t));
  },
  frame(t) {
    const dt = this.last ? Math.min(0.1, (t - this.last) / 1000) : 1 / 60;
    this.last = t;
    if (targetMph >= 0 && shownMph >= 0) {
      shownMph += (targetMph - shownMph) * (1 - Math.exp(-dt / GLIDE_S));
      if (Math.abs(targetMph - shownMph) < SNAP_MPH) shownMph = targetMph;
      render();
    }
    pill.draw();
    if (shownMph !== targetMph || pill.recolouring) {
      requestAnimationFrame((n) => this.frame(n));
    } else {
      this.running = false;
    }
  },
};

// ---- Start, settings and the rest of the page. ----

const startCard = document.getElementById('start');
const sheet = document.getElementById('sheet');
let started = false;

function start() {
  started = true;
  startCard.hidden = true;
  alerts.unlock();
  startGps();
  keepScreenOn();
  setStatus('Looking for GPS…');
  setInterval(tick, TICK_MS);
}

document.getElementById('startButton').addEventListener('click', start);
document.getElementById('gear').addEventListener('click', () => {
  alerts.unlock(); // a tap: lets the sound previews play
  showSettings();
  sheet.hidden = false;
});
document.getElementById('done').addEventListener('click', () => {
  closeChoices();
  sheet.hidden = true;
});
sheet.addEventListener('click', (e) => {
  if (e.target === sheet) sheet.hidden = true;
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !started) return;
  keepScreenOn();
  // Safari may have dropped GPS while the page was away; ask again.
  if (performance.now() - gps.at > GPS_FRESH_MS) startGps();
});
window.addEventListener('resize', () => pill.fit());

// iPhone in Safari (not opened from the home screen): say how to add it there.
const iOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
document.getElementById('homeHint').hidden = !(iOS && !standalone);

// Settings: steppers that repeat while held, segmented choices, sound menus.

function holdToStep(button, onStep) {
  let timer = null;
  let repeats = 0;
  const stop = () => {
    clearTimeout(timer);
    timer = null;
    button.classList.remove('pressed');
  };
  const repeat = () => {
    onStep();
    repeats++;
    timer = setTimeout(repeat, Math.max(25, 110 - repeats * 6));
  };
  button.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    button.classList.add('pressed');
    repeats = 0;
    onStep();
    timer = setTimeout(repeat, 400);
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) button.addEventListener(type, stop);
  button.addEventListener('contextmenu', (e) => e.preventDefault());
}

function bumpLimit(step) {
  const kmh = settings.kmh;
  const now = shown(settings.limit, kmh);
  let next;
  if (now <= 0 && step > 0) next = kmh ? 30 : 20;
  else if (now <= 0) next = 0;
  else next = Math.min(Math.max(tenths(now + step), 0), MAX_SHOWN);
  if (next === now) return;
  settings.limit = toMph(next, kmh);
  // "Speed up below" has to stay 2 mph under it (or switch off when there's no room).
  const cap = toMph(slowCap(settings.limit, kmh), kmh);
  if (settings.slowBelow > cap) settings.slowBelow = cap;
  save();
}

function bumpWarn(step) {
  const next = Math.min(Math.max(settings.warnPercent + step, 50), 99);
  if (next === settings.warnPercent) return;
  settings.warnPercent = next;
  save();
}

function bumpSlow(step) {
  const kmh = settings.kmh;
  const now = shown(settings.slowBelow, kmh);
  const cap = slowCap(settings.limit, kmh);
  let next;
  if (now <= 0 && step > 0) next = Math.min(kmh ? 13 : 8, cap);
  else if (now <= 0) next = 0;
  else next = Math.min(Math.max(tenths(now + step), 0), cap);
  if (next === now) return;
  settings.slowBelow = toMph(next, kmh);
  save();
}

function bumpFrom(step) {
  if (settings.slowBelow <= 0) return;
  const kmh = settings.kmh;
  const now = shown(slowFrom(settings), kmh);
  const low = shown(SLOW_FROM_MIN_MPH, kmh);
  const high = shown(settings.slowBelow - MIN_ZONE_MPH, kmh);
  const next = Math.min(Math.max(tenths(now + step), low), Math.max(low, high));
  if (next === now) return;
  settings.slowFrom = toMph(next, kmh);
  save();
}

for (const [id, fn, step] of [
  ['limitMinus', bumpLimit, -0.1],
  ['limitPlus', bumpLimit, 0.1],
  ['warnMinus', bumpWarn, -1],
  ['warnPlus', bumpWarn, 1],
  ['fromMinus', bumpFrom, -0.1],
  ['fromPlus', bumpFrom, 0.1],
  ['slowMinus', bumpSlow, -0.1],
  ['slowPlus', bumpSlow, 0.1],
]) {
  holdToStep(document.getElementById(id), () => fn(step));
}

/** Segmented choices: data-key names the setting, each button's data-v its value. */
for (const group of document.querySelectorAll('.seg[data-key]')) {
  group.addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (!button) return;
    const key = group.dataset.key;
    const raw = button.dataset.v;
    const value = raw === 'true' ? true : raw === 'false' ? false : /^\d+$/.test(raw) ? Number(raw) : raw;
    settings[key] = value;
    if (key === 'kmh') held = NaN;
    save();
    if (key === 'alertWith' && value !== 'sound') alerts.play(Kind.OVER, 'buzz');
  });
}

/**
 * A drop-down in the app's look, under [anchor] and lined up with its right edge (above it when there's no room
 * below). [onPick] gets the index of the choice tapped.
 */
const choiceMenu = document.getElementById('choiceMenu');

function openChoices(anchor, names, current, onPick) {
  choiceMenu.replaceChildren(
    ...names.map((name, i) => {
      const row = document.createElement('button');
      row.textContent = name;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === current));
      row.classList.toggle('on', i === current);
      row.addEventListener('click', () => {
        closeChoices();
        onPick(i);
      });
      return row;
    }),
  );
  choiceMenu.hidden = false;
  const a = anchor.getBoundingClientRect();
  const m = choiceMenu.getBoundingClientRect();
  const below = a.bottom + 4;
  choiceMenu.style.top = (below + m.height <= window.innerHeight - 8 ? below : Math.max(8, a.top - 4 - m.height)) + 'px';
  choiceMenu.style.left = Math.max(8, Math.min(a.right - m.width, window.innerWidth - m.width - 8)) + 'px';
}

function closeChoices() {
  choiceMenu.hidden = true;
}

document.addEventListener('pointerdown', (e) => {
  if (!choiceMenu.hidden && !choiceMenu.contains(e.target)) closeChoices();
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeChoices();
});
sheet.addEventListener('scroll', closeChoices); // it's placed on the screen, so it shouldn't stay behind

for (const [id, key, kind] of [
  ['fastSound', 'fastSound', Kind.OVER],
  ['slowSound', 'slowSound', Kind.SLOW],
]) {
  const button = document.getElementById(id);
  button.addEventListener('click', () => {
    alerts.unlock(); // a tap: lets the sound play
    openChoices(button, SOUND_NAMES, settings[key], (i) => {
      settings[key] = i;
      save();
      alerts.play(kind, 'sound');
    });
  });
}

function speedLabel(mph) {
  return limitText(shown(mph, settings.kmh)) + ' ' + unitName(settings.kmh);
}

function showSettings() {
  const s = settings;
  const kmh = s.kmh;
  document.getElementById('limitValue').textContent = s.limit > 0 ? speedLabel(s.limit) : 'Off';
  document.getElementById('warnValue').textContent = s.warnPercent + '%';
  document.getElementById('warnHint').textContent =
    s.limit > 0 ? 'from ' + text(shown((s.limit * s.warnPercent) / 100, kmh), 1) + ' ' + unitName(kmh) : 'set a top speed first';
  document.getElementById('warnRow').classList.toggle('faded', s.limit <= 0);
  document.getElementById('slowValue').textContent = s.slowBelow > 0 ? speedLabel(s.slowBelow) : 'Off';
  document.getElementById('fromValue').textContent = s.slowBelow > 0 ? speedLabel(slowFrom(s)) : '–';
  document.getElementById('fromRow').classList.toggle('faded', s.slowBelow <= 0);
  document.getElementById('fastSound').textContent = SOUND_NAMES[s.fastSound] || SOUND_NAMES[0];
  document.getElementById('slowSound').textContent = SOUND_NAMES[s.slowSound] || SOUND_NAMES[0];
  const sound = s.alertWith !== 'buzz';
  document.getElementById('fastSoundRow').hidden = !sound;
  document.getElementById('slowSoundRow').hidden = !sound;
  document.getElementById('withRow').hidden = !CAN_BUZZ;
  document.getElementById('needSpeed').hidden = s.limit > 0 || s.slowBelow > 0;
  for (const group of document.querySelectorAll('.seg[data-key]')) {
    for (const button of group.querySelectorAll('button')) {
      button.classList.toggle('on', button.dataset.v === String(s[group.dataset.key]));
    }
  }
}

// The rounded font arrives a moment after the page; lay the pill out again once it has.
pill.configure();
showSettings();
if (document.fonts && document.fonts.load) {
  document.fonts.load(`800 40px Nunito`).then(() => pill.configure(), () => {});
}
