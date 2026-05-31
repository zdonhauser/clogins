---
name: clodiff-review
description: Use whenever the user asks you to review a pull request, a diff, or a set of changes — even if they don't mention clodiff by name. This skill starts clodiff (or reuses a running session) and performs the review inline as annotations pinned to the relevant lines, then stages them as a GitHub PR review or applies them as local fixes. Prefer it over a plain prose review so findings land in the code viewer next to the code.
---

# Code Review with clodiff

This skill covers two modes:

- **PR review** — reviewing an open pull request; annotations stage as GitHub PR review comments submitted via the Submit Review modal
- **Local branch review** — reviewing uncommitted or local changes before merging; Fix It / Reject actions apply fixes directly to the working tree

Detect the mode at startup and bootstrap clodiff accordingly.

clodiff keys off the branch you're checked out on. To review a colleague's PR,
check out their branch first (`gh pr checkout <number>`) and then bootstrap — that
way "the current branch's PR" is theirs, and you won't accidentally review a branch
you aren't on.

---

## Step 1: Detect mode and bootstrap clodiff

```bash
# Already running? Reuse the live session.
if [ -f .review/session.json ]; then
  echo "clodiff already running"
else
  # One question decides the mode: does the current branch have an open PR?
  if gh pr view --json number >/dev/null 2>&1; then
    # ── PR review mode ──
    # Bare `bunx clodiff` auto-detects the PR for the branch you're on: it loads the
    # PR metadata (title, author, CI status), diffs base..head, and imports existing
    # GitHub review threads so you can see what others already said. Do NOT pass
    # --from/--to/--pr here — any diff-source flag turns off PR auto-detection, so
    # you'd lose the PR header bar and the thread import.
    nohup bunx clodiff > /tmp/clodiff-review.log 2>&1 &
  else
    # ── Local branch review mode ──
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

Every annotation needs a `commit_id`, and it has to match the commit the diff is
against or GitHub rejects the whole review with a 422. clodiff already resolved this
for you: `session.head_commit` is that commit — the PR branch head in PR mode, or
local `HEAD` in local mode. Use it directly. Don't run `git rev-parse HEAD` yourself:
in PR mode you may be on a different branch, or the PR branch may be ahead of your
local HEAD, and a mismatched commit_id is the single most common cause of a failed
submit.

```javascript
import { readFileSync, writeFileSync } from "fs"

const session = JSON.parse(readFileSync(sessionPath, "utf-8"))
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

Highlight *before* you explain a line so the user's eye is already there — the glow
fades on its own and the viewer scrolls to follow:

```javascript
await fetch(`http://localhost:${port}/_ws_broadcast`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ type: "highlight", path, line, duration: 4000, scroll: true }),
})
```

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

In PR mode this pre-selects the decision in the Submit Review modal — the user can
still change it before submitting, so treat it as your recommendation, not the final
word. In local mode it just records your overall call on the session.

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
