# clogins — Marketplace Maintenance Rules

This is a Claude Code plugin marketplace repo. Follow these rules whenever making changes.

## Version Management

**Always bump the version in `plugins/<name>/.claude-plugin/plugin.json` when you:**
- Add, rename, or modify a skill (`skills/**`)
- Add, rename, or modify a hook (`hooks/**`)
- Change `plugin.json` metadata (description, author, etc.)
- Any change a user would want their cached copy to update for

**Version format:** semver — `"major.minor.patch"` (e.g., `"1.1.0"`)
- Patch bump (`1.1.0 → 1.1.1`): bug fixes, typo corrections in skill text
- Minor bump (`1.1.0 → 1.2.0`): new skills, new hooks, new behaviour
- Major bump (`1.0.0 → 2.0.0`): breaking changes to skill interfaces

**Do NOT set `version` in `marketplace.json` plugin entries.** The `plugin.json` version is authoritative. Setting it in both places causes silent conflicts where `plugin.json` wins — only one source of truth.

**The updater only delivers changes when the version string changes.** If you forget to bump, users keep stale cached skills.

## Plugin Structure

Each plugin lives at `plugins/<name>/` with this layout:

```
plugins/<name>/
  .claude-plugin/
    plugin.json        ← name, version, description, author only
  skills/
    <skill-name>/
      SKILL.md
  hooks/
    hooks.json
    *.js               ← hook scripts
```

- Component directories (`skills/`, `hooks/`, `commands/`) go at **plugin root**, not inside `.claude-plugin/`
- `plugin.json` holds metadata only — no component paths needed (auto-discovered)

## Hook Scripts

- Always reference plugin-relative paths via `${CLAUDE_PLUGIN_ROOT}` in `hooks.json` commands
- Use `bun` (not `node`) for hook scripts — clodiff and this repo assume Bun is available
- Store any persistent cross-session state in `${CLAUDE_PLUGIN_DATA}` (survives plugin updates)

## Before Committing Changes

Run validation to catch structural issues:

```bash
# Validate the entire marketplace
claude plugin validate .

# Validate a specific plugin
claude plugin validate ./plugins/clodiff
```

Fix any reported errors before committing. Warnings are advisory.

## Marketplace-Level Files

`/.claude-plugin/marketplace.json` fields:
- `name` — kebab-case, matches the install command (`/plugin add <name>@clogins`)
- `owner` — your name/email
- `plugins[].source` — relative path like `"./plugins/clodiff"`
- `plugins[].version` — **leave unset**; version lives in plugin.json only

## Adding a New Plugin

1. Create `plugins/<name>/` with the structure above
2. Set `version: "1.0.0"` in `plugin.json`
3. Add an entry to `/.claude-plugin/marketplace.json` (no `version` field in the entry)
4. Run `claude plugin validate .`
5. Commit and push — the marketplace entry is live when pushed to the default branch
