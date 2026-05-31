---
name: clodiff
description: Use when discussing, explaining, or reviewing code with the user — clodiff gives you a shared live view of the repo; use it to navigate, highlight lines, and leave inline annotations so the user can follow along visually
---

# Using clodiff

clodiff is a local code viewer running in the user's browser. When it's active you have a shared visual context — you can point to specific lines, highlight code while explaining it, and leave inline annotations that persist in the session. Annotations support full GitHub-flavored markdown.

## Bootstrap

Check for `.review/session.json` — if it doesn't exist, clodiff isn't running. Start it:

```bash
# Ensure bun is installed
which bun || curl -fsSL https://bun.sh/install | bash

# Start clodiff from the repo root (pick the right mode)
bunx clodiff                              # browse mode — no diff, just the repo
bunx clodiff --base main                  # diff against a branch
bunx clodiff --from HEAD~3 --to HEAD      # specific commit range
git diff HEAD~1 | bunx clodiff --stdin    # pipe a diff from any source
bunx clodiff --pr 42                      # PR review mode (explicit number)
# On a branch with an open PR, just run:
bunx clodiff                              # auto-detects the PR, fetches diff,
                                          # imports existing review threads
```

clodiff opens a browser window and writes `.review/session.json`. Read that file to get the port before making any API calls.

## Detect and connect

```javascript
import { existsSync, readFileSync } from "fs"

const active = existsSync(".review/session.json")
if (active) {
  const session = JSON.parse(readFileSync(".review/session.json", "utf-8"))
  const port = session.port  // e.g. 7777
}
```

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
import { spawnSync } from "child_process"

const sessionPath = ".review/session.json"
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
