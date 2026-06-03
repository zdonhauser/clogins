#!/usr/bin/env node
import fs from "fs"
import path from "path"
import os from "os"
import crypto from "crypto"
import { execSync } from "child_process"

// SessionEnd cleanup: when a Claude session ends, stop the clodiff daemon for
// this repo IF no one is still looking at it. clodiff daemons are detached and
// survive the session on purpose (so you don't come back to a dead tab), and a
// 3h idle timer reaps abandoned ones — this hook just makes the common "I'm done,
// I closed the tab" case clean up promptly instead of lingering for hours.
//
// The guard matters: a session can end involuntarily (context limit, crash) while
// you're still viewing the diff. Killing the daemon then would recreate the very
// dead-tab problem the detach design fixed. So we only stop when zero viewers are
// connected, and we never touch a daemon we can't positively identify as ours.

function reviewDir() {
  try {
    const gitDir = execSync("git rev-parse --absolute-git-dir", {
      cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim()
    if (gitDir) return path.join(gitDir, "clodiff")
  } catch { /* not a git repo */ }
  const hash = crypto.createHash("sha1").update(process.cwd()).digest("hex").slice(0, 12)
  return path.join(os.tmpdir(), "clodiff", hash)
}

// Pure decision (exported for tests). Stop only when: not resuming, we have a
// recorded session, a live server answered, that server is OURS (its pid matches
// what we recorded — guards against a recycled port now owned by another repo),
// and no viewer is connected.
export function decideStop({ reason, session, status }) {
  if (reason === "resume") return false
  if (!session || !session.port || !session.pid) return false
  if (!status) return false
  if (status.pid !== session.pid) return false
  if (status.clients > 0) return false
  return true
}

const invokedDirectly =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`

if (invokedDirectly) {
  let reason = ""
  try { reason = JSON.parse(fs.readFileSync(0, "utf-8")).reason || "" } catch { /* no/!json stdin */ }

  let session = null
  try { session = JSON.parse(fs.readFileSync(path.join(reviewDir(), "session.json"), "utf-8")) } catch { /* no session */ }

  if (session?.port) {
    let status = null
    try {
      status = await fetch(`http://localhost:${session.port}/status`, { signal: AbortSignal.timeout(600) })
        .then((r) => (r.ok ? r.json() : null))
    } catch { /* not running */ }

    if (decideStop({ reason, session, status })) {
      try {
        process.kill(session.pid, "SIGTERM")
        process.stderr.write(`clodiff: stopped idle daemon (pid ${session.pid}) on session end\n`)
      } catch { /* already gone */ }
    }
  }
  process.exit(0)
}
