/**
 * sound.js — tiny WebAudio synth for UI sounds (no audio files needed, works offline).
 *
 * Sounds: shutter (photo taken), tick (hold-steady progress), snap (a puzzle piece fits).
 *
 * Audio starts by itself: the context is created and resumed as early as possible, retried
 * until it runs, and also resumed by the first click / key press / touch if the browser
 * insists on one (an autoplay rule browsers apply to every web page, which a page can't switch off).
 */

let ctx = null;

function getCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  return ctx;
}

/** Try to start audio. Safe to call any number of times. */
export function unlockAudio() {
  const c = getCtx();
  if (c && c.state !== 'running') c.resume().catch(() => {});
}

// 1. try right away, 2. keep trying for a while (e.g. once camera access is granted),
// 3. and let any user interaction finish the job.
unlockAudio();
const retry = setInterval(() => {
  if (ctx && ctx.state === 'running') clearInterval(retry);
  else unlockAudio();
}, 400);
for (const evt of ['pointerdown', 'keydown', 'touchstart', 'click']) {
  window.addEventListener(evt, unlockAudio, { passive: true });
}

/** Short filtered-noise burst, the building block of a mechanical shutter click. */
function noiseBurst(c, when, duration, freq, gain) {
  const len = Math.max(1, Math.floor(c.sampleRate * duration));
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2); // decaying noise
  }
  const src = c.createBufferSource();
  src.buffer = buf;
  const filter = c.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = freq;
  filter.Q.value = 0.8;
  const g = c.createGain();
  g.gain.value = gain;
  src.connect(filter).connect(g).connect(c.destination);
  src.start(when);
}

/** Low thump that gives the click some body. */
function thump(c, when, freq, duration, gain) {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, when);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.4, when + duration);
  g.gain.setValueAtTime(gain, when);
  g.gain.exponentialRampToValueAtTime(0.001, when + duration);
  osc.connect(g).connect(c.destination);
  osc.start(when);
  osc.stop(when + duration + 0.02);
}

/** A soft pitched "bloop" used for ticks and the piece-fit sound. */
function tone(c, when, freq, duration, gain, type = 'triangle') {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(gain, when + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, when + duration);
  osc.connect(g).connect(c.destination);
  osc.start(when);
  osc.stop(when + duration + 0.02);
}

/** Camera shutter: two quick mechanical clicks ("ka-chk"). */
export function playShutter() {
  const c = getCtx();
  if (!c) return;
  unlockAudio();
  const t = c.currentTime + 0.005;
  noiseBurst(c, t, 0.05, 3500, 0.9);
  thump(c, t, 180, 0.07, 0.7);
  noiseBurst(c, t + 0.075, 0.07, 2200, 0.7);
  thump(c, t + 0.075, 120, 0.09, 0.5);
}

/** Soft rising tick while the capture hold is in progress (progress 0..1). */
export function playTick(progress = 0) {
  const c = getCtx();
  if (!c || c.state !== 'running') return;
  tone(c, c.currentTime, 520 + progress * 520, 0.06, 0.08);
}

/** A puzzle piece clicking into place: a woody "tock" plus a short bright two-note chime. */
export function playSnap() {
  const c = getCtx();
  if (!c) return;
  unlockAudio();
  const t = c.currentTime + 0.003;
  thump(c, t, 240, 0.06, 0.6); // the physical "tock"
  noiseBurst(c, t, 0.025, 2800, 0.45); // click of plastic meeting plastic
  tone(c, t + 0.03, 880, 0.14, 0.12); // pleasant confirmation
  tone(c, t + 0.075, 1318.5, 0.2, 0.1);
}
