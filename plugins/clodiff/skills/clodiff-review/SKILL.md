---
name: clodiff-review
description: Use when the user asks you to review a PR, diff, or set of changes — if clodiff is active, perform the review inline using clodiff annotations so findings are visible in the code viewer alongside the relevant lines
---

# Code Review with clodiff

This skill covers two modes:

- **PR review** — reviewing an open pull request; annotations stage as GitHub PR review comments submitted via the Submit Review modal
- **Local branch review** — reviewing uncommitted or local changes before merging; Fix It / Reject actions apply fixes directly to the working tree

Detect the mode at startup and bootstrap clodiff accordingly.

---

## Step 1: Detect mode and bootstrap clodiff

```bash
# Check if clodiff is already running
if [ -f .review/session.json ]; then
  echo "clodiff already running"
else
  # Detect whether the current branch has an open PR
  PR_JSON=$(gh pr view --json number,baseRefName,headRefSha 2>/dev/null)

  if [ -n "$PR_JSON" ]; then
    # ── PR review mode ──────────────────────────────────────────────────────
    PR_NUMBER=$(echo "$PR_JSON" | bun -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')).number))")
    BASE=$(echo "$PR_JSON" | bun -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')).baseRefName)")
    BRANCH=$(git rev-parse --abbrev-ref HEAD)

    nohup bunx clodiff --from "$BASE" --to "$BRANCH" --pr "$PR_NUMBER" > /tmp/clodiff-review.log 2>&1 &
  else
    # ── Local branch review mode ────────────────────────────────────────────
    DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|.*/||')
    DEFAULT_BRANCH=${DEFAULT_BRANCH:-main}

    nohup bunx clodiff --base "$DEFAULT_BRANCH" > /tmp/clodiff-review.log 2>&1 &
  fi

  # Wait up to 20s for the session file to appear
  for i in $(seq 1 40); do
    sleep 0.5
    [ -f .review/session.json ] && break
  done

  if [ ! -f .review/session.json ]; then
    echo "clodiff failed to start. Check /tmp/clodiff-review.log"
    exit 1
  fi
fi
```

Then read the session and determine the mode:

```javascript
import { readFileSync } from "fs"
const sessionPath = ".review/session.json"
const session = JSON.parse(readFileSync(sessionPath, "utf-8"))
const port = session.port
const isPRReview = session.pr_number != null
```

---

## Step 2: Get the diff

```javascript
const res = await fetch(`http://localhost:${port}/init`)
const { diff } = await res.json()
// diff is DiffFile[] — each file has .path, .hunks[], each hunk has lines[]
```

Or read a full file:

```javascript
const src = await fetch(`http://localhost:${port}/file?path=src/server.ts`).then(r => r.text())
```

---

## Step 3: Annotate

The `commit_id` on each annotation must match the diff head — the PR branch head in PR mode, or `HEAD` in local mode.

```javascript
import { readFileSync, writeFileSync } from "fs"
import { spawnSync } from "child_process"

// In PR mode: git rev-parse <branch>  (NOT HEAD — you may be on main)
// In local mode: git rev-parse HEAD
const session = JSON.parse(readFileSync(sessionPath, "utf-8"))
const commitRef = session.pr_number
  ? spawnSync("git", ["rev-parse", session.head_commit.slice(0, 7)], { encoding: "utf-8" }).stdout.trim() || session.head_commit
  : spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).stdout.trim()

// Use session.head_commit directly — it was set to the PR branch head by --to
const commit = session.head_commit

async function annotate(port, sessionPath, { path, line, lineContent, severity, body }) {
  const s = JSON.parse(readFileSync(sessionPath, "utf-8"))
  s.reviews[s.reviews.length - 1].comments.push({
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
  writeFileSync(sessionPath, JSON.stringify(s, null, 2))
  await fetch(`http://localhost:${port}/_ws_broadcast`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "scroll_to", path, line }),
  })
}
```

Work file by file:

1. **Scroll to the file** so the user sees where you are
2. **Read the changes** — use the diff hunks or fetch the full file
3. **Highlight lines** you're examining as you explain them
4. **Leave annotations** for any findings

---

## Severity guide

| Severity | Use for |
|---|---|
| `error` | Bugs, correctness issues, security problems |
| `warning` | Risky patterns, missing error handling, edge cases |
| `suggestion` | Improvements, alternatives, style |
| `note` | Observations, context, things to watch |

---

## Step 4: Set the review outcome

```javascript
// After reviewing all files, set the recommended event:
// APPROVE — looks good, ready to merge
// REQUEST_CHANGES — blocking issues found
// COMMENT — feedback without a formal decision (required for own PRs)

await fetch(`http://localhost:${port}/review/event`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ event: "REQUEST_CHANGES" }),  // or APPROVE or COMMENT
})
```

> **Note:** GitHub does not allow you to APPROVE your own PR. Use `COMMENT` when reviewing your own branch.

---

## Step 5: Submit

**PR review mode** — tell the user to click **Submit Review** in the viewer header. The modal lets them:
- Confirm the review decision (APPROVE / REQUEST_CHANGES / COMMENT)
- Write or edit a review summary body
- See staged comment counts by severity
- Submit — which posts the full review to GitHub

Do NOT call `/push` automatically in PR mode. The user submits via the modal.

**Local branch review mode** — Fix It / Reject actions apply fixes directly. There is no Submit step unless the user explicitly wants to push the annotations to a GitHub PR.

---

## Summary message

After reviewing all files, send a brief summary in chat:
- How many files reviewed
- Counts by severity (X errors, Y warnings, Z suggestions)
- Overall recommendation
- In PR mode: remind the user to click **Submit Review** in the viewer to post to GitHub

---

## Staying alive for replies

After the summary, start a persistent monitor on `.review/replies.json` using the `Monitor` tool so you can respond to user replies in the viewer without needing a new chat message.

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

When a notification arrives:
- `comment_id` — the annotation the user replied to
- `body` — what they said
- `id` — reply ID (won't re-fire)

**Responding in-thread** — write back using `POST /reply` with `source: "claude-code"`:

```javascript
async function replyToComment(commentId, body, severity) {
  const s = JSON.parse(readFileSync(sessionPath, "utf-8"))
  await fetch(`http://localhost:${s.port}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      comment_id: commentId,
      body,
      source: "claude-code",
      severity, // optional
    }),
  })
}
```

This renders as a styled mini annotation card inside the thread with a Fix It button.

**When to reply in-thread vs new annotation:**
- Question about a finding → reply in the same thread
- User wants a different approach → reply with updated suggestion (they click Fix It)
- Reply reveals a new unrelated issue → `annotate()` on the relevant line
- "Fix It" or "Rejected" → no response needed; already recorded

Stop the monitor when the user ends the review session.

---

## Editing annotations before submission

You can update any annotation's body before the user submits via `POST /edit-comment`:

```javascript
await fetch(`http://localhost:${port}/edit-comment`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ comment_id: "...", body: "revised text" }),
})
```

The viewer also has an Edit button on each annotation card for manual edits.

---

## Extending this workflow

Any tool that produces code findings can emit them as clodiff annotations:
- Write comments to `.review/session.json` (same shape as `annotate()` above)
- Broadcast `scroll_to` after each one
- Set the review event when done

Works for: ultrareview output, CI lint results, security scanners, custom review pipelines.
