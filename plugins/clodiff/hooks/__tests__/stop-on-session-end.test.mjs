#!/usr/bin/env node
// Unit-test the SessionEnd cleanup decision.
// Run: node hooks/__tests__/stop-on-session-end.test.mjs
import { decideStop } from "../stop-on-session-end.js"

const SESSION = { port: 7777, pid: 1234 }
const LIVE_OURS_IDLE = { pid: 1234, clients: 0 }
const LIVE_OURS_VIEWING = { pid: 1234, clients: 1 }
const LIVE_OTHER = { pid: 9999, clients: 0 } // recycled port, different daemon

const cases = [
  { name: "stops an idle daemon that's ours", args: { reason: "other", session: SESSION, status: LIVE_OURS_IDLE }, want: true },
  { name: "skips when resuming", args: { reason: "resume", session: SESSION, status: LIVE_OURS_IDLE }, want: false },
  { name: "keeps it when a viewer is connected", args: { reason: "clear", session: SESSION, status: LIVE_OURS_VIEWING }, want: false },
  { name: "never touches another repo's recycled-port daemon", args: { reason: "logout", session: SESSION, status: LIVE_OTHER }, want: false },
  { name: "no-op when nothing is running", args: { reason: "logout", session: SESSION, status: null }, want: false },
  { name: "no-op with no recorded session", args: { reason: "logout", session: null, status: LIVE_OURS_IDLE }, want: false },
  { name: "stops on a normal exit too", args: { reason: "prompt_input_exit", session: SESSION, status: LIVE_OURS_IDLE }, want: true },
]

let pass = 0
const fails = []
for (const c of cases) {
  const got = decideStop(c.args)
  if (got === c.want) pass++
  else fails.push(`  ${c.name}: expected ${c.want}, got ${got}`)
}

console.log(`decideStop : ${pass}/${cases.length}`)
if (fails.length) {
  console.log("\nFAILURES:")
  for (const f of fails) console.log(f)
  process.exit(1)
}
console.log("ALL PASS")
