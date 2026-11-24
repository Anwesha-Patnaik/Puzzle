/**
 * PuzzleEngine — jigsaw slicing, layout on the background, piece handling and snapping.
 *
 * Layout: the background image fills the screen (white if there is none). The puzzle itself is built
 * inside a smaller "tray" rectangle in the middle; the loose pieces are scattered around it.
 */

const TAB = 0.62; // tab depth multiplier (keeps knobs a sensible size)

/** Offscreen canvas with the background image cover-fitted to the screen (plain white if there is none). */
function buildBackground(bgImage, W, H) {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  if (bgImage && bgImage.complete && bgImage.naturalWidth) {
    const iw = bgImage.naturalWidth;
    const ih = bgImage.naturalHeight;
    const scale = Math.max(W / iw, H / ih); // cover: fill the screen, crop the overflow
    const dw = iw * scale;
    const dh = ih * scale;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bgImage, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }
  return c;
}

/**
 * Append one jigsaw edge to a path, from (ax,ay) to (bx,by).
 * s: +1 = tab sticking out of this piece, -1 = blank (socket), 0 = flat border.
 * (nx,ny) is the outward normal of the edge.
 */
function addEdge(p, ax, ay, bx, by, nx, ny, s) {
  if (!s) {
    p.lineTo(bx, by);
    return;
  }
  const dx = bx - ax;
  const dy = by - ay;
  const L = Math.hypot(dx, dy);
  const pt = (u, v) => [ax + dx * u + nx * v * s * L * TAB, ay + dy * u + ny * v * s * L * TAB];
  const bez = (a, b, c, d, e, f) => p.bezierCurveTo(...pt(a, b), ...pt(c, d), ...pt(e, f));

  p.lineTo(...pt(0.36, 0));
  // left half: neck, then rounded head (mirrored on the right)
  bez(0.42, 0, 0.41, 0.05, 0.39, 0.1);
  bez(0.37, 0.16, 0.29, 0.19, 0.3, 0.26);
  bez(0.31, 0.33, 0.42, 0.35, 0.5, 0.35);
  bez(0.58, 0.35, 0.69, 0.33, 0.7, 0.26);
  bez(0.71, 0.19, 0.63, 0.16, 0.61, 0.1);
  bez(0.59, 0.05, 0.58, 0, 0.64, 0);
  p.lineTo(bx, by);
}

/** Closed jigsaw outline for a piece whose body rectangle is (0,0)–(pw,ph). */
function buildPiecePath(pw, ph, e) {
  const p = new Path2D();
  p.moveTo(0, 0);
  addEdge(p, 0, 0, pw, 0, 0, -1, e.top);
  addEdge(p, pw, 0, pw, ph, 1, 0, e.right);
  addEdge(p, pw, ph, 0, ph, 0, 1, e.bottom);
  addEdge(p, 0, ph, 0, 0, -1, 0, e.left);
  p.closePath();
  return p;
}

const rand = () => (Math.random() < 0.5 ? 1 : -1);

export class PuzzleEngine {
  /**
   * @param {HTMLCanvasElement|HTMLImageElement} sourceImage - the (stylised) photo
   * @param {number} cols
   * @param {number} rows
   * @param {number} W - screen width
   * @param {number} H - screen height
   * @param {number} ghostOpacity - faint guide image inside the tray (0 = off)
   * @param {HTMLImageElement} [bgImage] - background image (optional; white without it)
   */
  constructor(sourceImage, cols, rows, W, H, ghostOpacity = 0.5, bgImage = null) {
    this.sourceImage = sourceImage;
    this.cols = cols;
    this.rows = rows;
    this.W = W;
    this.H = H;
    this.ghostOpacity = ghostOpacity;

    // ── Tray: a smaller rectangle in the middle of the screen ──
    const srcW = sourceImage.width || sourceImage.naturalWidth;
    const srcH = sourceImage.height || sourceImage.naturalHeight;
    const aspect = srcW / srcH;
    const maxW = W * 0.46;
    const maxH = H * 0.58;
    const trayW = Math.min(maxW, maxH * aspect);
    this.pieceW = Math.floor(trayW / cols);
    this.pieceH = Math.floor(trayW / aspect / rows);
    this.trayW = this.pieceW * cols;
    this.trayH = this.pieceH * rows;
    this.trayX = Math.round((W - this.trayW) / 2);
    this.trayY = Math.round((H - this.trayH) / 2 + 24); // room for the HUD above

    // Snap radius: generous — half the smaller piece side, never tiny
    this.snapThreshold = Math.max(28, Math.min(this.pieceW, this.pieceH) * 0.5);
    this.grabPad = Math.max(12, Math.min(this.pieceW, this.pieceH) * 0.15);

    this.background = buildBackground(bgImage, W, H);
    this.pieces = [];
    this.createPieces();
    this.staticLayer = this.buildStaticLayer();

    this.moveCount = 0;
    this.startTime = Date.now();
    this.completed = false;
  }

  // ─── Piece creation ─────────────────────────────────────────────
  createPieces() {
    const { cols, rows, pieceW: pw, pieceH: ph } = this;

    // Full photo scaled to exactly the tray size; pieces are cut from this
    const full = document.createElement('canvas');
    full.width = this.trayW;
    full.height = this.trayH;
    const fctx = full.getContext('2d');
    fctx.imageSmoothingQuality = 'high';
    fctx.drawImage(this.sourceImage, 0, 0, full.width, full.height);
    this.fullImage = full;

    // Shared edge directions so neighbours interlock
    const hSign = Array.from({ length: rows }, () => Array.from({ length: cols - 1 }, rand));
    const vSign = Array.from({ length: rows - 1 }, () => Array.from({ length: cols }, rand));

    // Padding for knobs that stick out + the baked drop shadow
    this.pad = Math.ceil(0.23 * Math.max(pw, ph)) + 10;
    const pad = this.pad;

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const edges = {
          top: row > 0 ? -vSign[row - 1][col] : 0,
          bottom: row < rows - 1 ? vSign[row][col] : 0,
          left: col > 0 ? -hSign[row][col - 1] : 0,
          right: col < cols - 1 ? hSign[row][col] : 0,
        };
        const path = buildPiecePath(pw, ph, edges);

        const pc = document.createElement('canvas');
        pc.width = pw + pad * 2;
        pc.height = ph + pad * 2;
        const ctx = pc.getContext('2d');
        ctx.translate(pad, pad);

        // 1. soft drop shadow under the piece
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.4)';
        ctx.shadowBlur = 6;
        ctx.shadowOffsetX = 2;
        ctx.shadowOffsetY = 3;
        ctx.fillStyle = '#888';
        ctx.fill(path);
        ctx.restore();

        // 2. the photo, clipped to the jigsaw outline
        ctx.save();
        ctx.clip(path);
        ctx.drawImage(full, -col * pw, -row * ph);

        // 3. gentle plastic-like light falloff
        const g = ctx.createLinearGradient(0, 0, pw, ph);
        g.addColorStop(0, 'rgba(255,255,255,0.14)');
        g.addColorStop(0.5, 'rgba(255,255,255,0)');
        g.addColorStop(1, 'rgba(0,0,0,0.12)');
        ctx.fillStyle = g;
        ctx.fillRect(-pad, -pad, pw + pad * 2, ph + pad * 2);
        ctx.restore();

        // 4. cut edge: dark line + light inner highlight
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.lineWidth = 1.6;
        ctx.stroke(path);
        ctx.save();
        ctx.clip(path);
        ctx.strokeStyle = 'rgba(255,255,255,0.4)';
        ctx.lineWidth = 2;
        ctx.stroke(path);
        ctx.restore();

        const targetX = this.trayX + col * pw;
        const targetY = this.trayY + row * ph;
        this.pieces.push({
          id: row * cols + col,
          row,
          col,
          path,
          canvas: pc,
          targetX,
          targetY,
          x: targetX,
          y: targetY,
          locked: false,
          grabbed: false,
          grabbedBy: null,
          anim: null,
        });
      }
    }
    this.shuffle();
  }

  /** Background + tray + faint guide + empty-slot outlines, drawn once. */
  buildStaticLayer() {
    const c = document.createElement('canvas');
    c.width = this.W;
    c.height = this.H;
    const ctx = c.getContext('2d');
    ctx.drawImage(this.background, 0, 0);

    const { trayX: x, trayY: y, trayW: w, trayH: h } = this;
    const r = 10;

    // Tray shadow + translucent body
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.16)';
    ctx.shadowBlur = 28;
    ctx.shadowOffsetY = 8;
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.beginPath();
    ctx.roundRect(x - 10, y - 10, w + 20, h + 20, r + 4);
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = 'rgba(0,0,0,0.14)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(x - 10, y - 10, w + 20, h + 20, r + 4);
    ctx.stroke();

    // Faint guide image
    if (this.ghostOpacity > 0) {
      ctx.save();
      ctx.globalAlpha = this.ghostOpacity;
      ctx.drawImage(this.fullImage, x, y, w, h);
      ctx.restore();
    }

    // Empty-slot jigsaw outlines
    ctx.save();
    ctx.strokeStyle = 'rgba(0,0,0,0.2)';
    ctx.lineWidth = 1.2;
    for (const p of this.pieces) {
      ctx.save();
      ctx.translate(p.targetX, p.targetY);
      ctx.stroke(p.path);
      ctx.restore();
    }
    ctx.restore();
    return c;
  }

  /** Scatter loose pieces over the background, outside the tray. */
  shuffle() {
    const { W, H, pieceW: pw, pieceH: ph } = this;
    const margin = 16;
    const top = 70;
    const keepOut = {
      x1: this.trayX - 24 - pw * 0.3,
      y1: this.trayY - 24 - ph * 0.3,
      x2: this.trayX + this.trayW + 24,
      y2: this.trayY + this.trayH + 24,
    };
    for (const piece of this.pieces) {
      let x = 0;
      let y = 0;
      for (let tries = 0; tries < 40; tries++) {
        x = margin + Math.random() * (W - pw - margin * 2);
        y = top + Math.random() * (H - ph - top - margin);
        const overlaps = x + pw > keepOut.x1 && x < keepOut.x2 && y + ph > keepOut.y1 && y < keepOut.y2;
        if (!overlaps) break;
      }
      piece.x = x;
      piece.y = y;
      piece.locked = false;
      piece.anim = null;
    }
  }

  // ─── Interaction ────────────────────────────────────────────────
  /** Topmost unlocked piece under (x, y). */
  findPieceAt(x, y) {
    const pad = this.grabPad;
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const p = this.pieces[i];
      if (p.locked) continue;
      if (x >= p.x - pad && x <= p.x + this.pieceW + pad && y >= p.y - pad && y <= p.y + this.pieceH + pad) {
        return p;
      }
    }
    return null;
  }

  movePiece(piece, x, y) {
    if (piece.locked) return;
    piece.anim = null;
    piece.x = x - (piece.grabDX ?? this.pieceW / 2);
    piece.y = y - (piece.grabDY ?? this.pieceH / 2);
  }

  distanceToTarget(piece) {
    return Math.hypot(piece.x - piece.targetX, piece.y - piece.targetY);
  }

  isNearTarget(piece) {
    return this.distanceToTarget(piece) < this.snapThreshold;
  }

  /** Drop a piece; snaps into its slot if it is close enough. */
  dropPiece(piece) {
    if (piece.locked) return false;
    piece.grabbed = false;
    piece.grabbedBy = null;
    this.moveCount++;

    if (this.isNearTarget(piece)) {
      piece.anim = { sx: piece.x, sy: piece.y, start: performance.now(), dur: 140 };
      piece.x = piece.targetX;
      piece.y = piece.targetY;
      piece.locked = true;
      this.checkCompletion();
      return true;
    }
    return false;
  }

  bringToTop(piece) {
    const idx = this.pieces.indexOf(piece);
    if (idx > -1) {
      this.pieces.splice(idx, 1);
      this.pieces.push(piece);
    }
  }

  checkCompletion() {
    this.completed = this.pieces.every(p => p.locked);
  }

  getElapsedTime() {
    const totalSecs = Math.floor((Date.now() - this.startTime) / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = totalSecs % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  // ─── Drawing ────────────────────────────────────────────────────
  _renderPos(p, now) {
    if (!p.anim) return [p.x, p.y];
    const t = Math.min(1, (now - p.anim.start) / p.anim.dur);
    if (t >= 1) {
      p.anim = null;
      return [p.x, p.y];
    }
    const e = 1 - Math.pow(1 - t, 3); // ease-out
    return [p.anim.sx + (p.x - p.anim.sx) * e, p.anim.sy + (p.y - p.anim.sy) * e];
  }

  draw(ctx) {
    const now = performance.now();
    ctx.drawImage(this.staticLayer, 0, 0);

    // Highlight the slot a carried piece would snap into
    for (const p of this.pieces) {
      if (p.grabbed && this.isNearTarget(p)) {
        ctx.save();
        ctx.translate(p.targetX, p.targetY);
        ctx.strokeStyle = '#00e676';
        ctx.lineWidth = 3;
        ctx.shadowColor = '#00e676';
        ctx.shadowBlur = 14;
        ctx.stroke(p.path);
        ctx.restore();
      }
    }

    // Placed pieces first, loose ones on top
    for (const pass of [true, false]) {
      for (const p of this.pieces) {
        if (p.locked !== pass) continue;
        const [x, y] = this._renderPos(p, now);
        ctx.drawImage(p.canvas, x - this.pad, y - this.pad);

        if (p.grabbed) {
          ctx.save();
          ctx.translate(x, y);
          ctx.strokeStyle = 'rgba(64,196,255,0.95)';
          ctx.lineWidth = 3;
          ctx.shadowColor = '#40c4ff';
          ctx.shadowBlur = 12;
          ctx.stroke(p.path);
          ctx.restore();
        }
      }
    }

  }

  /** Text for the on-screen status bubble (the bubble itself is a glass DOM element, see ui/screens.jsx). */
  getHudText() {
    const locked = this.pieces.filter(p => p.locked).length;
    return `Time ${this.getElapsedTime()}    Pieces ${locked}/${this.pieces.length}    Moves ${this.moveCount}`;
  }
}
