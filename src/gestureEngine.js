/**
 * GestureEngine — turns raw MediaPipe hand landmarks into stable, smooth gestures.
 *
 * What it does (vs. the naive per-frame version):
 *  1. Smooths every landmark with a One Euro filter (steady when still, responsive when moving)
 *  2. Tracks hands with stable IDs (handedness labels flip; IDs don't) and keeps a hand
 *     alive for a short grace period when detection drops out for a few frames
 *  3. Measures pinch relative to hand size (works at any distance) with hysteresis
 *  4. Debounces gesture changes so one noisy frame can't flip the state
 *  5. Detects waves by large, deliberate swings only
 *  6. Smooths the two-hand frame box and times how long it is held steady, with a grace period for flicker
 */

// ─── Tunables ─────────────────────────────────────────────────────
const CFG = {
  // One Euro filter — landmarks
  lmMinCutoff: 1.8,
  lmBeta: 8,
  // One Euro filter — cursor (extra smoothing on top)
  curMinCutoff: 1.2,
  curBeta: 8,

  // Pinch (ratio of thumb–index distance to hand size)
  pinchOn: 0.28,
  pinchOff: 0.45,

  // Frames a new gesture must persist before it is accepted
  gestureFramesIn: 3,
  pinchFramesIn: 2,
  pinchFramesOut: 2,

  // Hand lost → keep last state this long (ms)
  handGraceMs: 400,
  // Max normalized wrist distance to treat a detection as the same hand
  matchMaxDist: 0.35,

  // Wave: back-and-forth hand movement. Measured on the whole hand's centre (a natural wave
  // pivots at the wrist, so the wrist alone barely moves) and allowed in any hand shape.
  waveSwingFrac: 0.03, // min swing as fraction of canvas width
  waveReversals: 3, // direction changes needed (about a wave and a half)
  waveWindowMs: 1600,
  waveCooldownMs: 2500,

  // Frame box (the viewfinder between your two hands)
  boxMinSize: 80,
  boxHoldMs: 1500, // hold the frame this long without moving and the photo is taken
  boxCenterDrift: 70, // px the box may wander from where it settled before the timer restarts
  boxSizeDrift: 90,
  boxLostGraceMs: 700, // keep showing the box (and pause the timer) this long if a hand flickers out
  // Extra smoothing applied to the box itself (px units)
  boxMinCutoff: 0.6,
  boxBeta: 0.01,
};

// Landmark indices
const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_MCP = 5;
const INDEX_PIP = 6;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;
const MIDDLE_PIP = 10;
const MIDDLE_TIP = 12;
const RING_PIP = 14;
const RING_TIP = 16;
const PINKY_PIP = 18;
const PINKY_TIP = 20;

// ─── One Euro filter ──────────────────────────────────────────────
class OneEuro {
  constructor(minCutoff, beta, dCutoff = 4.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = null;
    this.dx = 0;
    this.t = 0;
  }
  static alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(v, t) {
    if (this.x === null) {
      this.x = v;
      this.t = t;
      return v;
    }
    const dt = Math.max(t - this.t, 1e-3);
    this.t = t;
    const rawD = (v - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (rawD - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (v - this.x);
    return this.x;
  }
}

// Distance in "height units" (x is scaled by aspect so it isn't stretched)
function d(a, b, asp) {
  return Math.hypot((a.x - b.x) * asp, a.y - b.y);
}

export class GestureEngine {
  constructor() {
    this.tracks = [];
    this.waveCooldownUntil = 0;
    this.resetFrameHold();
  }

  // ─── Public resets ──────────────────────────────────────────────
  resetFrameHold() {
    this.boxAnchor = null;
    this.boxStableStart = 0;
    this.boxLostAt = 0;
    this.boxFilters = null;
    this.lastBox = null;
    this.prevBoxTick = 0;
  }

  resetWave() {
    for (const t of this.tracks) t.wave = { dir: 0, ext: 0, revs: [] };
  }

  // ─── Tracks ─────────────────────────────────────────────────────
  _newTrack(slot) {
    const mk = (min, beta) => ({ x: new OneEuro(min, beta), y: new OneEuro(min, beta) });
    return {
      slot,
      label: `h${slot}`,
      lmFilters: Array.from({ length: 21 }, () => mk(CFG.lmMinCutoff, CFG.lmBeta)),
      curFilter: mk(CFG.curMinCutoff, CFG.curBeta),
      landmarks: null,
      pinched: false,
      gesture: 'none',
      cand: 'none',
      candN: 0,
      ratio: 1,
      cursorX: 0,
      cursorY: 0,
      lastSeen: 0,
      wave: { dir: 0, ext: 0, revs: [] },
    };
  }

  _freeSlot() {
    const used = new Set(this.tracks.map(t => t.slot));
    for (let s = 0; s < 2; s++) if (!used.has(s)) return s;
    // No free slot: evict the stalest track
    this.tracks.sort((a, b) => a.lastSeen - b.lastSeen);
    return this.tracks.shift().slot;
  }

  _match(detections) {
    const pairs = [];
    detections.forEach((det, di) => {
      this.tracks.forEach((tr, ti) => {
        if (!tr.landmarks) return;
        const dd = Math.hypot(det[WRIST].x - tr.rawWrist.x, det[WRIST].y - tr.rawWrist.y);
        if (dd < CFG.matchMaxDist) pairs.push({ di, ti, dd });
      });
    });
    pairs.sort((a, b) => a.dd - b.dd);
    const detToTrack = new Map();
    const usedTracks = new Set();
    for (const p of pairs) {
      if (detToTrack.has(p.di) || usedTracks.has(p.ti)) continue;
      detToTrack.set(p.di, this.tracks[p.ti]);
      usedTracks.add(p.ti);
    }
    detections.forEach((det, di) => {
      if (!detToTrack.has(di)) {
        const tr = this._newTrack(this._freeSlot());
        this.tracks.push(tr);
        detToTrack.set(di, tr);
      }
    });
    return detToTrack;
  }

  // ─── Classification ─────────────────────────────────────────────
  _classify(tr, asp) {
    const l = tr.landmarks;
    const handSize = Math.max(d(l[WRIST], l[MIDDLE_MCP], asp), 1e-3);

    const ratio = d(l[THUMB_TIP], l[INDEX_TIP], asp) / handSize;
    tr.ratio = ratio;

    // Pinch with hysteresis
    if (!tr.pinched && ratio < CFG.pinchOn) tr.pinched = true;
    else if (tr.pinched && ratio > CFG.pinchOff) tr.pinched = false;

    const ext = (tip, pip) => d(l[tip], l[WRIST], asp) > d(l[pip], l[WRIST], asp) * 1.05;
    const indexExt = ext(INDEX_TIP, INDEX_PIP);
    const middleExt = ext(MIDDLE_TIP, MIDDLE_PIP);
    const ringExt = ext(RING_TIP, RING_PIP);
    const pinkyExt = ext(PINKY_TIP, PINKY_PIP);

    if (tr.pinched) return 'pinch';

    // Thumbs up: thumb clearly extended and above everything, other fingers curled
    const margin = 0.25 * handSize;
    const thumbTip = l[THUMB_TIP];
    const thumbAbove =
      thumbTip.y < l[INDEX_TIP].y - margin &&
      thumbTip.y < l[MIDDLE_TIP].y - margin &&
      thumbTip.y < l[RING_TIP].y - margin &&
      thumbTip.y < l[PINKY_TIP].y - margin &&
      thumbTip.y < l[WRIST].y - 0.3 * handSize;
    const thumbExtended = d(thumbTip, l[INDEX_MCP], asp) > 0.6 * handSize;
    const curled = [indexExt, middleExt, ringExt, pinkyExt].filter(e => !e).length;
    if (thumbAbove && thumbExtended && curled >= 3) return 'thumbsUp';

    if (indexExt && !middleExt && !ringExt && !pinkyExt) return 'point';
    if (indexExt && middleExt && ringExt && pinkyExt) return 'openHand';
    if (!indexExt && !middleExt && !ringExt && !pinkyExt) return 'fist';
    return 'none';
  }

  _debounce(tr, raw) {
    if (raw === tr.gesture) {
      tr.cand = raw;
      tr.candN = 0;
      return;
    }
    if (raw === tr.cand) tr.candN++;
    else {
      tr.cand = raw;
      tr.candN = 1;
    }
    let need = CFG.gestureFramesIn;
    if (raw === 'pinch') need = CFG.pinchFramesIn;
    else if (tr.gesture === 'pinch') need = CFG.pinchFramesOut;
    if (tr.candN >= need) {
      tr.gesture = raw;
      tr.candN = 0;
    }
  }

  // ─── Wave ───────────────────────────────────────────────────────
  _updateWave(tr, now, W) {
    const w = tr.wave;
    // Holding a piece (pinch) or a thumbs-up can't be a wave; every other hand shape can,
    // because fingers drift between "open" and "relaxed" while you wave.
    if (tr.gesture === 'pinch' || tr.gesture === 'thumbsUp') {
      w.dir = 0;
      w.revs.length = 0;
      return false;
    }
    // Centre of the whole hand: moves a lot even when the wrist stays put
    let sum = 0;
    for (const p of tr.landmarks) sum += p.x;
    const x = (sum / tr.landmarks.length) * W;
    const swing = CFG.waveSwingFrac * W;
    if (w.dir === 0) {
      w.dir = 1;
      w.ext = x;
      return false;
    }
    if (w.dir > 0) {
      if (x > w.ext) w.ext = x;
      else if (w.ext - x > swing) {
        w.dir = -1;
        w.ext = x;
        w.revs.push(now);
      }
    } else {
      if (x < w.ext) w.ext = x;
      else if (x - w.ext > swing) {
        w.dir = 1;
        w.ext = x;
        w.revs.push(now);
      }
    }
    w.revs = w.revs.filter(t => now - t < CFG.waveWindowMs);
    if (w.revs.length >= CFG.waveReversals && now > this.waveCooldownUntil) {
      this.waveCooldownUntil = now + CFG.waveCooldownMs;
      w.revs.length = 0;
      return true;
    }
    return false;
  }

  // ─── Main entry ─────────────────────────────────────────────────
  /**
   * @param {Array} multiHandLandmarks - raw MediaPipe landmarks per hand
   * @param {Array} _handedness - unused (labels are unreliable); kept for API compatibility
   * @param {number} W - canvas width
   * @param {number} H - canvas height
   * @param {number} aspect - video width / height (for isotropic distances)
   */
  process(multiHandLandmarks, _handedness, W, H, aspect = 16 / 9) {
    const now = performance.now();
    const t = now / 1000;
    let waveDetected = false;

    const detToTrack = this._match(multiHandLandmarks);

    // Update matched tracks
    multiHandLandmarks.forEach((raw, di) => {
      const tr = detToTrack.get(di);
      tr.rawWrist = { x: raw[WRIST].x, y: raw[WRIST].y };
      tr.landmarks = raw.map((p, i) => ({
        x: tr.lmFilters[i].x.filter(p.x, t),
        y: tr.lmFilters[i].y.filter(p.y, t),
        z: p.z,
      }));
      tr.lastSeen = now;
      tr.stale = false;

      const rawGesture = this._classify(tr, aspect);
      this._debounce(tr, rawGesture);

      // Cursor: pinch point (midpoint) while pinching, otherwise index fingertip
      const l = tr.landmarks;
      const cx = tr.pinched ? (l[THUMB_TIP].x + l[INDEX_TIP].x) / 2 : l[INDEX_TIP].x;
      const cy = tr.pinched ? (l[THUMB_TIP].y + l[INDEX_TIP].y) / 2 : l[INDEX_TIP].y;
      tr.cursorX = tr.curFilter.x.filter(cx, t);
      tr.cursorY = tr.curFilter.y.filter(cy, t);

      if (this._updateWave(tr, now, W)) waveDetected = true;
    });

    // Age out hands that disappeared
    const seen = new Set(detToTrack.values());
    this.tracks = this.tracks.filter(tr => {
      if (seen.has(tr)) return true;
      tr.stale = true;
      return now - tr.lastSeen < CFG.handGraceMs;
    });

    const hands = this.tracks
      .filter(tr => tr.landmarks)
      .sort((a, b) => a.slot - b.slot)
      .map(tr => ({
        label: tr.label,
        gesture: tr.gesture,
        cursorX: tr.cursorX,
        cursorY: tr.cursorY,
        pinchDist: tr.ratio,
        pixelX: tr.cursorX * W,
        pixelY: tr.cursorY * H,
        landmarks: tr.landmarks,
        stale: !!tr.stale,
      }));

    const { frameBox, frameBoxStable } = this._updateFrameBox(hands, now);

    return {
      hands,
      handCount: hands.length,
      waveDetected,
      frameBox,
      frameBoxStable,
    };
  }

  // ─── Frame box ──────────────────────────────────────────────────
  /**
   * The viewfinder between the two hands (smoothed). Hold it still for boxHoldMs and
   * frameBoxStable turns true: that is the capture trigger.
   */
  _updateFrameBox(hands, now) {
    const dtTick = this.prevBoxTick ? now - this.prevBoxTick : 0;
    this.prevBoxTick = now;

    // Any relaxed hand shape counts as framing, except a deliberate open hand or thumbs-up
    // (those are "idle" / "confirm"). Requiring an exact pinch/point made the box vanish on
    // slightly curled fingers.
    const framers = hands.filter(h => h.gesture !== 'openHand' && h.gesture !== 'thumbsUp');

    let raw = null;
    if (framers.length >= 2) {
      const [a, b] = framers;
      const w = Math.abs(a.pixelX - b.pixelX);
      const h = Math.abs(a.pixelY - b.pixelY);
      if (w > CFG.boxMinSize && h > CFG.boxMinSize) {
        raw = { x: Math.min(a.pixelX, b.pixelX), y: Math.min(a.pixelY, b.pixelY), width: w, height: h };
      }
    }

    if (!raw) {
      if (!this.lastBox) return { frameBox: null, frameBoxStable: false };
      // Hands flickered: keep showing the last box and pause the hold timer
      if (!this.boxLostAt) this.boxLostAt = now;
      if (now - this.boxLostAt > CFG.boxLostGraceMs) {
        this.resetFrameHold();
        return { frameBox: null, frameBoxStable: false };
      }
      this.boxStableStart += dtTick; // freeze progress while the hands are missing
      const frozen = { ...this.lastBox };
      frozen.holdProgress = Math.min(1, (now - this.boxStableStart) / CFG.boxHoldMs);
      return { frameBox: frozen, frameBoxStable: false };
    }
    this.boxLostAt = 0;

    // Smooth the box itself so its edges don't shimmer
    if (!this.boxFilters) {
      const f = () => new OneEuro(CFG.boxMinCutoff, CFG.boxBeta, 2);
      this.boxFilters = { x: f(), y: f(), w: f(), h: f() };
    }
    const ts = now / 1000;
    const box = {
      x: this.boxFilters.x.filter(raw.x, ts),
      y: this.boxFilters.y.filter(raw.y, ts),
      width: this.boxFilters.w.filter(raw.width, ts),
      height: this.boxFilters.h.filter(raw.height, ts),
    };

    // Has the box moved away from where it settled? Then the timer starts over.
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const A = this.boxAnchor;
    const moved =
      !A ||
      Math.hypot(cx - A.cx, cy - A.cy) > CFG.boxCenterDrift ||
      Math.abs(box.width - A.w) > CFG.boxSizeDrift ||
      Math.abs(box.height - A.h) > CFG.boxSizeDrift;
    if (moved) {
      this.boxAnchor = { cx, cy, w: box.width, h: box.height };
      this.boxStableStart = now;
    }

    const stableMs = now - this.boxStableStart;
    box.holdProgress = Math.min(1, stableMs / CFG.boxHoldMs);
    this.lastBox = { ...box };
    return { frameBox: box, frameBoxStable: stableMs >= CFG.boxHoldMs };
  }
}
