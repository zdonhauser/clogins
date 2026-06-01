#!/usr/bin/env node
import fs from "fs"
import path from "path"

// ── Review-intent detection ───────────────────────────────────────────────
// The hook injects a nudge when clodiff is running AND the prompt looks like a
// review. This set is deliberately BROADER than the clodiff-review skill's own
// trigger: it includes named engines (ultrareview, a security review, a linter
// run) on purpose. The skill stays out of the way so the named engine wins the
// trigger and actually runs; this hook then makes sure that engine's findings
// land in the clodiff viewer. Skill = "don't override"; hook = "latch on".
//
// Detection is positive-pattern-only: if a strong review signal is present we
// nudge, otherwise we stay quiet. We don't bother with negative guards because
// the cost of a rare false positive is tiny — it's one extra context line, and
// only while a clodiff session is already open.
const REVIEW_PATTERNS = [
  /\breview\b/,                       // "review my diff", "code review", "security review", "a proper review"
  /\bultra-?review\b/,
  /\b(walk|go)\s+(me\s+)?(through|over)\b[^.?!]*\b(diff|prs?|pull request|change|finding|warning|comment|them|it)\b/,
  /\blook(ing)?\s+over\b[^.?!]*\b(change|diff|prs?|pull request|code|this)\b/,
  /\b(once[-\s]over|sanity[-\s]check|sanity check|gut[-\s]check)\b/,
  /\bsecond\s+pair\s+of\s+eyes\b/,
  /\b(linter|eslint|lint|tsc|typecheck|scanner|audit)\b[^.?!]*\b(warning|error|finding|issue|flag|spat|output|result)\b/,
  /\bi\s+ran\b[^.?!]*\b(linter|eslint|lint|scan|review|audit|check)\b/,
  /\bred\s+flags?\b/,                 // "any red flags in this changeset?"
  /\bflag\s+(any|anything|all|the)\b/,
  /\bleave\s+(inline\s+)?comments?\b/,
  /\b(good|ready|ok|safe)\s+to\s+merge\b/,
]

export function isReviewIntent(prompt) {
  if (!prompt || typeof prompt !== "string") return false
  const p = prompt.toLowerCase()
  return REVIEW_PATTERNS.some((re) => re.test(p))
}

// ── Hook entry point (skipped when this module is imported for tests) ──────
const invokedDirectly =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`

if (invokedDirectly) {
  // The nudge only matters when a clodiff review session is live.
  const sessionPath = path.join(process.cwd(), ".review", "session.json")
  if (!fs.existsSync(sessionPath)) process.exit(0)

  let prompt = ""
  try {
    const raw = fs.readFileSync(0, "utf-8") // UserPromptSubmit payload on stdin
    prompt = JSON.parse(raw).prompt || ""
  } catch {
    process.exit(0)
  }

  if (!isReviewIntent(prompt)) process.exit(0)

  process.stdout.write(
    "[clodiff] A clodiff review session is active on this repo. " +
      "If you produce review findings — your own, or from another review tool or skill that runs — " +
      "render them as inline annotations in the clodiff viewer (see the clodiff-review skill) " +
      "rather than only describing them in chat. The viewer is the user's review surface; " +
      "put findings where the code is.\n"
  )
}
