/**
 * renderer.js — Canvas rendering helpers for camera feed, hand landmarks,
 *               framing box, and UI overlays.
 */

const CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],       // thumb
  [0,5],[5,6],[6,7],[7,8],       // index
  [5,9],[9,10],[10,11],[11,12],  // middle
  [9,13],[13,14],[14,15],[15,16],// ring
  [13,17],[17,18],[18,19],[19,20],// pinky
  [0,17],                        // palm
];

/**
 * Draw hand landmarks and skeleton on the canvas.
 */
export function drawHandLandmarks(ctx, landmarks, canvasWidth, canvasHeight, color = '#ffffff') {
  if (!landmarks || landmarks.length === 0) return;

  // Draw connections (white)
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.85;
  for (const [a, b] of CONNECTIONS) {
    const pA = landmarks[a];
    const pB = landmarks[b];
    ctx.beginPath();
    ctx.moveTo(pA.x * canvasWidth, pA.y * canvasHeight);
    ctx.lineTo(pB.x * canvasWidth, pB.y * canvasHeight);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Draw landmark dots
  for (let i = 0; i < landmarks.length; i++) {
    const p = landmarks[i];
    const x = p.x * canvasWidth;
    const y = p.y * canvasHeight;
    const radius = (i === 8 || i === 4) ? 8 : 4; // Bigger dots for index tip & thumb tip
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = color; // all dots white (the thumb and index tips are just larger)
    ctx.fill();
  }
}

/**
 * Draw the two-hand framing box. Hold it steady and the photo is taken.
 */
export function drawFrameBox(ctx, box) {
  if (!box) return;

  const { x, y, width, height, holdProgress = 0 } = box;

  // Viewfinder box
  ctx.save();

  // Dimming outside the box
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  // Top
  ctx.fillRect(0, 0, ctx.canvas.width, y);
  // Bottom
  ctx.fillRect(0, y + height, ctx.canvas.width, ctx.canvas.height - y - height);
  // Left
  ctx.fillRect(0, y, x, height);
  // Right
  ctx.fillRect(x + width, y, ctx.canvas.width - x - width, height);

  // Everything about the capture box is plain white: solid border, no dashes, no colour change
  const progressColor = '#ffffff';

  ctx.strokeStyle = progressColor;
  ctx.lineWidth = 1; // hairline border
  ctx.setLineDash([]);
  ctx.strokeRect(x + 0.5, y + 0.5, width, height); // +0.5 keeps a 1px line crisp

  // Corner brackets
  const bracketLen = Math.min(30, width * 0.15, height * 0.15);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = progressColor;
  // Top-left
  drawBracket(ctx, x, y, bracketLen, 1, 1);
  // Top-right
  drawBracket(ctx, x + width, y, bracketLen, -1, 1);
  // Bottom-left
  drawBracket(ctx, x, y + height, bracketLen, 1, -1);
  // Bottom-right
  drawBracket(ctx, x + width, y + height, bracketLen, -1, -1);

  // Hold-steady progress: a thin white bar under the box that fills up
  if (holdProgress > 0 && holdProgress < 1) {
    ctx.fillStyle = progressColor;
    ctx.fillRect(x, y + height + 8, width * holdProgress, 2);
  }

  // Caption under the box (above it if the box reaches the bottom of the screen)
  ctx.fillStyle = '#ffffff';
  ctx.font = '500 15px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center';
  const below = y + height + 34 < ctx.canvas.height;
  ctx.fillText('Hold steady to capture', x + width / 2, below ? y + height + 30 : y - 14);
  ctx.textAlign = 'start';

  ctx.restore();
}

function drawBracket(ctx, x, y, len, dx, dy) {
  ctx.beginPath();
  ctx.moveTo(x + len * dx, y);
  ctx.lineTo(x, y);
  ctx.lineTo(x, y + len * dy);
  ctx.stroke();
}

/**
 * Draw glowing cursor circles at fingertip positions.
 */
export function drawCursors(ctx, hands) {
  for (const hand of hands) {
    // Index fingertip cursor
    ctx.beginPath();
    ctx.arc(hand.pixelX, hand.pixelY, 14, 0, Math.PI * 2);
    ctx.fillStyle = hand.gesture === 'pinch'
      ? 'rgba(255, 64, 129, 0.5)'
      : 'rgba(64, 196, 255, 0.35)';
    ctx.fill();
    ctx.strokeStyle = hand.gesture === 'pinch' ? '#ff4081' : '#40c4ff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Inner dot
    ctx.beginPath();
    ctx.arc(hand.pixelX, hand.pixelY, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
  }
}
