/**
 * stylize.js — the look applied to every captured photo.
 *
 * Black-and-white, high-contrast and grainy (like a pushed film print), with blocky
 * red-orange rectangles laid over a faint grid. The red blocks are different every time.
 *
 *   1. black & white with punchy contrast
 *   2. random clusters of red grid cells, multiplied over the photo (the photo shows through)
 *   3. thin grid lines
 *   4. heavy monochrome film grain over everything, red included
 *
 * Pure canvas work: fast (a few ms), offline, no dependencies.
 */

const MAX_SIDE = 720; // working size; the puzzle pieces are small on screen anyway
const RED = '#ff340e';
const GRID_COLS = 12; // grid cells across the photo
const COVERAGE = 0.3; // fraction of cells that get a red block
const GRAIN = 36; // grain strength (0–255 scale)
const RED_LIFT = 0.6; // how much the photo under the red is brightened (0 = darkest, 1 = flat red)

/** Roughly bell-shaped random number in [-1, 1] (sum of three uniforms). */
function gaussish() {
  return (Math.random() + Math.random() + Math.random()) / 1.5 - 1;
}

/** Pick which grid cells are red: a few random-walk clusters plus a couple of strays. */
function pickRedCells(cols, rows) {
  const total = cols * rows;
  const target = Math.round(total * COVERAGE);
  const filled = new Set();
  const key = (c, r) => r * cols + c;
  const inside = (c, r) => c >= 0 && c < cols && r >= 0 && r < rows;

  // Clusters: start at a few random cells and wander, filling as they go
  const walkers = Array.from({ length: 3 + Math.floor(Math.random() * 2) }, () => ({
    c: Math.floor(Math.random() * cols),
    r: Math.floor(Math.random() * rows),
  }));
  let guard = 0;
  while (filled.size < target * 0.88 && guard++ < 4000) {
    const w = walkers[Math.floor(Math.random() * walkers.length)];
    filled.add(key(w.c, w.r));
    // Alternate horizontal and vertical steps so the blobs form chunky blocks and crosses
    const horizontal = Math.random() < 0.5;
    const step = Math.random() < 0.5 ? -1 : 1;
    const nc = w.c + (horizontal ? step : 0);
    const nr = w.r + (horizontal ? 0 : step);
    if (inside(nc, nr)) {
      w.c = nc;
      w.r = nr;
    }
  }
  // A few stray single cells
  for (let i = 0; i < Math.max(2, Math.round(total * 0.03)); i++) {
    filled.add(key(Math.floor(Math.random() * cols), Math.floor(Math.random() * rows)));
  }
  return { filled, key };
}

/**
 * @param {HTMLCanvasElement} source - the captured crop
 * @returns {Promise<HTMLCanvasElement>} the styled copy (same aspect ratio, max side 720px)
 */
export async function stylizePoster(source) {
  const scale = Math.min(1, MAX_SIDE / Math.max(source.width, source.height));
  const w = Math.max(32, Math.round(source.width * scale));
  const h = Math.max(32, Math.round(source.height * scale));

  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, w, h);

  // 1. Black & white with strong contrast (an S-curve, so shadows go deep and highlights blow out a little)
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    let v = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
    v = (v - 0.5) * 1.5 + 0.52;
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    v = v + (v * v * (3 - 2 * v) - v) * 0.5; // extra S-curve
    const g = v * 255;
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(img, 0, 0);

  // 2. Red blocks on a grid, multiplied over the photo so the face still shows through
  const cell = Math.max(12, Math.round(w / GRID_COLS));
  const cols = Math.ceil(w / cell);
  const rows = Math.ceil(h / cell);
  const { filled, key } = pickRedCells(cols, rows);

  const mask = document.createElement('canvas'); // drawn once, opaque, so touching cells don't double-darken
  mask.width = w;
  mask.height = h;
  const mctx = mask.getContext('2d');
  mctx.fillStyle = RED;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (filled.has(key(c, r))) mctx.fillRect(c * cell, r * cell, cell, cell);
    }
  }
  // The photo under the red is lifted first (blacks → mid-grey), then tinted red with multiply.
  // Plain multiply over a dark photo gives muddy brown; lifting keeps the red vivid while the face still shows.
  const redLayer = document.createElement('canvas');
  redLayer.width = w;
  redLayer.height = h;
  const rctx = redLayer.getContext('2d');
  rctx.drawImage(out, 0, 0);
  rctx.fillStyle = `rgba(255,255,255,${RED_LIFT})`;
  rctx.fillRect(0, 0, w, h);
  rctx.globalCompositeOperation = 'multiply';
  rctx.fillStyle = RED;
  rctx.fillRect(0, 0, w, h);
  rctx.globalCompositeOperation = 'destination-in'; // keep only the red cells
  rctx.drawImage(mask, 0, 0);
  ctx.drawImage(redLayer, 0, 0);

  // 3. Thin grid lines
  ctx.save();
  ctx.strokeStyle = 'rgba(0,0,0,0.24)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let c = 1; c < cols; c++) {
    ctx.moveTo(c * cell + 0.5, 0);
    ctx.lineTo(c * cell + 0.5, h);
  }
  for (let r = 1; r < rows; r++) {
    ctx.moveTo(0, r * cell + 0.5);
    ctx.lineTo(w, r * cell + 0.5);
  }
  ctx.stroke();
  ctx.restore();

  // 4. Film grain: the same noise on every channel (monochrome), over photo and red alike
  const grain = ctx.getImageData(0, 0, w, h);
  const g = grain.data;
  for (let i = 0; i < g.length; i += 4) {
    const n = gaussish() * GRAIN;
    g[i] += n;
    g[i + 1] += n;
    g[i + 2] += n;
  }
  ctx.putImageData(grain, 0, 0);

  return out;
}
