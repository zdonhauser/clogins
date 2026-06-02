---
description: Start clodiff's replies watcher so in-viewer replies surface proactively (use when you ran a review with another skill and the Monitor wasn't started)
---

A clodiff review session may be running, but the replies watcher hasn't been
started — so when the user replies to an annotation in the viewer, it won't reach
you until they send a chat message. Start the watcher now.

1. **Confirm a session exists.** clodiff stores state under the repo's git dir:

   ```bash
   SESSION="$(git rev-parse --absolute-git-dir 2>/dev/null)/clodiff/session.json"
   [ -f "$SESSION" ] && echo "clodiff session found" || echo "no clodiff session — start clodiff first"
   ```

   If there's no session, tell the user clodiff isn't running and stop.

2. **Start the watcher with the `Monitor` tool** (`persistent: true`), using this
   command. It tails `replies.json` and emits each new reply as a JSON line:

   ```bash
   node -e "
   const fs = require('fs');
   const { execSync } = require('child_process');
   const p = execSync('git rev-parse --absolute-git-dir').toString().trim() + '/clodiff/replies.json';
   let seen = new Set();
   try { JSON.parse(fs.readFileSync(p, 'utf8')).forEach(r => seen.add(r.id)); } catch {}
   setInterval(() => {
     try {
       JSON.parse(fs.readFileSync(p, 'utf8'))
         .filter(r => !seen.has(r.id))
         .forEach(r => { seen.add(r.id); process.stdout.write(JSON.stringify({ comment_id: r.comment_id, body: r.body, id: r.id }) + '\n'); });
     } catch {}
   }, 1500);
   "
   ```

3. **When a line arrives** (`{ comment_id, body, id }`):
   - Respond in-thread via `POST /reply` on the clodiff server with
     `source: "claude-code"` so it renders inside the annotation thread.
   - If the user clicked **Fix It**, apply the actual code change, then reply
     confirming what you changed.
   - If they clicked **Rejected**, leave the code as-is.

   See the clodiff-review skill's "Staying alive for replies" section for the
   exact `/reply` payload and the in-thread-vs-new-annotation guidance.

**Start only one watcher per session**, and stop it when the review ends. Note:
the `inject-replies` hook already surfaces replies on the user's next message —
this watcher just makes them surface proactively, without waiting for a message.
