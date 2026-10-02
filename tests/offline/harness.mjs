// A minimal stand-in for Claude Code's hook chain, for smoke tests without Claude Code.
export function makeHost({ root = '/dev/mods/x', env = {}, fork, compactCore, files = new Map(), adapterOut = () => '{}' } = {}) {
  const hooks = []
  const log = { submits: [], toasts: [], logs: [], runs: [] }
  const timers = []
  const match = (m, e) => !m || Object.entries(m).every(([k, v]) => v instanceof RegExp ? v.test(e[k]) : Array.isArray(v) ? v.includes(e[k]) : e[k] === v)
  const on = (name, a, b) => { const [m, fn] = b ? [a, b] : [null, a]; hooks.push({ name, m, fn }); return { catch() {} } }
  async function fire(name, e, core) {
    const chain = hooks.filter(h => h.name === name && match(h.m, e))
    const run = async (i, ev) => i < chain.length ? chain[i].fn($, Object.freeze(ev), x => run(i + 1, x)) : core(ev)
    return run(0, e)
  }
  const $ = {
    plugin: { name: 'x', root },
    env: { get: async n => env[n] },
    session: {
      id: async () => 'sess-1', cwd: async () => '/work', model: async () => 'opus',
      messages: async () => [{ role: 'user', text: 'Mach X', toolUses: [] }, { role: 'assistant', text: 'X erledigt', toolUses: [] }],
      compact: async args => fire('session.compact', { trigger: 'plugin', messages: [{ role: 'user', text: 'Mach X', toolUses: [] }], ...args }, compactCore),
    },
    fs: {
      write: async (p, t) => { files.set(p, t) }, read: async p => { if (!files.has(p)) throw new Error('ENOENT ' + p); return files.get(p) }, exists: async p => files.has(p),
    },
    process: { run: async (argv, init) => { log.runs.push(argv); if (argv[0] === '/adapter') return { exitCode: 0, stdout: adapterOut(JSON.parse(init.stdin)), stderr: '' }; if (argv[0] === 'mv') { files.set(argv[3], files.get(argv[2])); files.delete(argv[2]) } return { exitCode: 0, stdout: argv[1]?.endsWith('compact-state-files.sh') ? 'sitrep\t/state/board\n' : '', stderr: '' } } },
    model: { fork: async () => fork },
    clock: { after: (ms, fn) => { timers.push(fn); return { cancel() {} } } },
    ui: { log: (t) => log.logs.push(t), toast: t => log.toasts.push(t) },
    prompt: { submit: async a => { log.submits.push(a.text) } },
  }
  return { on, fire, $, files, log, flush: async () => { while (timers.length) await timers.shift()() } }
}
