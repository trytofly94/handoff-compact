// Run with `claude plugin test` in this directory (Claude Code 2.1.287+, mods enabled).
import { expect, mock, test } from 'claude-code/testing'

const MESSAGES = [
  { role: 'user', text: 'Rework the export', toolUses: [] },
  { role: 'assistant', text: 'Reading export.sh first', toolUses: [] },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'export.sh contents', isError: false }] },
  { role: 'user', text: 'And <system-reminder>internal</system-reminder>test it', toolUses: [] },
  { role: 'assistant', text: 'Tests pass', toolUses: [] },
]

const FORK = {
  text: '1. GOAL: rework the export\n2. STATE: done',
  usage: { input_tokens: 1, output_tokens: 50, cache_read_input_tokens: 90000, cache_creation_input_tokens: 0 },
}

function stubs(on, opts: { fork?: any; adapterOut?: string; writeFails?: boolean; logs?: string[] } = {}) {
  const files = new Map<string, string>()
  on('env.get', ($, e) => ({ value: ({ HOME: '/home/t' } as Record<string, string>)[e.name] }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('model.fork', () => ({ value: opts.fork === undefined ? FORK : opts.fork }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', ($, e) => { if (opts.writeFails) throw new Error('read-only'); files.set(e.path, e.text); return { value: undefined } })
  on('process.run', ($, e) => ({ value: { exitCode: 0, stdout: e.argv[0] === 'mkdir' ? '' : (opts.adapterOut ?? '{}'), stderr: '' } }))
  on('ui.log', ($, e) => { opts.logs?.push(e.text); return { value: undefined } })
  return files
}

test('an automatic compaction is answered with the forked handoff', async ($, on) => {
  const files = stubs(on)
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'CORE', toolUses: [] }] }))
  const r = await $.session.compact({ trigger: 'auto', messages: MESSAGES })
  expect(r.messages.length).toBe(1)
  const text = r.messages[0].text
  expect(text).toMatch(/^\[handoff-compact\]/)
  expect(text).toContain('1. GOAL: rework the export')
  expect(text).toContain('> Rework the export')
  expect(text).toContain('> And test it') // reminders stripped
  expect(text).not.toContain('internal')
  expect(text).not.toContain('CORE')
  expect([...files.keys()].some(p => p.startsWith('/home/t/.claude/handoffs/sess-1-'))).toBe(true)
})

test('a second compaction carries the user prompts over from the first handoff', async ($, on) => {
  stubs(on)
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'CORE', toolUses: [] }] }))
  const first = (await $.session.compact({ trigger: 'auto', messages: MESSAGES })).messages[0].text
  const later = [
    { role: 'user', text: first, toolUses: [] },
    { role: 'assistant', text: 'Continuing with the tests', toolUses: [] },
    { role: 'user', text: 'Also update the docs', toolUses: [] },
  ]
  const second = (await $.session.compact({ trigger: 'auto', messages: later })).messages[0].text
  const tail = second.slice(second.indexOf('## Last'))
  expect(tail).toContain('> Rework the export') // from the first handoff
  expect(tail).toContain('> And test it')
  expect(tail).toContain('> Also update the docs')
  expect(tail).toContain('- Tests pass') // an answer from before the first compaction
  expect(tail).toContain('- Continuing with the tests')
  expect(tail).not.toContain('[handoff-compact]') // the first handoff is not quoted as a prompt
  expect(tail.indexOf('Rework the export')).toBeLessThan(tail.indexOf('Also update the docs'))
})

test('a handoff quoted as a prompt by an older version is not carried over', async ($, on) => {
  stubs(on)
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'CORE', toolUses: [] }] }))
  const old = [
    '[handoff-compact] This session was compacted. The handoff below replaces the earlier conversation.',
    '',
    '# Handoff 2026-10-02T11:45:30.597Z (auto)',
    '1. GOAL: read the docs',
    '',
    '## Last 2 user prompts (verbatim, oldest first)',
    '> [handoff-compact] This session was compacted. The handoff below replaces',
    '> ',
    '> # Handoff 2026-10-02T11:43:25.466Z (auto)',
    '',
    '> Stop reading now',
    '',
    '## Last 1 answers (shortened, oldest first)',
    '- Reading on from line 6001',
  ].join('\n')
  const r = await $.session.compact({ trigger: 'auto', messages: [{ role: 'user', text: old, toolUses: [] }] })
  const tail = r.messages[0].text.slice(r.messages[0].text.indexOf('## Last'))
  expect(tail).toContain('## Last 1 user prompts')
  expect(tail).toContain('> Stop reading now')
  expect(tail).not.toContain('[handoff-compact]')
  expect(tail).toContain('- Reading on from line 6001')
})

test('without an adapter the handoff says that no state files are listed', async ($, on) => {
  stubs(on)
  on('session.compact', () => ({ messages: [] }))
  const r = await $.session.compact({ trigger: 'manual', messages: MESSAGES })
  expect(r.messages[0].text).toContain('- none listed')
})

test('a failed fork hands the compaction back with the outline as instructions', async ($, on) => {
  stubs(on, { fork: null })
  let seen: string | undefined
  // Stands for Claude Code's own compaction: a compaction always leaves at least one message.
  on('session.compact', ($, e) => { seen = e.instructions; return { messages: [{ role: 'user', text: 'CORE', toolUses: [] }] } })
  await $.session.compact({ trigger: 'manual', instructions: 'stress the tests', messages: MESSAGES })
  expect(seen).toContain('stress the tests')
  expect(seen).toContain('9. VERIFY')
})

// ── /compact classic: Claude Code's own summary, this once ──

function core(on) {
  const seen = { calls: 0, instructions: [] as (string | undefined)[] }
  on('session.compact', ($, e) => { seen.calls++; seen.instructions.push(e.instructions); return { messages: [{ role: 'user', text: 'CORE', toolUses: [] }] } })
  return seen
}

test('/compact classic goes to Claude Code without a fork and without instructions', async ($, on) => {
  stubs(on, { fork: { text: 'MUST NOT BE USED', usage: FORK.usage } })
  const seen = core(on)
  const r = await $.session.compact({ trigger: 'manual', instructions: 'classic', messages: MESSAGES })
  expect(r.messages[0].text).toBe('CORE')
  expect(seen.instructions).toEqual([undefined])
})

test('/compact classic <text> passes the rest on as instructions', async ($, on) => {
  stubs(on)
  const seen = core(on)
  const r = await $.session.compact({ trigger: 'manual', instructions: '  Classic   keep the test plan\nand the commit list', messages: MESSAGES })
  expect(r.messages[0].text).toBe('CORE')
  expect(seen.instructions).toEqual(['keep the test plan\nand the commit list'])
})

test('"classical" or "classic" later in the text is a normal handoff', async ($, on) => {
  stubs(on)
  const seen = core(on)
  for (const instructions of ['classical music', 'stress the classic parts']) {
    const r = await $.session.compact({ trigger: 'manual', instructions, messages: MESSAGES })
    expect(r.messages[0].text).toMatch(/^\[handoff-compact\]/)
  }
  expect(seen.calls).toBe(0)
})

test('the keyword counts only for /compact, not for a compaction a plugin asks for', async ($, on) => {
  stubs(on)
  const seen = core(on)
  const r = await $.session.compact({ trigger: 'plugin', instructions: 'classic', messages: MESSAGES })
  expect(r.messages[0].text).toMatch(/^\[handoff-compact\]/)
  expect(seen.calls).toBe(0)
})

test('pre-compaction is skipped by default', async ($, on) => {
  stubs(on)
  on('session.compact', () => ({ messages: [] }))
  const r = await $.session.compact({ trigger: 'precompute', messages: MESSAGES })
  expect(r.skip).toBeDefined()
})

test("a subagent's compaction goes to Claude Code unchanged", async ($, on) => {
  stubs(on)
  on('session.compact', () => ({ messages: [{ role: 'user', text: 'CORE', toolUses: [] }] }))
  const r = await $.session.compact({ trigger: 'auto', agentId: 'a1', messages: MESSAGES })
  expect(r.messages[0].text).toBe('CORE')
})

// ── trigger: core (default) — Claude Code decides when; the mod does not measure ──

test('by default the mod does not compact on its own', async ($, on) => {
  // Everything a self-triggered compaction would need is stubbed, so only the
  // trigger decides.
  const { clock, seen } = own(on)
  await $.session.measure({ ...MEASURE, context: { tokens: 990000, window: 1000000, percent: 99 } })
  await $.turn.complete(END)
  await clock.advance(0)
  expect(seen.compacts).toHaveLength(0)
  expect(seen.submits).toHaveLength(0)
})

test('the message names no file when saving the handoff failed', async ($, on) => {
  stubs(on, { writeFails: true })
  on('session.compact', () => ({ messages: [] }))
  const r = await $.session.compact({ trigger: 'auto', messages: MESSAGES })
  expect(r.messages[0].text).toContain('1. GOAL: rework the export')
  expect(r.messages[0].text).not.toContain('saved at')
})

// ── trigger: self — measured mid-turn, compacted when the main turn ends ──

const SELF = { trigger: 'self', threshold: 50, window: 100000 }
const MEASURE = { context: { tokens: 60000, window: 1000000, percent: 6 }, rateLimits: [], changed: ['context'] }
const END = { answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' }

function own(on) {
  const clock = mock.clock(on)
  const seen = { compacts: [] as string[], submits: [] as string[], logs: [] as string[] }
  stubs(on, { logs: seen.logs })
  on('session.messages', () => ({ value: MESSAGES }))
  on('session.compact', ($, e) => { seen.compacts.push(e.instructions ?? ''); return { messages: [{ role: 'user', text: 'CORE', toolUses: [] }] } })
  on('prompt.submit', ($, e) => { seen.submits.push(e.text); return { text: e.text } })
  on('ui.toast', () => ({ value: undefined }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  return { clock, seen }
}

test('crossing the threshold mid-turn compacts only once the main turn ends', { options: SELF }, async ($, on) => {
  const { clock, seen } = own(on)
  await $.session.measure(MEASURE)
  await clock.advance(0)
  expect(seen.compacts).toHaveLength(0)
  await $.turn.complete({ ...END, agentId: 'a1' }) // a subagent's turn
  await clock.advance(0)
  expect(seen.compacts).toHaveLength(0)
  await $.turn.complete(END)
  await clock.advance(0)
  expect(seen.compacts).toEqual(['']) // with a handoff: no instructions for Claude Code's summary
})

test('an interrupted turn does not compact; the next answered one does', { options: SELF }, async ($, on) => {
  const { clock, seen } = own(on)
  await $.session.measure(MEASURE)
  await $.turn.complete({ ...END, reason: 'aborted', isAborted: true })
  await clock.advance(0)
  expect(seen.compacts).toHaveLength(0)
  await $.turn.complete({ ...END, turnId: 't2' })
  await clock.advance(0)
  expect(seen.compacts).toHaveLength(1)
})

test('below the threshold a turn end does not compact', { options: SELF }, async ($, on) => {
  const { clock, seen } = own(on)
  await $.session.measure({ ...MEASURE, context: { tokens: 40000, window: 1000000, percent: 4 } })
  await $.turn.complete(END)
  await clock.advance(0)
  expect(seen.compacts).toHaveLength(0)
})

// Claude Code skips the mod's own session.compact hook for a compaction the mod
// raised: Claude Code summarizes, and the handoff follows as the next prompt.
test('self, autoContinue never: the handoff follows, with the instruction to wait', { options: SELF }, async ($, on) => {
  const { clock, seen } = own(on)
  await $.session.measure(MEASURE)
  await $.turn.complete(END)
  await clock.advance(0)
  expect(seen.logs).toEqual([])
  expect(seen.submits).toHaveLength(1)
  expect(seen.submits[0]).toContain('1. GOAL: rework the export')
  expect(seen.submits[0]).toContain('wait for the next instruction')
})

test('self, autoContinue always: the handoff follows, with its next step', { options: { ...SELF, autoContinue: 'always' } }, async ($, on) => {
  const { clock, seen } = own(on)
  await $.session.measure(MEASURE)
  await $.turn.complete(END)
  await clock.advance(0)
  expect(seen.submits).toHaveLength(1)
  expect(seen.submits[0]).toContain('carry on with its NEXT STEP')
})
