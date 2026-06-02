#!/usr/bin/env node
// Eval the deterministic review-intent detector against a labeled set.
// Run: node hooks/__tests__/nudge-review.test.mjs
import { readFileSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, join } from "path"
import { isReviewIntent, buildMonitorNudge, FINDINGS_NUDGE } from "../nudge-review.js"

const here = dirname(fileURLToPath(import.meta.url))
const evals = JSON.parse(readFileSync(join(here, "nudge-review.eval.json"), "utf-8"))

let pass = 0
const fails = []
for (const e of evals) {
  const got = isReviewIntent(e.prompt)
  if (got === e.inject) pass++
  else fails.push({ ...e, got })
}

const inj = evals.filter((e) => e.inject)
const noinj = evals.filter((e) => !e.inject)
const injPass = inj.filter((e) => isReviewIntent(e.prompt) === true).length
const noinjPass = noinj.filter((e) => isReviewIntent(e.prompt) === false).length

console.log(`should-inject : ${injPass}/${inj.length}`)
console.log(`should-not    : ${noinjPass}/${noinj.length}`)
console.log(`overall       : ${pass}/${evals.length}`)
if (fails.length) {
  console.log("\nFAILURES:")
  for (const f of fails) {
    console.log(`  expected ${f.inject} got ${f.got}  [${f.note}]  ${f.prompt.slice(0, 64)}`)
  }
  process.exit(1)
}

// ── Nudge content checks ──────────────────────────────────────────────────
// The monitor nudge must be self-contained enough for Claude to act on it
// without the clodiff-review skill being loaded (the whole point: it fires for
// other review flows like review-team). So it needs the Monitor cue, the
// replies path, and the in-thread reply mechanism.
const monitor = buildMonitorNudge()
const contentFails = []
const must = (cond, label) => { if (!cond) contentFails.push(label) }
must(monitor.includes("Monitor tool"), "monitor nudge names the Monitor tool")
must(monitor.includes("persistent: true"), "monitor nudge sets persistent: true")
must(monitor.includes("replies.json"), "monitor nudge points at replies.json")
must(monitor.includes("/reply"), "monitor nudge explains how to respond (/reply)")
must(monitor.includes("one"), "monitor nudge warns about a single watcher")
must(FINDINGS_NUDGE.includes("clodiff viewer"), "findings nudge points at the viewer")

if (contentFails.length) {
  console.log("\nCONTENT FAILURES:")
  for (const c of contentFails) console.log("  " + c)
  process.exit(1)
}
console.log(`nudge-content : ${6}/6`)

console.log("\nALL PASS")
