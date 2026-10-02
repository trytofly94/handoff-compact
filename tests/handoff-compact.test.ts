// Run with `claude plugin test` in this directory (Claude Code 2.1.287+, mods enabled).
import { expect, test } from 'claude-code/testing'

const MESSAGES = [
  { role: 'user', text: 'Rework the export', toolUses: [] },
  { role: 'assistant', text: 'Reading export.sh first', toolUses: [] },
  { role: 'user', text: '', toolUses: [], toolResults: [{ id: 't1' }] },
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
  on('session.compact', ($, e) => { seen = e.instructions; return { messages: [] } })
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
