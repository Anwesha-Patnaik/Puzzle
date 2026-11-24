/**
 * main.js — Application entry point.
 * Manages app state machine, MediaPipe initialization, and render loop.
 *
 * States:
 *   CAMERA    → Live camera feed with two-hand framing; hold the box steady to capture
 *   REVIEW    → Show the captured photo, confirm (thumbs up) or retake (wave)
 *   PUZZLE    → Jigsaw (Easy by default; Medium / Hard chips rebuild it live)
 *   COMPLETE  → Puzzle solved celebration
 */

import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { GestureEngine } from './gestureEngine.js';
import { PuzzleEngine } from './puzzleEngine.js';
import { drawHandLandmarks, drawFrameBox, drawCursors } from './renderer.js';
import confetti from 'canvas-confetti';
import { playShutter, playTick, playSnap, unlockAudio } from './sound.js';
import { stylizePoster } from './stylize.js';

// Background image for the puzzle stage (loaded early so it's ready). Without it the stage is plain white.
const bgImage = new Image();
bgImage.src = `${import.meta.env.BASE_URL}assets/background.webp`;
let stylizing = false; // true while the captured photo is being converted to the illustration style

// ─── DOM Elements ────────────────────────────────────────────────
const video = document.getElementById('webcam');
const canvas = document.getElementById('mainCanvas');
const ctx = canvas.getContext('2d');
const hintEl = document.getElementById('gesture-hint');
const chipsEl = document.getElementById('difficulty-chips');
const chipEls = chipsEl.querySelectorAll('.chip');
const completionScreen = document.getElementById('completion-screen');
const statsEl = document.getElementById('stats');

// ─── State ────────────────────────────────────────────────────────
let appState = 'LOADING'; // LOADING → CAMERA → REVIEW → PUZZLE → COMPLETE
let handLandmarker = null;
const gestureEngine = new GestureEngine();
let puzzleEngine = null;
let capturedImage = null;    // HTMLCanvasElement of the framed crop
let lastGestureState = null;

// Grabbed pieces tracking (supports two-hand grab)
const grabbedPieces = {}; // { 'Left': piece, 'Right': piece }

// Debounce for thumbsUp / wave gestures
let thumbsUpStart = 0;
let thumbsUpLastSeen = 0;
let flashStart = 0; // capture flash
let lastTickStep = 0; // which 25% step of the hold-steady progress last made a tick
let surfaceOnVideo = false; // body.on-video switches glass text to white while the camera view is showing

// Difficulty chips (Easy is the default; Medium / Hard rebuild the puzzle live)
const LEVELS = {
  easy: { cols: 3, rows: 3, ghost: 0.5 },
  medium: { cols: 5, rows: 5, ghost: 0.2 },
  hard: { cols: 8, rows: 8, ghost: 0 },
};
let currentLevel = 'easy';
let chipRects = []; // chip rectangles, measured once after they appear
let hoveredChip = null;
const prevPinch = {}; // per hand: was it pinching last frame? (a chip is picked on pinch *start*)

// Glass bubbles (React-rendered, text set from here)
const hudEl = document.getElementById('hud');
const titleEl = document.getElementById('title-pill');
let stateEnteredAt = 0; // Timestamp when current state was entered (wave cooldown)

// ─── Canvas Sizing ────────────────────────────────────────────────
const cursorCanvas = document.getElementById('cursorCanvas');
const cctx = cursorCanvas.getContext('2d');

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  cursorCanvas.width = window.innerWidth;
  cursorCanvas.height = window.innerHeight;
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ─── MediaPipe Initialization ─────────────────────────────────────
async function initMediaPipe() {
  setHint('Loading hand tracking model...');

  const vision = await FilesetResolver.forVisionTasks(
    `${import.meta.env.BASE_URL}mediapipe/wasm`
  );

  handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: `${import.meta.env.BASE_URL}models/hand_landmarker.task`,
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });

  appState = 'CAMERA';
  setHint('Bring both hands into frame to make a crop box');
}

// ─── Webcam ───────────────────────────────────────────────────────
async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 30 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
}

// ─── Render Loop ──────────────────────────────────────────────────
let lastVideoTime = -1;
const keepAliveCtx = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d');

// Debug overlay (press D): measures real FPS / detection cost on this machine
const stats = { detectMs: 0, detections: 0, frames: 0, fps: 0, detFps: 0, since: performance.now() };
let showDebug = false;
window.addEventListener('keydown', e => {
  if (e.key === 'd' || e.key === 'D') showDebug = !showDebug;
});

function drawDebug(gs) {
  const now = performance.now();
  if (now - stats.since >= 1000) {
    stats.fps = Math.round((stats.frames * 1000) / (now - stats.since));
    stats.detFps = Math.round((stats.detections * 1000) / (now - stats.since));
    stats.frames = 0;
    stats.detections = 0;
    stats.since = now;
  }
  const lines = [
    `render ${stats.fps} fps  |  detection ${stats.detFps} fps  |  detect ${stats.detectMs.toFixed(1)} ms`,
    `video ${video.videoWidth}x${video.videoHeight}  state ${appState}`,
    ...gs.hands.map(
      h => `${h.label}: ${h.gesture}  pinch ${h.pinchDist.toFixed(2)}${h.stale ? '  (stale)' : ''}`
    ),
  ];
  ctx.save();
  ctx.font = '14px ui-monospace, Menlo, monospace';
  const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + 20;
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(canvas.width - w - 10, 10, w, lines.length * 20 + 10);
  ctx.fillStyle = '#9cff9c';
  lines.forEach((l, i) => ctx.fillText(l, canvas.width - w, 30 + i * 20));
  ctx.restore();
}

function renderLoop() {
  requestAnimationFrame(renderLoop);
  stats.frames++;

  if (!handLandmarker || video.readyState < 2) return;

  // Run MediaPipe only when the camera has produced a new frame. On the
  // in-between display frames, reuse the last gesture state (one-shot events
  // cleared) — otherwise hands would vanish every other frame and flicker.
  let gestureState = lastGestureState;
  if (video.currentTime !== lastVideoTime || !gestureState) {
    lastVideoTime = video.currentTime;
    const t0 = performance.now();
    const results = handLandmarker.detectForVideo(video, t0);
    stats.detectMs += (performance.now() - t0 - stats.detectMs) * 0.1; // moving average
    stats.detections++;
    const aspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
    gestureState = gestureEngine.process(
      results?.landmarks || [],
      null,
      canvas.width,
      canvas.height,
      aspect
    );
  } else {
    gestureState = { ...gestureState, waveDetected: false };
  }
  lastGestureState = gestureState;

  // Glass bubbles use white text over the live camera view and dark text everywhere else
  const onVideo = appState === 'CAMERA';
  if (onVideo !== surfaceOnVideo) {
    surfaceOnVideo = onVideo;
    document.body.classList.toggle('on-video', onVideo);
  }

  // Clear
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  cctx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);

  // Touch the video every frame so the browser keeps decoding it even in states
  // that don't draw it (the puzzle and review screens) — otherwise tracking stalls there.
  keepAliveCtx.drawImage(video, 0, 0, 1, 1);

  // Dispatch to state handler
  switch (appState) {
    case 'CAMERA':
      renderCamera(gestureState);
      break;
    case 'REVIEW':
      renderReview(gestureState);
      break;
    case 'PUZZLE':
      renderPuzzle(gestureState);
      break;
    case 'COMPLETE':
      renderComplete(gestureState);
      break;
  }

  if (showDebug) drawDebug(gestureState);
}

// ─── State: CAMERA ────────────────────────────────────────────────
function renderCamera(gs) {
  // Draw mirrored video
  ctx.save();
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  ctx.restore();

  // Draw hand landmarks (mirror X)
  for (const hand of gs.hands) {
    const mirroredLandmarks = hand.landmarks.map(p => ({
      x: 1 - p.x,
      y: p.y,
      z: p.z,
    }));
    drawHandLandmarks(ctx, mirroredLandmarks, canvas.width, canvas.height);
  }

  // Draw framing box (mirror coordinates)
  if (gs.frameBox) {
    const mirroredBox = {
      x: canvas.width - gs.frameBox.x - gs.frameBox.width,
      y: gs.frameBox.y,
      width: gs.frameBox.width,
      height: gs.frameBox.height,
      holdProgress: gs.frameBox.holdProgress || 0,
    };
    drawFrameBox(ctx, mirroredBox);

    if (gs.frameBoxStable) {
      // Held steady long enough: CAPTURE!
      captureFrame(mirroredBox);
      playShutter();
      flashStart = performance.now();
      lastTickStep = 0;
      transitionTo('REVIEW');
      setHint('Thumbs up to confirm  |  Wave to retake');
      return;
    }

    // Soft tick at 25 / 50 / 75% of the hold
    const p = mirroredBox.holdProgress;
    const step = Math.floor(p * 4);
    if (p < 0.05) lastTickStep = 0;
    else if (step > lastTickStep && p < 1) {
      lastTickStep = step;
      playTick(p);
    }

    setHint('Hold the box steady to capture');
  } else if (gs.handCount >= 2) {
    setHint('Show both hands to frame your shot');
  } else if (gs.handCount === 1) {
    setHint('Bring your other hand into frame to create a crop box');
  } else {
    setHint('Show your hands to the camera to begin');
  }

  // Draw cursors
  const mirroredHands = gs.hands.map(h => ({
    ...h,
    pixelX: canvas.width - h.pixelX,
  }));
  drawCursors(ctx, mirroredHands);
}

function captureFrame(box) {
  // Crop the region from the mirrored video
  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = Math.max(1, Math.round(box.width));
  cropCanvas.height = Math.max(1, Math.round(box.height));
  const cropCtx = cropCanvas.getContext('2d');

  // Draw video first (mirrored)
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = canvas.width;
  tempCanvas.height = canvas.height;
  const tempCtx = tempCanvas.getContext('2d');
  tempCtx.translate(canvas.width, 0);
  tempCtx.scale(-1, 1);
  tempCtx.drawImage(video, 0, 0, canvas.width, canvas.height);

  // Crop
  cropCtx.drawImage(
    tempCanvas,
    box.x, box.y, box.width, box.height,
    0, 0, box.width, box.height
  );

  capturedImage = cropCanvas;

  // Apply the black-and-white / grain / red-blocks look (async so the flash and review screen appear first)
  stylizing = true;
  stylizePoster(cropCanvas)
    .then(styled => {
      // Ignore the result if the user already retook the photo
      if (capturedImage === cropCanvas) capturedImage = styled;
    })
    .catch(err => console.error('Stylize failed, using the original photo:', err))
    .finally(() => {
      stylizing = false;
    });
}

// ─── State: REVIEW ────────────────────────────────────────────────
function renderReview(gs) {
  // Show the captured image centered
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (capturedImage) {
    const scale = Math.min(
      (canvas.width * 0.7) / capturedImage.width,
      (canvas.height * 0.7) / capturedImage.height
    );
    const w = capturedImage.width * scale;
    const h = capturedImage.height * scale;
    const x = (canvas.width - w) / 2;
    const y = (canvas.height - h) / 2;

    // Shadow
    ctx.shadowColor = 'rgba(0,0,0,0.25)';
    ctx.shadowBlur = 24;
    ctx.drawImage(capturedImage, x, y, w, h);
    ctx.shadowBlur = 0;

    // Border
    ctx.strokeStyle = 'rgba(0,0,0,0.12)';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
  }

  setTitle(stylizing ? 'Developing your photo…' : 'Your Photo');

  // Check for thumbs up (confirm) — hold for 600ms
  // Accept thumbsUp OR fist (in case detection wobbles)
  const hasThumbsUp = !stylizing && gs.hands.some(h => h.gesture === 'thumbsUp');
  if (hasThumbsUp) {
    thumbsUpLastSeen = performance.now();
    if (thumbsUpStart === 0) thumbsUpStart = performance.now();
    const held = performance.now() - thumbsUpStart;
    if (held > 600) {
      transitionTo('PUZZLE');
      startPuzzle('easy'); // no difficulty screen: Easy first, switch with the chips
      return;
    }
    setHint(`Hold thumbs up… ${Math.round((held / 600) * 100)}%`);
  } else {
    // Only reset if we haven't started OR gesture has been absent for a few frames
    // (prevents flicker resets)
    // Grace period — don't reset until the thumb has been gone for 300ms
    if (performance.now() - thumbsUpLastSeen > 300) {
      thumbsUpStart = 0;
    }
    setHint('Thumbs up to confirm  |  Wave to retake');
  }

  // Check for wave (retake) — with cooldown so it doesn't fire on entry
  if (isWaveSafe(gs, 1500)) {
    transitionTo('CAMERA');
    capturedImage = null;
    setHint('Frame your shot with both hands, then hold steady to capture');
    return;
  }

  // Draw hand cursors
  const mirroredHands = gs.hands.map(h => ({
    ...h,
    pixelX: canvas.width - h.pixelX,
  }));
  drawCursors(ctx, mirroredHands);

  // Capture flash: white fade-out right after the shutter
  const flashAge = performance.now() - flashStart;
  if (flashAge < 350) {
    ctx.fillStyle = `rgba(255,255,255,${0.85 * (1 - flashAge / 350)})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
}

// ─── Puzzle setup + difficulty chips ──────────────────────────────
/** (Re)build the puzzle from the captured photo at the given difficulty. Called for Easy first, then by the chips. */
function startPuzzle(level) {
  const cfg = LEVELS[level];
  currentLevel = level;

  // Let go of anything the hands were holding: those pieces no longer exist
  for (const k of Object.keys(grabbedPieces)) grabbedPieces[k] = null;

  puzzleEngine = new PuzzleEngine(capturedImage, cfg.cols, cfg.rows, canvas.width, canvas.height, cfg.ghost, bgImage);
  appState = 'PUZZLE';

  chipsEl.classList.remove('hidden');
  chipRects = [];
  hoveredChip = null;
  chipEls.forEach(el => {
    el.classList.toggle('active', el.dataset.difficulty === level);
    el.classList.remove('hovered');
  });
  setHint('Pinch to grab pieces  |  pick Medium or Hard above anytime');
}

// Mouse / touch also work on the chips
chipsEl.addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (chip && appState === 'PUZZLE' && chip.dataset.difficulty !== currentLevel) startPuzzle(chip.dataset.difficulty);
});

/** Hover with a fingertip; start a pinch over a chip to pick it. Hands carrying a piece are ignored. */
function updateChips(hands) {
  if (chipRects.length === 0) {
    chipRects = [...chipEls].map(el => ({ el, rect: el.getBoundingClientRect() }));
  }
  let hovered = null;
  let picked = null;
  for (const hand of hands) {
    if (grabbedPieces[hand.label]) continue;
    for (const { el, rect } of chipRects) {
      const pad = el === hoveredChip ? 22 : 8; // slightly bigger target once hovered, so it doesn't flicker
      if (
        hand.pixelX >= rect.left - pad && hand.pixelX <= rect.right + pad &&
        hand.pixelY >= rect.top - pad && hand.pixelY <= rect.bottom + pad
      ) {
        hovered = el;
        if (hand.gesture === 'pinch' && !prevPinch[hand.label]) picked = el;
      }
    }
  }
  hoveredChip = hovered;
  chipEls.forEach(el => el.classList.toggle('hovered', el === hovered));
  if (picked && picked.dataset.difficulty !== currentLevel) startPuzzle(picked.dataset.difficulty);
}

// ─── State: PUZZLE ────────────────────────────────────────────────
function renderPuzzle(gs) {
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (!puzzleEngine) return;

  // Mirror hand coordinates for interaction
  const mirroredHands = gs.hands.map(h => ({
    ...h,
    pixelX: canvas.width - h.pixelX,
  }));

  // Difficulty chips first: picking one rebuilds the puzzle, so stop this frame if it did
  const levelBefore = currentLevel;
  updateChips(mirroredHands);
  if (currentLevel !== levelBefore) {
    for (const h of mirroredHands) prevPinch[h.label] = h.gesture === 'pinch';
    return;
  }

  // Process each hand's grab/move/release
  for (const hand of mirroredHands) {
    const label = hand.label;

    if (hand.gesture === 'pinch') {
      if (!grabbedPieces[label]) {
        // Try to grab a piece
        const piece = puzzleEngine.findPieceAt(hand.pixelX, hand.pixelY);
        if (piece && !piece.locked && !piece.grabbed) {
          piece.grabbed = true;
          piece.grabbedBy = label;
          // Remember where on the piece it was grabbed so it doesn't jump to the cursor
          piece.grabDX = hand.pixelX - piece.x;
          piece.grabDY = hand.pixelY - piece.y;
          grabbedPieces[label] = piece;
          puzzleEngine.bringToTop(piece);
        }
      }

      // Move the grabbed piece
      if (grabbedPieces[label]) {
        puzzleEngine.movePiece(grabbedPieces[label], hand.pixelX, hand.pixelY);
      }
    } else {
      // Released — drop the piece
      if (grabbedPieces[label]) {
        if (puzzleEngine.dropPiece(grabbedPieces[label])) playSnap(); // piece clicked into its slot
        grabbedPieces[label] = null;
      }
    }
  }

  // Clean up grabbed pieces for hands that disappeared
  for (const label of Object.keys(grabbedPieces)) {
    if (grabbedPieces[label] && !mirroredHands.find(h => h.label === label)) {
      if (puzzleEngine.dropPiece(grabbedPieces[label])) playSnap();
      grabbedPieces[label] = null;
    }
  }

  // Draw puzzle
  puzzleEngine.draw(ctx);
  setHud(puzzleEngine.getHudText());

  // Draw cursors on top
  drawCursors(ctx, mirroredHands);
  for (const h of mirroredHands) prevPinch[h.label] = h.gesture === 'pinch';

  // Check completion
  if (puzzleEngine.completed) {
    appState = 'COMPLETE';
    chipsEl.classList.add('hidden');
    setHud('');
    completionScreen.classList.remove('hidden');
    statsEl.textContent = `Time: ${puzzleEngine.getElapsedTime()} • Moves: ${puzzleEngine.moveCount}`;
    setHint('');

    // Fire confetti
    confetti({
      particleCount: 200,
      spread: 100,
      origin: { y: 0.6 },
    });
    return;
  }

  // Update hint
  const lockedCount = puzzleEngine.pieces.filter(p => p.locked).length;
  const total = puzzleEngine.pieces.length;
  if (lockedCount > 0) {
    setHint(`${lockedCount}/${total} pieces placed  |  Keep going`);
  }
}

// ─── State: COMPLETE ──────────────────────────────────────────────
function renderComplete(gs) {
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Show completed puzzle
  if (puzzleEngine) {
    puzzleEngine.draw(ctx);
  }

  drawCursors(cctx, gs.hands.map(h => ({ ...h, pixelX: canvas.width - h.pixelX })));

  // Wave to restart
  if (isWaveSafe(gs, 1500)) {
    completionScreen.classList.add('hidden');
    transitionTo('CAMERA');
    capturedImage = null;
    puzzleEngine = null;
    currentLevel = 'easy';
    Object.keys(grabbedPieces).forEach(k => (grabbedPieces[k] = null));
    setHint('Frame your shot with both hands, then hold steady to capture');
  }
}

// ─── UI Helpers ───────────────────────────────────────────────────
let lastHint = null;
function setHint(text) {
  if (text === lastHint) return; // called every frame; only touch the DOM when the text changes
  lastHint = text;
  hintEl.textContent = text;
  hintEl.style.opacity = text ? '1' : '0';
}

/** Set a glass bubble's text; an empty string hides it. Only touches the DOM when it changes. */
function setBubble(el, text) {
  if (el.dataset.text === text) return;
  el.dataset.text = text;
  el.textContent = text;
  el.classList.toggle('hidden', !text);
}
const setHud = text => setBubble(hudEl, text); // timer / pieces / moves while solving
const setTitle = text => setBubble(titleEl, text); // title on the review screen

/** Transition to a new state, resetting cooldowns and wave history. */
function transitionTo(newState) {
  appState = newState;
  setHud('');
  setTitle('');
  stateEnteredAt = performance.now();
  thumbsUpStart = 0;
  gestureEngine.resetWave();
  gestureEngine.resetFrameHold();
}

/**
 * Returns true only if a wave was detected AND we've been in the
 * current state long enough (avoids false triggers on entry).
 */
function isWaveSafe(gs, cooldownMs = 1200) {
  return gs.waveDetected && (performance.now() - stateEnteredAt > cooldownMs);
}

// ─── Boot ─────────────────────────────────────────────────────────
async function boot() {
  try {
    // Start the camera and load the hand model at the same time (faster startup than one after the other)
    await Promise.all([startCamera(), initMediaPipe()]);
    unlockAudio(); // camera access is granted: a good moment for the browser to allow sound too
    renderLoop();
  } catch (err) {
    console.error('Initialization failed:', err);
    setHint(`Error: ${err.message}. Please allow camera access and use Chrome.`);
  }
}

boot();
