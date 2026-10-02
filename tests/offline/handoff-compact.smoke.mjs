import { makeHost } from './harness.mjs'
const S = process.argv[2], MOD = process.argv[3] || 'handoff-compact.mjs'
let fails = 0, n = 0
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++ }
const fork = { text: '1. GOAL: X\n9. VERIFY: make test', usage: { output_tokens: 40 } }
const core = e => ({ messages: [{ role: 'user', text: 'CORE:' + (e.instructions || '') }] })
const load = async () => (await import(S + '/' + MOD + '?' + (n++))).register
const OPTS = { threshold: 70, window: 0, keepVerbatim: 10, autoContinue: 'adapter', precompute: 'skip', handoffDir: '~/.local/state/cc/handoff', outlineFile: '', adapter: '/adapter' }

// 1) With an adapter: window, state files and the continue decision come from it
{
  const calls = []
  const h = makeHost({ env: { HOME: '/h' }, fork, compactCore: core, adapterOut: i => { calls.push(i.phase); return JSON.stringify(i.phase === 'compact' ? { window: '200k', autoContinue: true, stateFiles: [{ label: 'sitrep', path: '/state/board' }] } : { window: '200k' }) } })
  ;(await load())(h.on, OPTS)
  await h.fire('session.measure', { context: { tokens: 100000, window: 1000000 } }, e => e); await h.flush()
  ok(h.log.submits.length === 0, 'adapter: 50 % of 200k → nothing happens')
  await h.fire('session.measure', { context: { tokens: 150000, window: 1000000 } }, e => e); await h.flush()
  const hf = [...h.files.keys()].find(k => k.startsWith('/h/.local/state/cc/handoff/sess-1-'))
  ok(!!hf && h.files.get(hf).includes('- sitrep: /state/board'), 'adapter: 75 % → handoff in handoffDir, with state file')
  ok(h.log.submits.length === 1 && h.log.submits[0].startsWith('The session was compacted'), 'adapter: autoContinue=true → exactly one continue prompt')
  ok(calls.filter(c => c === 'check').length === 1, 'adapter: check answer cached for 5 min (1 call for 2 measurements)')
}
// 2) No adapter, no window: falls back to the model window; autoContinue never
{
  const h = makeHost({ env: { HOME: '/h' }, fork, compactCore: core })
  ;(await load())(h.on, { ...OPTS, adapter: '', autoContinue: 'never', handoffDir: '' })
  await h.fire('session.measure', { context: { tokens: 600000, window: 1000000 } }, e => e); await h.flush()
  ok(h.log.submits.length === 0 && ![...h.files.keys()].some(k => k.includes('/handoffs/')), 'default: 60 % of the model window → nothing happens')
  await h.fire('session.measure', { context: { tokens: 750000, window: 1000000 } }, e => e); await h.flush()
  ok([...h.files.keys()].some(k => k.startsWith('/h/.claude/handoffs/sess-1-')), 'default: 75 % → handoff in ~/.claude/handoffs')
  ok(h.log.submits.length === 0 && h.log.toasts.length === 1, 'default: autoContinue never → no continue prompt, a toast')
}
// 3) outlineFile replaces the outline in the fork prompt
{
  let prompt = ''
  const h = makeHost({ env: { HOME: '/h' }, fork, compactCore: core })
  h.files.set('/h/outline.txt', 'A. EINS\n\nB. ZWEI\n')
  h.$.model.fork = async r => { prompt = r.prompt; return fork }
  ;(await load())(h.on, { ...OPTS, adapter: '', outlineFile: '~/outline.txt' })
  await h.fire('session.compact', { trigger: 'manual', messages: [] }, core)
  ok(prompt.includes('A. EINS\nB. ZWEI') && !prompt.includes('9. VERIFY'), 'outlineFile: custom outline instead of the default')
}
// 4) Failed fork → core with outline; precompute skipped; subagents pass through; the window option wins
{
  const g = makeHost({ env: { HOME: '/h' }, fork: null, compactCore: core })
  ;(await load())(g.on, { ...OPTS, adapter: '' })
  const r = await g.fire('session.compact', { trigger: 'manual', instructions: 'Tests!', messages: [] }, core)
  ok(r.messages[0].text.startsWith('CORE:Tests!') && r.messages[0].text.includes('9. VERIFY'), 'fork returns null → core compacts with the instructions + outline')
  ok(typeof (await g.fire('session.compact', { trigger: 'precompute', messages: [] }, core)).skip === 'string', 'precompute → skipped')
  const sa = makeHost({ env: { HOME: '/h' }, fork, compactCore: core })
  ;(await load())(sa.on, { ...OPTS, adapter: '' })
  ok((await sa.fire('session.compact', { trigger: 'auto', agentId: 'a', messages: [] }, () => ({ messages: [{ text: 'CORE' }] }))).messages[0].text === 'CORE', 'subagent → core, unchanged (even with a working fork)')
  const w = makeHost({ env: { HOME: '/h', CLAUDE_CODE_AUTO_COMPACT_WINDOW: '900k' }, fork, compactCore: core })
  ;(await load())(w.on, { ...OPTS, adapter: '', window: 100000 })
  await w.fire('session.measure', { context: { tokens: 80000, window: 1000000 } }, e => e); await w.flush()
  ok(w.log.toasts.length === 1, 'window option (100k) beats the env var (900k): 80k → compacts')
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
