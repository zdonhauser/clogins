---
name: clodiff-review
description: The viewer/UI layer for code review in clodiff. Use when the user wants to walk through a code review inside the diff viewer rather than in chat — either (a) reviewing a pull request or local changes yourself when no specific review tool was named, or (b) displaying review findings that already exist, e.g. 'I ran the linter, walk me through these 12 warnings', existing PR comments, or the output of a review that just ran. It renders findings as inline annotations pinned to the code and stages them as a GitHub PR review or local fixes. Do NOT trigger this to pre-empt a specific review engine the user invoked by name (ultrareview, /code-review, a dedicated security review, a named linter run) — let that engine run; clodiff is the surface its findings are displayed in, not a replacement for it.
---

# clodiff — the UI for any code review

clodiff is a **viewer, not a reviewer**. Whenever you're producing review findings —
no matter what generated them — surface them here as inline annotations pinned to the
relevant lines, so the user reviews *in the diff* instead of scrolling through chat.

The findings can come from anywhere:

- **The user's own request** — "review my changes", "look over this PR". Here *you* are
  the reviewer; do the analysis, then put it on screen.
- **Another review engine the user invoked** — ultrareview, `/code-review`, a security
  review, a linter, a CI scanner. Here *that engine* is the reviewer; you're just the
  display. Run it, then map its findings to annotations.
- **Findings you already have** — a saved report, existing PR comments, anything with a
  file + line + message.

## Don't hijack the review the user asked for

This is the one rule that matters most. If the user invoked a specific review flow, run
**that** flow and surface its output here. clodiff is the surface, not a replacement for
the analysis they wanted. Substituting your own generic pass for the security review (or
ultrareview, or linter) they asked for is the primary failure mode — so when an engine is
named, your job is to *route* its findings into clodiff, not to re-review the code
yourself.

Only act as the reviewer when no engine was specified and the user just wants "a review."

Either way, the rest of this skill is the same: it's the surface that any of those flows
plugs into.

---

## Step 1: Bootstrap clodiff (the surface)

Stand up the viewer first, so findings have somewhere to land. clodiff keys off the branch
you're checked out on. To review a colleague's PR, check out their branch first
(`gh pr checkout <number>`) so "the current branch's PR" is theirs and you don't review a
branch you aren't on.

```bash
# Already running? Reuse the live session.
if [ -f .review/session.json ]; then
  echo "clodiff already running"
else
  # One question decides the mode: does the current branch have an open PR?
  if gh pr view --json number >/dev/null 2>&1; then
    # ── PR mode ──
    # Bare `bunx clodiff` auto-detects the PR for the branch you're on: it loads the
    # PR metadata (title, author, CI status), diffs base..head, and imports existing
    # GitHub review threads so you can see what others already said. Do NOT pass
    # --from/--to/--pr here — any diff-source flag turns off PR auto-detection, so
    # you'd lose the PR header bar and the thread import.
    nohup bunx clodiff > /tmp/clodiff-review.log 2>&1 &
  else
    # ── Local mode ──
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

Read the session and note the mode — it changes how findings get submitted at the end:

```javascript
import { readFileSync } from "fs"
const sessionPath = ".review/session.json"
const session = JSON.parse(readFileSync(sessionPath, "utf-8"))
const port = session.port
const isPRReview = session.pr_number != null
```

- **PR mode** (`isPRReview === true`) — annotations stage as GitHub PR review comments,
  submitted via the Submit Review modal.
- **Local mode** — annotations are working-tree feedback; Fix It / Reject apply changes
  directly. No GitHub submit unless the user explicitly wants one.

---

## Step 2: Get findings onto the surface

Every finding — yours or another engine's — becomes an annotation through one helper. This
is the bridge that makes clodiff work as a UI for *any* review flow.

`commit_id` must match the commit the diff is against or GitHub rejects the whole review
with a 422. clodiff already resolved this: `session.head_commit` is that commit (PR branch
head in PR mode, local `HEAD` in local mode). Use it directly — don't `git rev-parse HEAD`
yourself, because in PR mode you may be on a different branch and a mismatched commit_id is
the single most common cause of a failed submit.

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

### Routing another engine's findings (the common case)

When the user ran a review tool, take its output and map each finding to one `annotate()`
call. Preserve the engine's own judgment — its file, line, message, and severity — rather
than re-deriving them. Map the tool's severity vocabulary onto clodiff's four levels (see
the table below); when in doubt, keep it faithful rather than upgrading or downgrading.

```javascript
// Example: findings already parsed from a linter / ultrareview / scanner
for (const f of externalFindings) {
  await annotate(port, sessionPath, {
    path: f.file,
    line: f.line,
    lineContent: f.lineText,        // trimmed text of the target line, if available
    severity: mapSeverity(f.level), // tool's level → error|warning|suggestion|note
    body: f.message,                // keep the engine's wording; add context if useful
  })
}
```

Don't add findings the engine didn't report, and don't drop ones it did. You're the
display; faithfulness is the job.

### Reviewing it yourself (only when no engine was named)

Pull the diff clodiff already parsed, then walk it file by file:

```javascript
const { diff } = await fetch(`http://localhost:${port}/init`).then(r => r.json())
// diff is DiffFile[] — each file has .path, .hunks[], each hunk has .lines[]
// Or read a whole file for context:
const src = await fetch(`http://localhost:${port}/file?path=src/server.ts`).then(r => r.text())
```

For each changed file: scroll to it, read the changes, highlight the line you're examining,
then annotate findings. Highlight *before* you explain so the user's eye is already there —
the glow fades on its own and the viewer scrolls to follow:

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

When routing another engine's findings, map its levels here — e.g. linter `error` → `error`,
linter `warn` → `warning`, security `critical/high` → `error`, `info` → `note`.

---

## Step 3: Set the review outcome

```javascript
// APPROVE — looks good, ready to merge
// REQUEST_CHANGES — blocking issues found
// COMMENT — feedback without a formal decision (required for your own PRs)
await fetch(`http://localhost:${port}/review/event`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ event: "REQUEST_CHANGES" }),  // or APPROVE or COMMENT
})
```

In PR mode this pre-selects the decision in the Submit Review modal — the user can still
change it before submitting, so treat it as your recommendation. When you routed another
engine's findings, base the recommendation on *its* verdict, not your own opinion of the
code. In local mode it just records the overall call on the session.

> **Note:** GitHub does not allow you to APPROVE your own PR. Use `COMMENT` for your own branch.

---

## Step 4: Submit

**PR mode** — tell the user to click **Submit Review** in the viewer header. The modal lets
them confirm the decision, write/edit a summary body, see staged counts by severity, and
submit — which posts the full review to GitHub. Do **not** call `/push` automatically; the
user submits via the modal.

**Local mode** — Fix It / Reject on each annotation apply fixes to the working tree. There's
no submit step unless the user explicitly wants to push the annotations to a GitHub PR.

---

## Summary message

After the findings are on screen, send a brief summary in chat:

- How many files / findings, and where they came from ("3 findings from the security review",
  not "I found 3 issues" when an engine did the finding)
- Counts by severity
- The recommendation (echo the engine's verdict when routing one)
- In PR mode: remind the user to click **Submit Review** to post to GitHub

---

## Staying alive for replies

After the summary, start a persistent monitor on `.review/replies.json` using the `Monitor`
tool so you can answer replies in the viewer without the user sending a new chat message.

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

Each notification carries `comment_id` (the annotation replied to), `body` (what they said),
and `id` (already seen, won't re-fire).

**Respond in-thread** with `POST /reply` and `source: "claude-code"` — it renders as a styled
mini card inside the thread with a Fix It button:

```javascript
async function replyToComment(commentId, body, severity) {
  const s = JSON.parse(readFileSync(sessionPath, "utf-8"))
  await fetch(`http://localhost:${s.port}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ comment_id: commentId, body, source: "claude-code", severity }),
  })
}
```

**In-thread reply vs. new annotation:**

- Question about a finding → reply in the same thread
- User wants a different approach → reply with the updated suggestion (they click Fix It)
- Reply reveals a new, unrelated issue → `annotate()` on the relevant line
- "Fix It" or "Rejected" → already recorded; no response needed

Stop the monitor when the user ends the review.

---

## Editing annotations before submission

Update any annotation body before submit (e.g. after a clarifying reply) via `POST /edit-comment`:

```javascript
await fetch(`http://localhost:${port}/edit-comment`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ comment_id: "...", body: "revised text" }),
})
```

The viewer also has an Edit button on each card for manual edits.
