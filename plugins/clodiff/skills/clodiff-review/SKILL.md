---
name: clodiff-review
description: Use when the user asks you to review a PR, diff, or set of changes — if clodiff is active, perform the review inline using clodiff annotations so findings are visible in the code viewer alongside the relevant lines
---

# Code Review with clodiff

This skill gives you a built-in review workflow that integrates with clodiff's live viewer. It can run standalone, or extend any other review tool (ultrareview, a custom CI review, an LLM pipeline) by emitting findings as clodiff annotations.

## Before you start

Check that clodiff is running and read the session:

```javascript
import { existsSync, readFileSync } from "fs"
const active = existsSync(".review/session.json")
if (!active) {
  // Fall back to a plain text review — no viewer available
}
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

## Extending this workflow

Any tool that produces code findings can emit them to clodiff using the same pattern:
- Write annotations to `.review/session.json`
- Broadcast `scroll_to` after each one so the user sees it land
- Set the review event when done

This works for: ultrareview output, CI lint results, security scanners, custom review pipelines — anything that produces per-line findings. The viewer and the Push to GitHub button handle the rest.
