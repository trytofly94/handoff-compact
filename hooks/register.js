// handoff-compact — compact a Claude Code session into a structured handoff.
//
// Claude Code compacts a long conversation by summarizing it with its own
// prompt. That summary keeps what seems important to a summarizer and tends to
// drop what the next stretch of work needs most: the reason behind a decision,
// the approaches already ruled out, the exact command that proves the state.
//
// This mod answers the compaction itself:
//   1. Whenever Claude Code compacts (automatically, at its compact window, or
//      because you ran /compact), a FORK of the session writes a handoff along
//      a fixed outline. The fork reads the conversation from the prompt cache
//      and has no tools.
//   2. The last N prompts and answers are added word for word, plus the paths
//      of files that hold the project's state (from the optional adapter).
//   3. The conversation is replaced by that one handoff message. The handoff is
//      also saved as a Markdown file.
//   4. With `trigger: self` the mod also decides WHEN: at `threshold` % of the
//      compact window, after the turn. Claude Code then skips this mod's own
//      session.compact hook (it raised the event itself), so Claude Code writes
//      its summary and the handoff follows as the next message: two summaries.
//      Hence the default `core`: let Claude Code trigger, answer with the handoff.
//      Optionally the session continues on its own after a self-triggered one.
//
// Safety net: if the fork fails (cold cache, API error) the mod hands the
// compaction back to Claude Code, with the outline as instructions. If this
// module throws, Claude Code skips it and compacts as usual.
//
// Customizing: everything a user is likely to change is an option in
// plugin.json (userConfig) or a function below with a comment saying what it
// decides. The adapter (see README.md) connects the mod to your own setup
// without editing this file.

// The outline every handoff must follow. Replace it with the `outlineFile`
// option rather than editing it here, so updates of the mod don't undo it.
const DEFAULT_OUTLINE = [
  '1. GOAL: what should exist at the end, in one sentence.',
  '2. STATE: what is done, and what proves it (test, command, commit).',
  '3. IN PROGRESS: which step, which file, and why this one.',
  '4. NEXT STEP: concrete enough for a stranger to carry out.',
  '5. DECISIONS AND REASONS: what the code itself does not tell.',
  '6. RULED OUT: approaches tried or rejected, so nobody tries them again.',
  '7. BLOCKED / OPEN QUESTIONS: including what you meant to ask the user.',
  '8. FILES AND COMMITS TOUCHED.',
  '9. VERIFY: the command that shows whether the state is what this says.',
]

const CONTINUE_TEXT =
  'The session was compacted; the handoff above replaces the earlier conversation. ' +
  'Read the state files it lists first, then carry on with its NEXT STEP.'

const WAIT_TEXT =
  'The session was compacted; the handoff above replaces the earlier conversation. ' +
  'Reply only with "Handoff read." and wait for the next instruction.'

const ADAPTER_CACHE_MS = 5 * 60 * 1000

let opts = { trigger: 'core', threshold: 70, window: 0, keepVerbatim: 10, autoContinue: 'never', precompute: 'skip', handoffDir: '', outlineFile: '', adapter: '' }
let armed = true // false while a compaction this mod started is running
let due = false // the threshold was crossed; compact when the main turn ends
let cooldownUntil = 0 // after a failed attempt, don't retry on every turn
let adapterCache = null // { at, value } from the last 'check' call

// ── Small helpers ──────────────────────────────────────────────────────────────
function parseWindow(raw) {
  // Same grammar as Claude Code's --autocompact: "200000", "200k", "200" (= thousands)
  if (raw === undefined || raw === null || raw === '') return null
  const s = String(raw).trim()
  if (!s || s.length > 8) return null
  const suffix = /[kK]$/.test(s)
  const digits = suffix ? s.slice(0, -1) : s
  if (!/^\d+$/.test(digits)) return null
  let n = parseInt(digits, 10)
  if (suffix || n <= 1000) n *= 1000
  return n >= 20000 && n <= 1000000 ? n : null
}

async function readJson($, path) {
  try {
    if (!(await $.fs.exists(path))) return null
    return JSON.parse(await $.fs.read(path))
  } catch {
    return null
  }
}

function expandHome(path, home) {
  return path && path.startsWith('~/') ? home + path.slice(1) : path
}

function stripReminders(text) {
  return String(text || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
}

function clip(text, max) {
  return text.length > max ? text.slice(0, max) + ' […]' : text
}

// ── The adapter: your setup's answers, as JSON over stdin/stdout ───────────────
// Called with { version, phase, sessionId, cwd, trigger, context } on stdin.
// May answer { window, threshold, stateFiles: [{label, path}], autoContinue, notes }.
// Any failure (missing, non-zero exit, bad JSON, timeout) counts as "no answer".
async function askAdapter($, phase, extra) {
  if (!opts.adapter) return {}
  if (phase === 'check' && adapterCache && Date.now() - adapterCache.at < ADAPTER_CACHE_MS) return adapterCache.value
  let value = {}
  try {
    const home = await $.env.get('HOME')
    const input = JSON.stringify({ version: 1, phase, sessionId: await $.session.id(), cwd: await $.session.cwd(), ...extra })
    const r = await $.process.run([expandHome(opts.adapter, home)], { stdin: input, timeoutMs: 10000 })
    if (r.exitCode === 0 && r.stdout.trim()) value = JSON.parse(r.stdout) || {}
  } catch (err) {
    $.ui.log('handoff-compact: adapter failed: ' + String(err), { to: 'debug' })
  }
  if (phase === 'check') adapterCache = { at: Date.now(), value }
  return value
}

// Which window the threshold is measured against. Decides WHEN this mod acts.
async function compactWindow($, adapter, contextWindow) {
  if (opts.window) return opts.window
  const fromAdapter = parseWindow(adapter.window)
  if (fromAdapter) return fromAdapter
  const fromEnv = parseWindow(await $.env.get('CLAUDE_CODE_AUTO_COMPACT_WINDOW'))
  if (fromEnv) return fromEnv
  const settings = await readJson($, (await $.env.get('HOME')) + '/.claude/settings.json')
  return (settings && parseWindow(settings.autoCompactWindow)) || contextWindow || null
}

// ── Building the handoff ───────────────────────────────────────────────────────
async function outline($) {
  if (!opts.outlineFile) return DEFAULT_OUTLINE
  try {
    const text = await $.fs.read(expandHome(opts.outlineFile, await $.env.get('HOME')))
    const lines = text.split('\n').map(l => l.trimEnd()).filter(l => l.trim())
    return lines.length ? lines : DEFAULT_OUTLINE
  } catch {
    return DEFAULT_OUTLINE
  }
}

const HANDOFF_PREFIX = '[handoff-compact]'

// The latest n prompts and answers, verbatim: the part of the handoff that
// doesn't depend on the model remembering it. A previous handoff in the
// conversation is no prompt of the user's: its own verbatim tail is carried
// over instead, so the user's words survive any number of compactions.
function verbatimTail(messages, n) {
  if (!n) return { prompts: [], answers: [] }
  const list = Array.isArray(messages) ? messages : []
  const prompts = []
  const answers = []
  for (const m of list) {
    const text = stripReminders(m.text)
    if (m.role === 'user' && !(m.toolResults && m.toolResults.length)) {
      if (text.startsWith(HANDOFF_PREFIX)) {
        const carried = carriedTail(text)
        prompts.push(...carried.prompts)
        answers.push(...carried.answers)
      } else if (text) prompts.push(clip(text, 1000))
    } else if (m.role === 'assistant' && text) answers.push(clip(text, 600))
  }
  return { prompts: prompts.slice(-n), answers: answers.slice(-n) }
}

// Reads the verbatim tail back out of a handoff this mod wrote (see the
// sections at the end of buildHandoff).
function carriedTail(text) {
  const p = [...text.matchAll(/^## Last \d+ user prompts \(verbatim, oldest first\)$/gm)].pop()
  const a = [...text.matchAll(/^## Last \d+ answers \(shortened, oldest first\)$/gm)].pop()
  if (!p || !a || a.index < p.index) return { prompts: [], answers: [] }
  const prompts = text
    .slice(p.index + p[0].length, a.index)
    .split(/\n\s*\n/)
    .map(block => block.split('\n').filter(l => l.startsWith('>')).map(l => l.replace(/^> ?/, '')).join('\n').trim())
    .filter(Boolean)
  const answers = text
    .slice(a.index + a[0].length)
    .split('\n')
    .filter(l => l.startsWith('- '))
    .map(l => l.slice(2))
  return { prompts, answers }
}

function forkPrompt(sections, instructions) {
  return [
    'Write the handoff for this session NOW. It is about to replace the entire conversation;',
    'whatever it leaves out is gone afterwards. Use no tools, reply with the handoff only.',
    'Prefer exact paths, commands, commit hashes and numbers over descriptions.',
    'The latest user message wins: if it changes the task or the plan, the next step follows it.',
    'Write in the language the conversation is in.',
    '',
    'Outline. Every section must appear, with "nothing" if that is the answer:',
    ...sections,
    ...(instructions ? ['', 'When compacting, the user asked to stress: ' + instructions] : []),
  ].join('\n')
}

async function buildHandoff($, messages, trigger, instructions) {
  const sections = await outline($)
  const fork = await $.model.fork({ prompt: forkPrompt(sections, instructions) })
  if (!fork || !fork.text || !fork.text.trim()) return null
  const home = await $.env.get('HOME')
  const id = await $.session.id()
  const adapter = await askAdapter($, 'compact', { trigger })
  const files = Array.isArray(adapter.stateFiles) ? adapter.stateFiles.filter(f => f && f.path) : []
  const tail = verbatimTail(messages, opts.keepVerbatim)
  const now = new Date().toISOString()

  const doc = [
    '# Handoff ' + now + ' (' + trigger + ')',
    '',
    fork.text.trim(),
    ...(adapter.notes ? ['', String(adapter.notes).trim()] : []),
    '',
    '## State files: read these before continuing',
    ...(files.length ? files.map(f => '- ' + (f.label || 'file') + ': ' + f.path) : ['- none listed']),
    '',
    '## Last ' + tail.prompts.length + ' user prompts (verbatim, oldest first)',
    ...tail.prompts.map(t => '> ' + t.replace(/\n/g, '\n> ') + '\n'),
    '## Last ' + tail.answers.length + ' answers (shortened, oldest first)',
    ...tail.answers.map(t => '- ' + t.replace(/\n/g, ' ')),
  ].join('\n')

  // The file is a copy for people and for later. If writing it fails, the
  // message below still carries the handoff, so this doesn't abort.
  const dir = expandHome(opts.handoffDir, home) || home + '/.claude/handoffs'
  const path = dir + '/' + id + '-' + now.replace(/[:.]/g, '-') + '.md'
  let saved = false
  try {
    await $.process.run(['mkdir', '-p', dir], { timeoutMs: 5000 })
    await $.fs.write(path, doc + '\n')
    saved = true
  } catch {}

  const message = HANDOFF_PREFIX + ' This session was compacted. The handoff below replaces the earlier conversation' + (saved ? ' (saved at ' + path + ')' : '') + '.\n\n' + doc
  return { message, path: saved ? path : null, usage: fork.usage, autoContinue: adapter.autoContinue === true }
}

// "/compact classic [what to stress]": Claude Code's own summary, this once.
// Only for the person's /compact, and the keyword has to come first and stand
// alone, so "/compact classical music" is a normal handoff.
function classicRequest(e) {
  if (e.trigger !== 'manual' || typeof e.instructions !== 'string') return null
  const m = /^\s*classic(?:\s+([\s\S]*))?$/i.exec(e.instructions)
  return m ? { rest: (m[1] || '').trim() } : null
}

// Whether to start the next turn by itself after a compaction this mod started.
function shouldContinue(handoff) {
  if (opts.autoContinue === 'always') return true
  if (opts.autoContinue === 'adapter') return !!(handoff && handoff.autoContinue)
  return false
}

// ── Compacting on our own, between turns ──────────────────────────────────────
async function run($) {
  try {
    const handoff = await buildHandoff($, await $.session.messages(), 'plugin')
    // Claude Code skips this mod's own session.compact hook for a compaction
    // the mod raised, so Claude Code summarizes; without a handoff, at least
    // along the outline.
    const r = await $.session.compact(handoff ? {} : { instructions: (await outline($)).join('\n') })
    if (r && r.skip) {
      $.ui.log('handoff-compact: compaction refused: ' + r.skip, { to: 'debug' })
      cooldownUntil = Date.now() + 10 * 60 * 1000
      return
    }
    // The handoff follows the summary as the next prompt, so it isn't lost. A
    // prompt always starts a turn; without autoContinue that turn only
    // acknowledges it.
    if (handoff) {
      $.prompt.submit({ text: handoff.message + '\n\n' + (shouldContinue(handoff) ? CONTINUE_TEXT : WAIT_TEXT) })
      $.ui.toast('Compacted into a handoff' + (handoff.path ? ': ' + handoff.path : ''))
    } else if (shouldContinue(handoff)) {
      $.prompt.submit({ text: CONTINUE_TEXT })
    }
  } catch (err) {
    // Typically a new turn had already started (compact refuses then).
    // Try again at a later turn end, not on every turn.
    $.ui.log('handoff-compact: ' + String(err), { to: 'debug' })
    cooldownUntil = Date.now() + 2 * 60 * 1000
  } finally {
    armed = true
  }
}

export function register(on, options) {
  opts = { ...opts, ...(options || {}) }

  if (opts.trigger === 'self') registerSelfTrigger(on)

  // Every compaction passes here: Claude Code's own, /compact, and (from
  // another plugin's call) a plugin's. Not one this mod raised itself.
  on('session.compact', async ($, e, next) => {
    if (e.agentId) return next(e) // subagents compact their own transcript the usual way
    if (e.trigger === 'precompute') {
      return opts.precompute === 'core' ? next(e) : { skip: 'handoff-compact writes the handoff at compaction time' }
    }
    const classic = classicRequest(e)
    if (classic) {
      const { instructions, ...plain } = e
      return next(classic.rest ? { ...e, instructions: classic.rest } : plain)
    }
    const handoff = await buildHandoff($, e.messages, e.trigger, e.instructions)
    if (!handoff) {
      const sections = (await outline($)).join('\n')
      const instructions = e.instructions ? e.instructions + '\n\n' + sections : 'Structure the summary exactly along these sections:\n' + sections
      return next({ ...e, instructions })
    }
    return { messages: [{ role: 'user', text: handoff.message, toolUses: [] }] }
  })
}

// trigger: self. Claude Code measures the context after every response, i.e.
// also in the middle of a turn, while $.session.compact() is refused. So the
// measurement only marks the compaction as due; turn.complete starts it.
function registerSelfTrigger(on) {
  on('session.measure', async ($, e, next) => {
    const result = await next(e)
    if (!armed || due || Date.now() < cooldownUntil) return result
    const used = e.context && e.context.tokens
    if (!used) return result
    const adapter = await askAdapter($, 'check', { trigger: null, context: e.context })
    const window = await compactWindow($, adapter, e.context.window)
    const threshold = Number(adapter.threshold) || opts.threshold
    if (!window || (100 * used) / window < threshold) return result
    due = true
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // A subagent's turn is not the end of the session's turn; an interrupted or
    // failed turn means someone is busy with the session: wait for the next end.
    if (e.agentId || !due || !armed || e.reason !== 'answer') return result
    due = false
    armed = false
    // Not inside this hook: the turn still ends through it.
    $.clock.after(0, () => run($))
    return result
  })
}
