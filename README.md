# handoff-compact

A [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) that replaces
compaction with a **structured handoff**. When a long session fills up, the conversation is
replaced by one message that says what the goal is, what is done and how that is proven,
what comes next, which decisions were made and why, and which approaches were ruled out.

> **Status: 0.1, not yet tested against a live session.** It needs Claude Code 2.1.287 or
> later with mods enabled. It passes `claude plugin validate --strict`, and its logic has
> been checked against a simulated event chain. The real tests in `tests/` run with
> `claude plugin test`.

## Why

Claude Code's own compaction summarizes the conversation with a generic prompt. That keeps
what a summarizer finds important. What the *next* stretch of work needs most usually gets
lost: the reason behind a decision, the paths that were already tried and failed, the one
command that shows whether the state is real.

A common workaround is to warn the model at some fill level and ask it to write a handoff
file. That costs turns in the expensive main context, depends on the model following the
warning, and still ends in a second, generic summary.

## How it works

1. **Trigger.** After each turn the mod compares the context fill with `threshold` % of the
   compact window. It also handles `/compact` and Claude Code's own automatic compaction,
   so every compaction goes through the same path.
2. **Handoff.** A *fork* of the session (`$.model.fork`) writes the handoff along a fixed
   outline. The fork reads the conversation from the prompt cache and has no tools, so the
   main context stays untouched.
3. **Verbatim tail.** The last N user prompts and answers are added word for word. That part
   doesn't depend on the model remembering anything.
4. **Replace.** The mod answers the `session.compact` event with that single handoff
   message. The handoff is also saved as a Markdown file.
5. **Continue (optional).** Sessions that run unattended can pick up the work on their own.

Safety net: if the fork fails (cold cache, API error), the compaction goes back to Claude
Code with the outline as its instructions. If the mod throws, Claude Code skips it and
compacts as usual. Subagents' compactions are never touched.

Claude Code's background pre-compaction is switched off by default (`precompute: skip`). Its
result would be thrown away anyway, so it only costs tokens.

## Install

```
/plugin marketplace add trytofly94/handoff-compact
/plugin install handoff-compact@handoff-compact
```

This repository is both the plugin and a marketplace that lists it. From a local checkout,
use `/plugin marketplace add /path/to/handoff-compact` for the first line. To try a
checkout for one session without installing it:

```
claude --plugin-dir /path/to/handoff-compact
```

A `--plugin-dir` copy shadows the installed one of the same name, so you can work on the
mod while your installed version keeps running everywhere else.

## Tests

```
claude plugin validate --strict .claude-plugin/plugin.json
claude plugin test                 # tests/*.test.ts, needs mods enabled
bash tests/offline/run.sh          # logic only, simulated hook chain, needs Node
```

## Options

Set them in `/plugin` → configure, in `/config`, or in `pluginConfigs` in your settings.

| Option | Default | What it does |
|---|---|---|
| `threshold` | `70` | Compact at this % of the compact window |
| `window` | `0` (auto) | Compact window in tokens. Auto order: adapter, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `autoCompactWindow` in `~/.claude/settings.json`, the model's context window |
| `keepVerbatim` | `10` | Latest prompts and answers copied word for word |
| `autoContinue` | `never` | `never`, `always`, or `adapter` (the adapter decides per session). Applies to compactions the mod starts itself |
| `precompute` | `skip` | `skip` turns off Claude Code's background pre-compaction, `core` leaves it on |
| `handoffDir` | `~/.claude/handoffs` | Where handoff files are saved |
| `outlineFile` | built-in | Text file with the sections every handoff must have, one per line |
| `adapter` | none | Executable that connects the mod to your setup (see below) |

The built-in outline: goal · state and proof · in progress · next step · decisions and
reasons · ruled out · blocked / open questions · files and commits · verify. The fork writes
in the conversation's language whatever the outline's language is.

## The adapter

An optional executable for whatever only your setup knows: which compact window a session
was started with, which files hold your project's state, whether a session runs unattended.
The mod calls it with JSON on stdin and reads JSON from stdout:

```jsonc
// stdin
{ "version": 1, "phase": "check", "sessionId": "…", "cwd": "/path",
  "trigger": null, "context": { "tokens": 151000, "window": 1000000, "percent": 15 } }
```

`phase` is `check` after a turn (the answer is cached for 5 minutes) or `compact` while the
handoff is being written. Every field of the answer is optional:

```jsonc
// stdout
{ "window": "200k", "threshold": 60, "autoContinue": true, "notes": "extra text for the handoff",
  "stateFiles": [ { "label": "plan", "path": "/path/PLAN.md" } ] }
```

A missing adapter, a non-zero exit, invalid JSON or a timeout (10 s) all count as "no
answer". Keep `check` fast. For example, only look for state files when `phase` is
`compact`.

## Customize it with your AI

The mod is small on purpose. To change what it does, open a Claude Code session in this
directory with `claude --plugin-dir .` and describe the change, for example:

- "Compact at 50 % in sessions whose directory is under ~/work/clients."
- "Add a section 'Customer-facing changes' to the outline."
- "Also keep the last three tool results verbatim."
- "Write the handoff into the repo's docs/handoffs/ instead of my home directory."

Most of these need no code: the outline is a file, the threshold and paths are options,
and per-session decisions belong in an adapter script. `hooks/register.js` keeps every
decision in its own function with a comment saying what it decides. After a change, run
`claude plugin validate --strict .claude-plugin/plugin.json`, `claude plugin test` and `bash tests/offline/run.sh`.

## Limits

- Runs where mods run: the CLI and the Desktop app's Code tab. In `claude -p` the hooks run,
  but nothing is drawn.
- The handoff costs one fork per compaction. That is mostly cache reads plus the handoff's
  own output, about the cost of the summary Claude Code would otherwise write.
- A compaction the mod starts happens between turns. If a new turn starts while the fork is
  writing, the attempt is dropped and retried two minutes later.

## License

MIT
