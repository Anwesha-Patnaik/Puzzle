/**
 * App entry: render the shadcn/React overlay UI first (synchronously, so the DOM nodes
 * main.js looks up already exist), then start the camera / hand-tracking / puzzle code.
 */

import "./index.css" // Tailwind + shadcn theme
import "./style.css" // existing app styles (loaded after, so they can override)

import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { CompletionScreen, DifficultyChips, Hint, Hud, TitlePill } from "./ui/screens.jsx"

const mounts = [
  ["hint-root", Hint],
  ["hud-root", Hud],
  ["title-root", TitlePill],
  ["difficulty-chips", DifficultyChips],
  ["completion-screen", CompletionScreen],
]

for (const [id, Component] of mounts) {
  const el = document.getElementById(id)
  flushSync(() => createRoot(el).render(<Component />))
}

// Dynamic import (not top-level await) so the default browser targets still build.
import("./main.js")
