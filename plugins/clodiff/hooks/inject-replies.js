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

const repliesPath = path.join(reviewDir(), "replies.json")

if (!fs.existsSync(repliesPath)) {
  process.exit(0)
}

let replies
try {
  const raw = fs.readFileSync(repliesPath, "utf-8")
  replies = JSON.parse(raw)
} catch {
  process.exit(0)
}

if (!Array.isArray(replies) || replies.length === 0) {
  process.exit(0)
}

function escapeXmlAttr(str) {
  return String(str).replace(/&/g, "&amp;").replace(/"/g, "&quot;")
}
function escapeXmlBody(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

let output = "[clodiff replies]\n"
for (const reply of replies) {
  output += `<reply id="${escapeXmlAttr(reply.id)}" comment_id="${escapeXmlAttr(reply.comment_id)}" created_at="${escapeXmlAttr(reply.created_at)}">\n`
  output += escapeXmlBody(reply.body) + "\n"
  output += "</reply>\n"
}

process.stdout.write(output)

// Clear replies after reading
fs.writeFileSync(repliesPath, "[]", "utf-8")
