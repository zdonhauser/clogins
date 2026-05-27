---
name: clodiff
description: Use when discussing, explaining, or reviewing code with the user — clodiff gives you a shared live view of the repo; use it to navigate, highlight lines, and leave inline annotations so the user can follow along visually
---

# Using clodiff

clodiff is a local code viewer running in the user's browser. When it's active you have a shared visual context — you can point to specific lines, highlight code while explaining it, and leave inline annotations that persist in the session.

**Always check on session start.** If `.review/session.json` exists, clodiff is running.

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

Use `scroll_to` to jump the viewer to a specific location — good for navigating between files or anchoring the conversation to a section:

```javascript
await fetch(`http://localhost:${port}/_ws_broadcast`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ type: "scroll_to", path: "src/server.ts", line: 42 })
})
```

## Highlight a line

Use `highlight` to draw attention with a fading amber glow — use it _before_ explaining a line so the user's eye is already on it when you speak:

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

Good moments to highlight:
- When explaining what a specific line does
- When pointing out a bug or concern in chat
- When walking through code step by step

## Leave an annotation

Annotations appear as inline comment cards in the viewer next to the code. Use them for suggestions, findings, and notes that should persist beyond the chat.

```javascript
import { readFileSync, writeFileSync } from "fs"
import { spawnSync } from "child_process"

const port = JSON.parse(readFileSync(".review/session.json", "utf-8")).port
const commit = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).stdout.trim()
const session = JSON.parse(readFileSync(".review/session.json", "utf-8"))

const annotation = {
  id: crypto.randomUUID(),
  created_at: new Date().toISOString(),
  source: "claude-code",
  body: "Your comment here",
  path: "src/server.ts",
  commit_id: commit,
  line: 42,
  side: "RIGHT",              // RIGHT = new/current file; LEFT = old file in diff
  line_content: "  const x", // trimmed text of the target line
  severity: "suggestion",    // "error" | "warning" | "suggestion" | "note"
}

session.reviews[session.reviews.length - 1].comments.push(annotation)
writeFileSync(".review/session.json", JSON.stringify(session, null, 2))

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

## Handling replies

When the user replies to an annotation in the viewer, the reply is injected into your next prompt by the `UserPromptSubmit` hook:

```
[clodiff replies]
<reply id="uuid" comment_id="COMMENT_ID" created_at="...">
Reply text here.
</reply>
```

Treat each `<reply>` as the user's direct response to the annotation with that `comment_id`. You can reply back by adding another annotation with `source: "claude-code"` and `in_reply_to_id` set if continuing a thread.

## Best practices

- **Highlight before explaining** — call `highlight` first, then explain. The viewer follows the glow.
- **Prefer annotations for suggestions** — chat messages scroll away; annotations stay visible next to the code.
- **One concern per annotation** — multiple focused annotations are clearer than one long one.
- **Always scroll after annotating** — send `scroll_to` after writing to the session file so the user sees the new card immediately.
