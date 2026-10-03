# Changelog

## 0.2.0 (unreleased)

- New option `trigger`, default `core`: Claude Code decides when to compact, and the handoff
  replaces its summary (one model call). The mod's own threshold is now `trigger: self`.
  Reason, from the first live pilot: Claude Code skips a plugin's own `session.compact` hook
  for a compaction that plugin started, so a self-triggered compaction always ends in Claude
  Code's summary plus the handoff.
- Fixed (`self`): the mod compacted from `session.measure`, which also fires mid-turn, where
  Claude Code refuses a compaction; the fork's work was lost. It now waits for the main turn
  to end with an answer.
- `self`: the handoff always follows as a prompt; `autoContinue: never` asks only for an
  acknowledgement (0.1 started the next step regardless).
- The handoff message names the saved file only if writing it succeeded.
- Repeated compactions: the verbatim tail carries over the prompts and answers of the previous
  handoff instead of quoting that handoff as the last "user prompt" (seen in the pilot from
  the second compaction on: the user's own prompt was gone). A handoff that 0.1 had quoted as
  a prompt is dropped when carried over.
- `/compact classic [instructions]`: Claude Code's own summary for this one compaction, the
  rest of the text as its instructions. Only for `/compact`, only as the first word.
- The fork prompt says that the latest user message wins: in the pilot a compaction right
  after "stop reading" still planned "keep reading" as the next step.

## 0.1.0 (unreleased)

- First version: compaction answered with a forked handoff, verbatim tail, adapter protocol,
  options for threshold, window, outline, handoff directory, auto-continue and pre-compaction.
- Not yet tested against a live session (mods not enabled on the author's account yet).
