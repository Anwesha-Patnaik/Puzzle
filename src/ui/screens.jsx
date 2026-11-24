/**
 * Overlay UI built with shadcn/ui components (Card, Badge) in a glassmorphism style.
 *
 * Every bubble uses the shared `.glass` class from style.css (frosted blur, see-through white,
 * hairline highlight border, soft shadow). Its text turns white over the live camera view and
 * dark on the light screens (body.on-video).
 *
 * These render into containers that already exist in index.html. main.js keeps driving them
 * imperatively: it shows/hides the containers, sets the text of #gesture-hint / #hud / #title-pill /
 * #stats, and toggles the `hovered` / `active` classes on the difficulty chips. React renders them
 * once and never re-renders, so those changes are never overwritten.
 */

import { Badge } from "@/components/ui/badge"
import { Card, CardHeader, CardTitle } from "@/components/ui/card"

const LEVELS = [
  { id: "easy", label: "Easy", grid: "3 × 3" },
  { id: "medium", label: "Medium", grid: "5 × 5" },
  { id: "hard", label: "Hard", grid: "8 × 8" },
]

/** Bottom banner with the current gesture hint. main.js writes its text via setHint(). */
export function Hint() {
  return (
    <Badge
      id="gesture-hint"
      variant="outline"
      className="glass fixed bottom-10 left-1/2 max-w-[90vw] -translate-x-1/2 rounded-3xl px-7 py-3.5 text-center text-lg font-medium whitespace-normal text-[color:var(--glass-text)]"
    >
      Bring both hands into frame to begin framing your photo
    </Badge>
  )
}

/** Timer / pieces placed / moves while solving. Hidden until main.js gives it text. */
export function Hud() {
  return (
    <Badge
      id="hud"
      variant="outline"
      className="glass hidden rounded-full px-5 py-2 text-base font-semibold whitespace-pre text-[color:var(--glass-text)]"
    />
  )
}

/** Title on the review screen ("Your Photo"). Hidden until main.js gives it text. */
export function TitlePill() {
  return (
    <Badge
      id="title-pill"
      variant="outline"
      className="glass hidden rounded-full px-6 py-2.5 text-xl font-semibold whitespace-nowrap text-[color:var(--glass-text)]"
    />
  )
}

/**
 * Easy / Medium / Hard chips shown above the puzzle. Easy is selected first; picking another
 * rebuilds the puzzle from the same photo. `.chip`, `.active` and `.hovered` are the hooks main.js uses.
 */
export function DifficultyChips() {
  return (
    <>
      {LEVELS.map(level => (
        <Badge
          key={level.id}
          data-difficulty={level.id}
          variant="outline"
          className="chip glass cursor-pointer select-none rounded-full px-4 py-1.5 text-sm font-medium text-[color:var(--glass-text)] [&.active]:border-white [&.active]:bg-white/60 [&.active]:font-semibold [&.active]:shadow-[0_8px_32px_rgba(31,38,135,0.22),0_0_0_1.5px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.9)] [&.hovered:not(.active)]:scale-105 [&.hovered:not(.active)]:bg-white/45"
        >
          {level.label} · {level.grid}
        </Badge>
      ))}
    </>
  )
}

export function CompletionScreen() {
  return (
    <Card className="glass w-[min(92vw,30rem)] items-center gap-5 rounded-3xl px-8 py-10 text-center text-[color:var(--glass-text)]">
      <CardHeader className="w-full justify-items-center gap-3 px-0 text-center">
        <CardTitle className="text-3xl leading-tight font-semibold text-balance sm:text-4xl">
          Puzzle Complete!
        </CardTitle>
        {/* main.js fills this with the time and move count */}
        <p id="stats" className="text-lg text-balance opacity-80" />
      </CardHeader>
      <Badge variant="outline" className="glass rounded-full px-4 py-1.5 text-base text-[color:var(--glass-text)]">
        Wave to play again
      </Badge>
    </Card>
  )
}
