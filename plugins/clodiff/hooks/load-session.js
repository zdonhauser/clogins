#!/usr/bin/env node
import fs from "fs"
import path from "path"

const sessionPath = path.join(process.cwd(), ".review", "session.json")

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
