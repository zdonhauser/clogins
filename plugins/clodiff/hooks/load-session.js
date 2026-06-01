#!/usr/bin/env node
import fs from "fs"
import path from "path"
import os from "os"
import crypto from "crypto"
import { execSync } from "child_process"

// clodiff stores its session under <git-dir>/clodiff (invisible to git), falling
// back to a temp dir keyed by cwd when not in a git repo. Mirror that resolution.
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

const sessionPath = path.join(reviewDir(), "session.json")

if (!fs.existsSync(sessionPath)) {
  process.exit(0)
}

let session
try {
  const raw = fs.readFileSync(sessionPath, "utf-8")
  session = JSON.parse(raw)
} catch {
  process.exit(0)
}

const baseBranch = session.base_branch || "unknown"
const reviews = Array.isArray(session.reviews) ? session.reviews : []

let openCount = 0
let resolvedCount = 0

for (const review of reviews) {
  const comments = Array.isArray(review.comments) ? review.comments : []
  for (const comment of comments) {
    if (comment.resolved) {
      resolvedCount++
    } else {
      openCount++
    }
  }
}

const output = `[clodiff session]\nbase: ${baseBranch} | open comments: ${openCount} | resolved: ${resolvedCount}\n`
process.stdout.write(output)
