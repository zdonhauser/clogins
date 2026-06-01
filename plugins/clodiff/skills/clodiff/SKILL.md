---
name: clodiff
description: Use when discussing, explaining, or reviewing code with the user — clodiff gives you a shared live view of the repo; use it to navigate, highlight lines, and leave inline annotations so the user can follow along visually
---

# Using clodiff

clodiff is a local code viewer running in the user's browser. When it's active you have a shared visual context — you can point to specific lines, highlight code while explaining it, and leave inline annotations that persist in the session. Annotations support full GitHub-flavored markdown.

## Where the session lives

clodiff keeps its state under the repo's git dir — `"$(git rev-parse --absolute-git-dir)/clodiff/"`
(e.g. `.git/clodiff/session.json`), not a tracked `.review/` folder. Git never tracks
anything inside the git dir, so there's nothing to `.gitignore` and it never shows up in a
diff. `--absolute-git-dir` resolves per-worktree, so each worktree has its own session.
Resolve that directory once and reuse it for `session.json` and `replies.json`.

## Bootstrap

Check whether clodiff is running by looking for `session.json` in that directory. Start it
if absent:

```bash
# Ensure clodiff is installed (runs on Node >=22.18 — no build step)
which clodiff >/dev/null 2>&1 || npm install -g clodiff

# Start clodiff from the repo root (pick the right mode)
clodiff                              # DEFAULT: uncommitted changes vs the last commit
                                     # (tracked + untracked) — the common case.
                                     # On a branch with an open PR, auto-detects the PR
                                     # instead and imports its threads + conversation.
clodiff --working                    # force uncommitted-vs-HEAD even on a PR branch
clodiff --base main                  # working tree vs a branch
clodiff --from HEAD~3 --to HEAD      # specific commit range
git diff HEAD~1 | clodiff --stdin    # pipe a diff from any source
clodiff --pr 42                      # PR review mode (explicit number)
```

The port defaults to 7777 and **auto-increments** if taken, so you can run several
clodiff sessions at once — always read the actual port from the session file.

clodiff opens a browser window and writes `session.json` into the git dir. Read that file
to get the port before making any API calls.

## Detect and connect

```javascript
import { existsSync, readFileSync } from "fs"
import { execSync } from "child_process"

// Resolve clodiff's session dir (under the git dir — see "Where the session lives")
const reviewDir = execSync("git rev-parse --absolute-git-dir").toString().trim() + "/clodiff"
const sessionPath = `${reviewDir}/session.json`

if (existsSync(sessionPath)) {
  const session = JSON.parse(readFileSync(sessionPath, "utf-8"))
  const port = session.port  // actual port — may not be 7777 if it auto-incremented
}
```

## Change the diff range

When the user says "let's look at X instead", repoint the viewer at a different diff
with `POST /rediff`. The diff is two endpoints — `from` (base) and `to` (compare). Use
the literal **`"WORKING"`** for the working tree (uncommitted changes); any other value
is a git ref (branch, tag, `HEAD`, or a commit SHA).

```javascript
await fetch(`http://localhost:${port}/rediff`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ from: "HEAD", to: "WORKING" }),  // uncommitted vs last commit
})
```

Common ranges — map what the user asks for onto a `{ from, to }`:

| User wants | `{ from, to }` |
|---|---|
| my uncommitted changes (vs last commit) | `{ from: "HEAD", to: "WORKING" }` |
| my uncommitted changes vs `main` | `{ from: "main", to: "WORKING" }` |
| my branch vs `main` (committed only) | `{ from: "main", to: "HEAD" }` |
| the last commit | `{ from: "HEAD~1", to: "HEAD" }` |
| a specific commit range | `{ from: "<sha>", to: "<sha>" }` |

So you can just be told "show me my changes since main" and translate it to a rediff —
no restart needed. `WORKING` mode includes untracked files too.

## Scroll to a line

Use `scroll_to` to jump the viewer to a specific location:

```javascript
await fetch(`http://localhost:${port}/_ws_broadcast`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ type: "scroll_to", path: "src/server.ts", line: 42 })
})
```

## Highlight a line

Use `highlight` to draw attention with a fading amber glow — call it _before_ explaining the line so the user's eye is already on it:

```javascript
await fetch(`http://localhost:${port}/_ws_broadcast`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    type: "highlight",
    path: "src/server.ts",
    line: 42,
    duration: 4000,  // ms before fading (default: 4000)
    scroll: true     // also scroll to the line (default: true)
  })
})
```

## Leave an annotation

Annotations appear as inline comment cards supporting **full GitHub-flavored markdown** in the body (headings, code fences, tables, task lists, links).

```javascript
import { readFileSync, writeFileSync } from "fs"
import { execSync } from "child_process"

const reviewDir = execSync("git rev-parse --absolute-git-dir").toString().trim() + "/clodiff"
const sessionPath = `${reviewDir}/session.json`
const session = JSON.parse(readFileSync(sessionPath, "utf-8"))
const port = session.port
const commit = session.head_commit  // use session.head_commit, not git rev-parse HEAD
                                    // — in PR mode these differ; head_commit is the PR branch head

const annotation = {
  id: crypto.randomUUID(),
  created_at: new Date().toISOString(),
  source: "claude-code",
  body: "## Issue\n\nThis will throw if `config` is `undefined`.\n\n```ts\nconst v = (config?.timeout ?? 30) * 2\n```",
  path: "src/server.ts",
  commit_id: commit,
  line: 42,
  side: "RIGHT",              // RIGHT = new/current file; LEFT = old file in diff
  line_content: "  const x",  // trimmed text of the target line
  severity: "suggestion",     // "error" | "warning" | "suggestion" | "note"
}

session.reviews[session.reviews.length - 1].comments.push(annotation)
writeFileSync(sessionPath, JSON.stringify(session, null, 2))

// Scroll viewer to the annotation
await fetch(`http://localhost:${port}/_ws_broadcast`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ type: "scroll_to", path: annotation.path, line: annotation.line })
})
```

**Severity guide:**
- `error` — bug or correctness issue
- `warning` — risky pattern or potential problem
- `suggestion` — improvement or alternative approach
- `note` — observation or context worth capturing

## Reply in-thread

When the user replies to an annotation in the viewer, the reply appears in your next prompt via the `UserPromptSubmit` hook:

```
[clodiff replies]
<reply id="uuid" comment_id="COMMENT_ID" created_at="...">
Reply text here.
</reply>
```

Respond by writing back into the same thread using `POST /reply` with `source: "claude-code"`. This renders your response as a styled inline card (with severity badge and Fix It button if applicable) — no separate chat message needed.

```javascript
await fetch(`http://localhost:${port}/reply`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    comment_id: "COMMENT_ID",
    body: "Here's the updated approach:\n\n```ts\nconst v = (config?.timeout ?? 30) * 2\n```",
    source: "claude-code",
    severity: "suggestion",  // optional
  }),
})
```

## Edit an annotation

Update a comment body before the review is submitted (e.g. after a clarifying reply):

```javascript
await fetch(`http://localhost:${port}/edit-comment`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ comment_id: "...", body: "revised text" }),
})
```

## Best practices

- **Use `session.head_commit` as `commit_id`** — in PR review mode the current branch HEAD differs from the PR branch HEAD; session.head_commit is always correct.
- **Markdown in annotation bodies** — full GFM is rendered. Use code fences for before/after snippets; headings for multi-part findings; tables for comparisons.
- **Highlight before explaining** — call `highlight` first, then explain. The viewer follows the glow.
- **One concern per annotation** — multiple focused annotations are clearer than one long one.
- **Always scroll after annotating** — send `scroll_to` after writing to the session file so the user sees the new card immediately.
