---
name: clodiff-review
description: Use when the user asks you to review a PR, diff, or set of changes — if clodiff is active, perform the review inline using clodiff annotations so findings are visible in the code viewer alongside the relevant lines
---

# Code Review with clodiff

This skill gives you a built-in review workflow that integrates with clodiff's live viewer. It can run standalone, or extend any other review tool (ultrareview, a custom CI review, an LLM pipeline) by emitting findings as clodiff annotations.

## Before you start

Check for `.review/session.json`. If it doesn't exist, bootstrap clodiff — start it, wait for it to be ready, then proceed:

```bash
# Check if already running
if [ ! -f .review/session.json ]; then
  # Detect default branch (origin HEAD → fallback to main)
  DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|.*/||')
  DEFAULT_BRANCH=${DEFAULT_BRANCH:-main}

  # Start clodiff in the background
  nohup bunx clodiff --base "$DEFAULT_BRANCH" > /tmp/clodiff-review.log 2>&1 &

  # Wait up to 20s for the session file to appear
  for i in $(seq 1 40); do
    sleep 0.5
    [ -f .review/session.json ] && break
  done

  if [ ! -f .review/session.json ]; then
    echo "clodiff failed to start. Check /tmp/clodiff-review.log or run 'bunx clodiff' manually."
    exit 1
  fi
fi
```

Then read the session:

```javascript
import { existsSync, readFileSync } from "fs"
const session = JSON.parse(readFileSync(".review/session.json", "utf-8"))
const port = session.port
```

Get the current diff from the viewer (already parsed and available):

```javascript
const res = await fetch(`http://localhost:${port}/init`)
const { diff } = await res.json()
// diff is DiffFile[] — each file has .path, .hunks[], each hunk has lines[]
```

Or read any file's current content:

```javascript
const src = await fetch(`http://localhost:${port}/file?path=src/server.ts`).then(r => r.text())
```

## Review flow

Work file by file. For each changed file:

1. **Scroll to the file** so the user sees where you are
2. **Read the changes** — use the diff hunks or fetch the full file
3. **Highlight lines** you're examining as you explain them
4. **Leave annotations** for any findings, suggestions, or observations

```javascript
import { readFileSync, writeFileSync } from "fs"
import { spawnSync } from "child_process"

const commit = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).stdout.trim()

async function annotate(port, sessionPath, { path, line, lineContent, severity, body }) {
  const session = JSON.parse(readFileSync(sessionPath, "utf-8"))
  session.reviews[session.reviews.length - 1].comments.push({
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    source: "claude-code",
    body,
    path,
    commit_id: commit,
    line,
    side: "RIGHT",
    line_content: lineContent,
    severity,  // "error" | "warning" | "suggestion" | "note"
  })
  writeFileSync(sessionPath, JSON.stringify(session, null, 2))
  // Scroll to the annotation
  await fetch(`http://localhost:${port}/_ws_broadcast`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "scroll_to", path, line }),
  })
}
```

## Severity guide

| Severity | Use for |
|---|---|
| `error` | Bugs, correctness issues, security problems |
| `warning` | Risky patterns, missing error handling, edge cases |
| `suggestion` | Improvements, alternatives, style |
| `note` | Observations, context, things to watch |

## Setting the review outcome

Once you've reviewed all files, set the review event before pushing:

```javascript
// APPROVE — changes look good
await fetch(`http://localhost:${port}/review/event`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ event: "APPROVE" })
})

// REQUEST_CHANGES — errors or blocking issues found
await fetch(`http://localhost:${port}/review/event`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ event: "REQUEST_CHANGES" })
})
```

Let the user push to GitHub themselves via the **Push to GitHub** button in the viewer header — don't call `/push` automatically.

## Summary message

After reviewing all files, send a brief summary in chat:
- How many files you reviewed
- Counts by severity (X errors, Y warnings, Z suggestions)
- Your overall recommendation (approve / request changes / LGTM with nits)

## Staying alive for replies

After finishing the review and sending your summary, start a persistent watch on `.review/replies.json` using the `Monitor` tool so you can respond to user replies in the viewer without them needing to send a new chat message.

Use the Monitor tool with this script as the command and `persistent: true`:

```bash
bun -e "
const fs = require('fs');
const repliesPath = '.review/replies.json';
let seen = new Set();
try { JSON.parse(fs.readFileSync(repliesPath, 'utf8')).forEach(r => seen.add(r.id)); } catch {}
setInterval(() => {
  try {
    const replies = JSON.parse(fs.readFileSync(repliesPath, 'utf8'));
    replies.filter(r => !seen.has(r.id)).forEach(r => {
      seen.add(r.id);
      process.stdout.write(JSON.stringify({ comment_id: r.comment_id, body: r.body, id: r.id }) + '\n');
    });
  } catch {}
}, 1500);
"
```

When a notification arrives, the JSON line contains:
- `comment_id` — the annotation the user replied to
- `body` — what they said
- `id` — the reply ID (already seen, won't re-fire)

**Responding in-thread:** When a reply arrives, write your response directly into the same thread using `POST /reply` with `source: "claude-code"`. This makes your response appear as a styled mini-card inside the comment thread in the viewer, with a Fix It button if appropriate.

```javascript
const session = JSON.parse(readFileSync(".review/session.json", "utf-8"))
const port = session.port

async function replyToComment(commentId, body, severity) {
  await fetch(`http://localhost:${port}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      comment_id: commentId,
      body,
      source: "claude-code",
      severity, // optional: "error" | "warning" | "suggestion" | "note"
    }),
  })
}
```

**When to use in-thread reply vs new annotation:**
- User asks a question about a finding → reply in the same thread
- User wants a different approach → reply with the updated suggestion (they can click Fix It in the thread)
- User's reply reveals a new unrelated issue → use `annotate()` to add a new annotation on the relevant line
- User says "Fix It" or "Rejected" → no need to respond; the action was already recorded

Stop the monitor when the user ends the review session.

## Extending this workflow

Any tool that produces code findings can emit them to clodiff using the same pattern:
- Write annotations to `.review/session.json`
- Broadcast `scroll_to` after each one so the user sees it land
- Set the review event when done

This works for: ultrareview output, CI lint results, security scanners, custom review pipelines — anything that produces per-line findings. The viewer and the Push to GitHub button handle the rest.
