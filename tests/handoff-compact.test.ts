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

function stubs(on, opts: { fork?: any; adapterOut?: string } = {}) {
  const files = new Map<string, string>()
  on('env.get', ($, e) => ({ value: ({ HOME: '/home/t' } as Record<string, string>)[e.name] }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('model.fork', () => ({ value: opts.fork === undefined ? FORK : opts.fork }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', ($, e) => { files.set(e.path, e.text); return { value: undefined } })
  on('process.run', ($, e) => ({ value: { exitCode: 0, stdout: e.argv[0] === 'mkdir' ? '' : (opts.adapterOut ?? '{}'), stderr: '' } }))
  on('ui.log', () => ({ value: undefined }))
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

// ── Compacting on our own: the threshold is measured mid-turn, the compaction waits for the turn's end ──

const OWN = { options: { threshold: 50, window: 100000 } }
const MEASURE = { context: { tokens: 60000, window: 1000000, percent: 6 }, rateLimits: [], changed: ['context'] }
const END = { answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' }

function own(on) {
  const clock = mock.clock(on)
  const seen = { compacts: 0, submits: [] as string[] }
  stubs(on)
  on('session.messages', () => ({ value: MESSAGES }))
  on('session.compact', () => { seen.compacts++; return { messages: [{ role: 'user', text: 'CORE', toolUses: [] }] } })
  on('prompt.submit', ($, e) => { seen.submits.push(e.text); return { text: e.text } })
  on('ui.toast', () => ({ value: undefined }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  return { clock, seen }
}

test('crossing the threshold mid-turn compacts only once the main turn ends', OWN, async ($, on) => {
  const { clock, seen } = own(on)
  await $.session.measure(MEASURE)
  await clock.advance(0)
  expect(seen.compacts).toBe(0)
  await $.turn.complete({ ...END, agentId: 'a1' }) // a subagent's turn
  await clock.advance(0)
  expect(seen.compacts).toBe(0)
  await $.turn.complete(END)
  await clock.advance(0)
  expect(seen.compacts).toBe(1)
})

test('an interrupted turn does not compact; the next answered one does', OWN, async ($, on) => {
  const { clock, seen } = own(on)
  await $.session.measure(MEASURE)
  await $.turn.complete({ ...END, reason: 'aborted', isAborted: true })
  await clock.advance(0)
  expect(seen.compacts).toBe(0)
  await $.turn.complete({ ...END, turnId: 't2' })
  await clock.advance(0)
  expect(seen.compacts).toBe(1)
})

test('below the threshold a turn end does not compact', OWN, async ($, on) => {
  const { clock, seen } = own(on)
  await $.session.measure({ ...MEASURE, context: { tokens: 40000, window: 1000000, percent: 4 } })
  await $.turn.complete(END)
  await clock.advance(0)
  expect(seen.compacts).toBe(0)
})
