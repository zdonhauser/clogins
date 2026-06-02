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

// ── Review-intent detection ───────────────────────────────────────────────
// The hook injects a nudge when clodiff is running AND the prompt looks like a
// review. This set is deliberately BROADER than the clodiff-review skill's own
// trigger: it includes named engines (ultrareview, a security review, a linter
// run, review-team) on purpose. The skill stays out of the way so the named
// engine wins the trigger and actually runs; this hook then makes sure that
// engine's findings land in the clodiff viewer. Skill = "don't override";
// hook = "latch on".
//
// Detection is positive-pattern-only: if a strong review signal is present we
// nudge, otherwise we stay quiet. We don't bother with negative guards because
// the cost of a rare false positive is tiny — it's one extra context line, and
// only while a clodiff session is already open.
const REVIEW_PATTERNS = [
  /\breview\b/,                       // "review my diff", "code review", "security review", "review-team"
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

// The findings nudge — funnel review output onto the viewer surface as
// annotations, whatever engine (your own pass, ultrareview, a linter,
// review-team) produced it. This is the *adapter* contract: clodiff is the UI
// for whatever review is running, so the findings belong on the code as
// comments, not in a chat list.
export const FINDINGS_NUDGE =
  "[clodiff] A clodiff review session is live on this repo, and clodiff is the UI for " +
  "whatever review is running here. When this review produces findings — your own pass, or " +
  "another engine/skill the user invoked (review-team, ultrareview, a linter, a scanner) — " +
  "your deliverable is to render each finding as an inline annotation in the clodiff viewer, " +
  "pinned to its line. That is the expected output surface; a chat-only summary is not " +
  "enough. Do NOT re-do or override the other engine's analysis — let it run and judge — " +
  "just route each of its findings onto the matching line as a clodiff comment (preserve its " +
  "file, line, message, and severity). If you don't already have the mechanism in context, " +
  "invoke the clodiff-review skill — its 'Routing another engine's findings' section is the " +
  "adapter (the annotate() helper + scroll_to broadcast). Put findings where the code is.\n"

// One-line watcher Claude can hand straight to the Monitor tool. Tails
// replies.json and emits each new reply as a JSON line.
const MONITOR_COMMAND =
  "node -e \"const fs=require('fs');const{execSync}=require('child_process');" +
  "const p=execSync('git rev-parse --absolute-git-dir').toString().trim()+'/clodiff/replies.json';" +
  "let seen=new Set();try{JSON.parse(fs.readFileSync(p,'utf8')).forEach(r=>seen.add(r.id))}catch{}" +
  "setInterval(()=>{try{JSON.parse(fs.readFileSync(p,'utf8')).filter(r=>!seen.has(r.id)).forEach(r=>{" +
  "seen.add(r.id);process.stdout.write(JSON.stringify({comment_id:r.comment_id,body:r.body,id:r.id})+'\\n')})}catch{}},1500)\""

// The monitor nudge — fires once per clodiff session. Whatever review skill the
// user invoked (review-team, ultrareview, a custom flow), it won't know to start
// clodiff's replies watcher. Without it, viewer replies only surface when the
// user happens to send a chat message (the inject-replies hook handles that
// fallback). Starting the Monitor makes replies surface proactively.
export function buildMonitorNudge() {
  return (
    "[clodiff] No replies watcher is running for this clodiff session yet. " +
    "Start one now so you can answer the user's in-viewer replies WITHOUT them " +
    "having to send a new chat message. Use the Monitor tool with persistent: true " +
    "and this exact command:\n\n" +
    MONITOR_COMMAND + "\n\n" +
    "Each line it emits is a JSON object {comment_id, body, id}: respond in-thread " +
    'via POST /reply on the clodiff server (source: "claude-code"), and if the user ' +
    "clicked Fix It, apply the code change. Start only ONE watcher per session, and " +
    "stop it when the review ends. (If you don't start it, replies still surface on " +
    "the user's next message via the inject-replies hook — but not proactively.)\n"
  )
}

// ── Hook entry point (skipped when this module is imported for tests) ──────
const invokedDirectly =
  process.argv[1] && import.meta.url === `file://${process.argv[1]}`

if (invokedDirectly) {
  // Nothing to do unless a clodiff session is live.
  const dir = reviewDir()
  const sessionPath = path.join(dir, "session.json")
  if (!fs.existsSync(sessionPath)) process.exit(0)

  let prompt = ""
  try {
    const raw = fs.readFileSync(0, "utf-8") // UserPromptSubmit payload on stdin
    prompt = JSON.parse(raw).prompt || ""
  } catch {
    process.exit(0)
  }

  let output = ""

  // Monitor nudge — fire once per clodiff session, regardless of what the prompt
  // is about. The intent is "whenever clodiff is running, the replies watcher
  // should be live", so the first prompt after clodiff starts arms it. Dedup on
  // the session's port: a new clodiff run gets a fresh port, which re-arms the
  // nudge. The flag file lives alongside the session and isn't watched by the
  // server (it only reacts to session.json).
  try {
    const session = JSON.parse(fs.readFileSync(sessionPath, "utf-8"))
    const port = typeof session.port === "number" ? session.port : null
    if (port !== null) {
      const flagPath = path.join(dir, ".monitor-nudged")
      let nudgedPort = null
      try { nudgedPort = parseInt(fs.readFileSync(flagPath, "utf-8").trim(), 10) } catch { /* none yet */ }
      if (nudgedPort !== port) {
        output += buildMonitorNudge()
        try { fs.writeFileSync(flagPath, String(port), "utf-8") } catch { /* best effort */ }
      }
    }
  } catch { /* session unreadable — skip the monitor nudge */ }

  // Findings nudge — only when the prompt actually looks like a review, since
  // it's about where review *output* should land. Prepend it so the high-level
  // "put findings in the viewer" guidance reads before the watcher mechanics.
  if (isReviewIntent(prompt)) {
    output = output ? FINDINGS_NUDGE + "\n" + output : FINDINGS_NUDGE
  }

  if (output) process.stdout.write(output)
}
