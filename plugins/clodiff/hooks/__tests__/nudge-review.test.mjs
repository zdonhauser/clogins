#!/usr/bin/env node
// Eval the deterministic review-intent detector against a labeled set.
// Run: node hooks/__tests__/nudge-review.test.mjs
import { readFileSync } from "fs"
import { fileURLToPath } from "url"
import { dirname, join } from "path"
import { isReviewIntent } from "../nudge-review.js"

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
console.log("\nALL PASS")
