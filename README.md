# Gesture Puzzle

A hands-free photo puzzle that runs in the browser. Frame a photo with both hands, hold steady to capture it, then solve it as a jigsaw by pinching and dragging pieces. Hand tracking uses MediaPipe and runs entirely on your device, with no backend.

Live demo: https://gesture-puzzle.vercel.app

## Run it

Requires Node.js 18 or newer, a webcam, and a Chromium-based browser or Safari.

```bash
npm install
npm run dev
```

Open http://localhost:5173/ and allow camera access.

## How to play

1. Show both hands and make a frame between them. Hold it steady and the photo is taken.
2. Thumbs up to keep the photo, or wave to retake it.
3. Solve the jigsaw on Easy, or switch to Medium or Hard with the chips at the top. Pinch to pick up a piece and release near its slot to snap it in.
4. Wave after finishing to play again.

Press D at any time to show a small frame-rate and hand-tracking readout.

## Notes

- The hand-tracking engine and model are bundled in `public/`, so the app works offline.
- Camera access needs `localhost` or HTTPS.
- Built with Vite, React, Tailwind CSS and shadcn/ui components. The game itself (tracking, puzzle, canvas) is plain JavaScript in `src/`.
