# clogins

Personal Claude Code plugin marketplace.

## Install

```bash
/plugin marketplace add github:zHause/clogins
```

Then install any plugin:

```bash
/plugin install clodiff@clogins
```

## Plugins

| Plugin | Description |
|--------|-------------|
| [clodiff](./plugins/clodiff) | Skills for [clodiff](https://github.com/zHause/clodiff) — shared live code viewer with inline annotations and line highlighting |

## Adding a new plugin

1. Create `plugins/<name>/` with a `.claude-plugin/plugin.json`
2. Add skills at `plugins/<name>/skills/<skill-name>/SKILL.md`
3. Register it in `.claude-plugin/marketplace.json`
