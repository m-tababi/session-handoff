import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { AgentInfo, FsEntry, ModelForkResult, On, PromptFillResult, ProcessRunResult } from 'claude-code'

import { PILL_BUSY, PILL_LONG, PILL_SHORT, RESTART_YES, germanDate, restartQuestion, timestamp } from '../hooks/handoff'

const HOME = '/home/tester'
const ROOT = '/work/repo'
const DIR = `${HOME}/.claude/handoffs/-work-repo`
const START = new Date(2026, 9, 9, 14, 30, 5).getTime()
const DAY = 24 * 60 * 60 * 1000
const ZERO = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const REPLY = 'LATEST: Built the parser, tests pass.\n\n## 1. Session intent\nBuild the parser.\n'

type Git = (args: readonly string[], cwd: string) => { exitCode: number; stdout: string } | 'fail'

type WorldOptions = {
  // The session root ($.session.root()); `shellCwd` is where a shell cd went.
  root?: string
  shellCwd?: string
  draft?: string
  failWrites?: { isOn: boolean }
  failStore?: { get?: boolean; set?: boolean }
  home?: string | null
  git?: Git
  files?: Record<string, string>
  realPaths?: Record<string, string>
  fork?: () => ModelForkResult | Promise<ModelForkResult>
  fill?: PromptFillResult
  percent?: { breakdown?: number; context?: number } | 'fail'
  store?: Record<string, unknown>
  // The restart: the answer to the question (or a pending promise), running
  // agents, how /clear goes, and whether a submit gets through.
  ask?: string | 'dismiss' | (() => Promise<string>)
  agents?: Partial<AgentInfo>[]
  clear?: 'ok' | 'same-id' | 'fail'
  // The session.id read (1-based) that fails.
  failIdRead?: number
  submit?: 'ok' | 'fail'
  surfaces?: ('terminal' | 'desktop')[]
}

// A repository at ROOT on branch feature/x, seen from its own folder.
function repoGit(root: string): Git {
  return args => {
    const line = args.join(' ')
    if (line === 'rev-parse --path-format=absolute --git-common-dir') return { exitCode: 0, stdout: `${root}/.git\n` }
    if (line === 'rev-parse --is-inside-work-tree') return { exitCode: 0, stdout: 'true\n' }
    if (line === 'symbolic-ref --short -q HEAD') return { exitCode: 0, stdout: 'feature/x\n' }
    if (line === 'status --porcelain') return { exitCode: 0, stdout: ' M hooks/a.ts\n' }
    if (line === 'log --oneline -5') return { exitCode: 0, stdout: 'abc1234 feat: parser\n' }

    return { exitCode: 1, stdout: '' }
  }
}

const noGit: Git = () => ({ exitCode: 128, stdout: '' })

function processResult(exitCode: number, stdout: string): ProcessRunResult {
  return { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

// Everything beneath the plugin: an in-memory file system, git, the fork, the
// prompt box, the toasts, the store, the environment and the clock.
function world(on: On, o: WorldOptions = {}) {
  const files = new Map(Object.entries(o.files ?? {}))
  const seen = {
    files,
    writes: [] as string[],
    forks: [] as string[],
    toasts: [] as string[],
    fills: [] as { text: string; mode: string }[],
    submits: [] as string[],
    gitCalls: [] as { args: string; cwd: string | undefined }[],
    usageCalls: 0,
    store: { ...(o.store ?? {}) } as Record<string, unknown>,
    clock: undefined as unknown as MockClock,
    // What happened beneath the plugin, in order (restart tests read it).
    order: [] as string[],
    questions: [] as string[],
    // The hint line's text as each PromptHint draw handed it down.
    hints: [] as string[],
  }
  let sessionId = 's1'
  const root = o.root ?? ROOT
  const git = o.git ?? repoGit(ROOT)

  seen.clock = mock.clock(on, { now: START })
  // The plugin's store, readable by the test (resume marks live here).
  on('store.get', ($, e) => (o.failStore?.get === true ? { deny: 'store unreadable' } : { value: seen.store[e.key] }))
  on('store.set', ($, e) => {
    if (o.failStore?.set === true) {
      return { deny: 'store unwritable' }
    }

    seen.store[e.key] = e.value
    seen.order.push(`store.set ${e.key.slice(e.key.lastIndexOf('/') + 1)}`)

    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    delete seen.store[e.key]

    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(seen.store) }))
  mock.env(on, o.home === null ? {} : { HOME: o.home ?? HOME })

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.root', () => ({ value: root }))
  on('session.cwd', () => ({ value: o.shellCwd ?? root }))
  on('prompt.read', () => ({ value: { text: o.draft ?? '', cursor: (o.draft ?? '').length } }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('process.run', ($, e) => {
    const [bin, ...args] = e.argv
    seen.gitCalls.push({ args: args.join(' '), cwd: e.init?.cwd })
    const ran = bin === 'git' ? git(args, e.init?.cwd ?? root) : 'fail'
    if (ran === 'fail') {
      return { deny: 'timed out' }
    }

    return { value: processResult(ran.exitCode, ran.stdout) }
  })
  on('fs.stat', ($, e) => ({
    value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: o.realPaths?.[e.path] ?? e.path },
  }))
  on('fs.list', ($, e) => {
    const prefix = `${e.path}/`
    const entries: FsEntry[] = [...files.keys()]
      .filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
      .map(p => ({ name: p.slice(prefix.length), kind: 'file', size: 1, mtimeMs: 0, isLink: false }))
    if (entries.length === 0) {
      throw new Error(`ENOENT ${e.path}`)
    }

    return { value: entries }
  })
  on('fs.exists', ($, e) => ({ value: files.has(e.path) }))
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) {
      throw new Error(`ENOENT ${e.path}`)
    }

    return { value: text }
  })
  on('fs.write', ($, e) => {
    if (o.failWrites?.isOn === true) {
      return { deny: 'EACCES' }
    }

    files.set(e.path, e.text)
    seen.writes.push(e.path)
    seen.order.push(`write ${e.path.slice(e.path.lastIndexOf('/') + 1)}`)

    return { value: undefined }
  })
  on('model.fork', async ($, e) => {
    seen.forks.push(e.prompt)
    seen.order.push('fork')

    return { value: o.fork === undefined ? { isAnswered: true, text: REPLY, usage: ZERO } : await o.fork() }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)

    return { value: undefined }
  })
  on('prompt.fill', ($, e) => {
    seen.order.push('fill')
    seen.fills.push({ text: e.text, mode: e.mode })

    return o.fill ?? { isFilled: true }
  })
  on('prompt.submit', ($, e) => {
    seen.order.push('submit')
    if (o.submit === 'fail') {
      throw new Error('no session to submit to')
    }

    seen.submits.push(e.text)

    return { text: e.text }
  })
  on('session.usage', () => {
    seen.usageCalls += 1
    if (o.percent === 'fail') {
      throw new Error('no usage')
    }

    const breakdown = o.percent?.breakdown === undefined ? undefined : ({ percentage: o.percent.breakdown } as never)

    return { value: { startedAt: 0, context: { window: 200_000, percent: o.percent?.context, breakdown }, rateLimits: [] } }
  })
  let idReads = 0
  on('session.id', () => {
    seen.order.push('id')
    idReads += 1
    if (idReads === o.failIdRead) {
      return { deny: 'no session' }
    }

    return { value: sessionId }
  })
  on('command.run', { command: 'clear' }, () => {
    seen.order.push('clear')
    if (o.clear === 'fail') {
      throw new Error('clear refused')
    }

    if (o.clear !== 'same-id') {
      sessionId = `s${Number(sessionId.slice(1)) + 1}`
    }

    return { text: '' }
  })
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e) => {
    const question = e.questions[0]?.question ?? ''
    seen.order.push('ask')
    seen.questions.push(question)
    if (o.ask === 'dismiss') {
      return { deny: 'dismissed' }
    }

    const answer = typeof o.ask === 'function' ? await o.ask() : (o.ask ?? RESTART_YES)

    return { result: { questions: e.questions, answers: { [question]: answer } } as never }
  })
  on('session.surfaces', () => ({ value: o.surfaces ?? ['terminal'] }))
  on('agent.list', () => ({ value: (o.agents ?? []) as AgentInfo[] }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine band</Text>
  })
  // The engine's own hint line: a node core draws itself, pills live.
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    seen.hints.push(e.props.hint)

    return { type: 'engine', ref: 0 } as never
  })

  return seen
}

function start($: Engine, isInteractive = true) {
  return $.session.start({ cwd: ROOT, surface: isInteractive ? 'terminal' : null, isInteractive })
}

async function handoff($: Engine, args: string): Promise<string> {
  const ran = await $.command.run({
    command: 'handoff',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })

  return ran.text ?? ''
}

function measure($: Engine, percent: number) {
  return $.session.measure({ context: { tokens: percent * 2000, window: 200_000, percent }, rateLimits: [], changed: ['context'] })
}

const name = (at: number, suffix = '') => `handoff-${timestamp(at)}${suffix}.md`
// A saved handoff as the plugin writes it, naming its project root.
const doc = (summary: string, root = ROOT, body = 'body') => `# ${summary}\n\n- Project: ${root}\n- Written: x\n\n${body}\n`

function expectOnlyHandoffWrites(writes: readonly string[]): void {
  for (const path of writes) {
    expect(path.startsWith(`${HOME}/.claude/handoffs/`)).toBe(true)
    expect(path.startsWith(`${ROOT}/`)).toBe(false)
    expect(path.endsWith('.gitignore')).toBe(false)
  }
}

describe('/handoff now', () => {
  test('forks once, writes the file and LATEST.md under ~/.claude/handoffs, nothing in the project', async ($, on) => {
    const seen = world(on)
    await start($)

    const text = await handoff($, 'now')

    const path = `${DIR}/${name(START)}`
    expect(seen.forks).toHaveLength(1)
    expect(text).toBe(`Übergabe gespeichert: ${path}\nBuilt the parser, tests pass.`)
    expect(seen.writes).toEqual([path, `${DIR}/LATEST.md`])
    expectOnlyHandoffWrites(seen.writes)
    expect(seen.files.get(path)).toBe(
      '# Built the parser, tests pass.\n\n- Project: /work/repo\n- Written: 2026-10-09-143005\n- Branch: feature/x\n\n' +
        '## 1. Session intent\nBuild the parser.\n',
    )
    expect(seen.files.get(`${DIR}/LATEST.md`)).toBe(`${name(START)}\nBuilt the parser, tests pass.\n`)
    expect(seen.toasts).toEqual([`Übergabe gespeichert: ${name(START)}`])
  })

  test('the fork prompt carries the ten sections and the git facts read before it', async ($, on) => {
    const seen = world(on)
    // Not interactive: no startup check, so only the handoff's git calls are seen.
    await start($, false)
    await handoff($, '')

    const [prompt = ''] = seen.forks
    expect(prompt).toContain('## 10. For the next agent')
    expect(prompt).toContain('- Branch: feature/x')
    expect(prompt).toContain(' M hooks/a.ts')
    expect(prompt).toContain('abc1234 feat: parser')
    expect(seen.gitCalls.map(c => c.args)).toEqual([
      'rev-parse --path-format=absolute --git-common-dir',
      'rev-parse --is-inside-work-tree',
      'symbolic-ref --short -q HEAD',
      'status --porcelain',
      'log --oneline -5',
    ])
    expect(seen.gitCalls.every(c => c.cwd === ROOT)).toBe(true)
  })

  test('a second handoff in the same second gets a suffix and LATEST.md follows it', async ($, on) => {
    const seen = world(on)
    await start($)
    await handoff($, 'now')
    await handoff($, 'now')

    expect(seen.files.has(`${DIR}/${name(START, '-2')}`)).toBe(true)
    expect(seen.files.get(`${DIR}/LATEST.md`)).toBe(`${name(START, '-2')}\nBuilt the parser, tests pass.\n`)
  })

  for (const reason of ['nothing-to-fork', 'api-error', 'empty-reply', 'aborted'] as const) {
    test(`a fork without an answer (${reason}) writes nothing and says why`, async ($, on) => {
      const seen = world(on, {
        fork: () =>
          reason === 'nothing-to-fork'
            ? { isAnswered: false, reason }
            : reason === 'api-error'
              ? { isAnswered: false, reason, status: 529, error: 'overloaded', usage: ZERO }
              : { isAnswered: false, reason, usage: ZERO },
      })
      await start($)

      const text = await handoff($, 'now')

      expect(text).toBe(`Keine Übergabe geschrieben: der Fork lieferte keine Antwort (${reason}).`)
      expect(seen.writes).toEqual([])
      expect(seen.toasts).toEqual([`Übergabe nicht gespeichert (${reason}).`])
    })
  }

  test('an answer with a summary line alone counts as empty', async ($, on) => {
    const seen = world(on, { fork: () => ({ isAnswered: true, text: 'LATEST: nothing\n', usage: ZERO }) })
    await start($)

    expect(await handoff($, 'now')).toContain('(empty-reply)')
    expect(seen.writes).toEqual([])
  })

  test('a worktree and a symlinked path land in the same project folder', async ($, on) => {
    const seen = world(on, {
      root: '/work/repo-wt',
      git: args =>
        args.join(' ') === 'rev-parse --path-format=absolute --git-common-dir'
          ? { exitCode: 0, stdout: '/link/repo/.git\n' }
          : repoGit(ROOT)(args, '/work/repo-wt'),
      realPaths: { '/link/repo': ROOT },
    })
    await start($)
    await handoff($, 'now')

    expect(seen.writes[0]).toBe(`${DIR}/${name(START)}`)
    // Facts come from the worktree the session runs in.
    expect(seen.gitCalls.every(c => c.cwd === '/work/repo-wt')).toBe(true)
  })

  test('outside git the working directory names the project', async ($, on) => {
    const seen = world(on, { root: '/data/notes', git: noGit })
    await start($)
    await handoff($, 'now')

    expect(seen.writes[0]).toBe(`${HOME}/.claude/handoffs/-data-notes/${name(START)}`)
    expect(seen.forks[0]).toContain('- Not a git repository.')
  })

  test('git that fails or times out still lets the handoff through', async ($, on) => {
    const seen = world(on, { git: () => 'fail' })
    await start($)
    await handoff($, 'now')

    expect(seen.writes[0]).toBe(`${DIR}/${name(START)}`)
  })

  test('without HOME nothing is forked or written', async ($, on) => {
    const seen = world(on, { home: null })
    await start($)

    expect(await handoff($, 'now')).toContain('HOME ist nicht gesetzt')
    expect(seen.forks).toEqual([])
    expect(seen.writes).toEqual([])
  })

  test('a project that contains ~/.claude is refused', async ($, on) => {
    const seen = world(on, { root: HOME, git: noGit })
    await start($)

    expect(await handoff($, 'now')).toContain('läge im Projekt')
    expect(seen.writes).toEqual([])
  })

  test('a reload clears a handoff left underway', async ($, on) => {
    let forks = 0
    const seen = world(on, {
      fork: () => (++forks === 1 ? new Promise<ModelForkResult>(() => undefined) : { isAnswered: true, text: REPLY, usage: ZERO }),
    })
    await start($)

    void handoff($, 'now')
    await seen.clock.settle()
    await start($)

    expect(await handoff($, 'now')).toContain('Übergabe gespeichert')
    expect(seen.forks).toHaveLength(2)
    expect(seen.writes).toHaveLength(2)
  })

  test('a symlinked HOME inside the project is refused too', async ($, on) => {
    const seen = world(on, { root: '/data', git: noGit, realPaths: { [HOME]: '/data/home' } })
    await start($)

    expect(await handoff($, 'now')).toContain('läge im Projekt /data')
    expect(seen.writes).toEqual([])
  })

  test('a shell cd does not move the project folder', async ($, on) => {
    const seen = world(on, {
      shellCwd: '/tmp/elsewhere',
      git: (args, cwd) => (cwd === ROOT ? repoGit(ROOT)(args, cwd) : noGit(args, cwd)),
    })
    await start($, false)
    await handoff($, 'now')

    expect(seen.writes[0]).toBe(`${DIR}/${name(START)}`)
    expect(seen.gitCalls.every(c => c.cwd === ROOT)).toBe(true)
  })

  test('a submodule is its own project', async ($, on) => {
    const sub = '/work/super/sub'
    const seen = world(on, {
      root: sub,
      git: args => {
        const line = args.join(' ')
        if (line === 'rev-parse --path-format=absolute --git-common-dir') return { exitCode: 0, stdout: '/work/super/.git/modules/sub\n' }
        if (line === 'rev-parse --show-toplevel') return { exitCode: 0, stdout: `${sub}\n` }

        return repoGit(sub)(args, sub)
      },
    })
    await start($, false)
    await handoff($, 'now')

    expect(seen.writes[0]).toBe(`${HOME}/.claude/handoffs/-work-super-sub/${name(START)}`)
    expect(seen.files.get(seen.writes[0] ?? '')).toContain('- Project: /work/super/sub')
  })

  test('a failing write claims nothing and frees the next try', async ($, on) => {
    const failWrites = { isOn: true }
    const seen = world(on, { failWrites })
    await start($, false)

    const text = await handoff($, 'now')

    expect(text).toBe(`Übergabe nicht gespeichert: ${DIR}/${name(START)} konnte nicht geschrieben werden (session-handoff: $.fs.write: EACCES).`)
    expect(seen.toasts).toEqual(['Übergabe nicht gespeichert (Schreibfehler).'])
    expect(seen.writes).toEqual([])

    failWrites.isOn = false
    expect(await handoff($, 'now')).toContain('Übergabe gespeichert:')
    expect(seen.forks).toHaveLength(2)
  })

  test('a second /handoff while one is written is turned away', async ($, on) => {
    let release: (r: ModelForkResult) => void = () => undefined
    const seen = world(on, { fork: () => new Promise<ModelForkResult>(resolve => (release = resolve)) })
    await start($)

    const first = handoff($, 'now')
    await seen.clock.settle()
    expect(await handoff($, 'now')).toBe('Es wird bereits eine Übergabe geschrieben.')
    release({ isAnswered: true, text: REPLY, usage: ZERO })
    expect(await first).toContain('Übergabe gespeichert')
    expect(seen.forks).toHaveLength(1)
  })
})

describe('/handoff resume', () => {
  const older = name(START - 2 * DAY)
  const newest = name(START - DAY, '-2')
  const files = {
    [`${DIR}/${older}`]: doc('Old'),
    [`${DIR}/${name(START - DAY)}`]: doc('Middle'),
    [`${DIR}/${newest}`]: doc('Newest', ROOT, '## 9. Open threads and next steps\nrun pytest'),
    [`${DIR}/LATEST.md`]: `${newest}\nNewest\n`,
  }

  test('without a handoff it says so and sends nothing', async ($, on) => {
    const seen = world(on)
    await start($)

    expect(await handoff($, 'resume')).toBe(`Keine Übergabe für dieses Projekt (${DIR}).`)
    expect(seen.fills).toEqual([])
    expect(seen.submits).toEqual([])
  })

  test('appends the newest handoff with its path to the prompt box', async ($, on) => {
    const seen = world(on, { files })
    await start($)

    const text = await handoff($, 'resume')
    await seen.clock.settle()

    expect(text).toBe(`Fortsetzung aus ${DIR}/${newest} steht in der Eingabe – mit Enter absenden.`)
    expect(seen.fills).toHaveLength(1)
    expect(seen.fills[0]?.mode).toBe('append')
    expect(seen.fills[0]?.text).toContain(`${DIR}/${newest}`)
    expect(seen.fills[0]?.text).toContain('run pytest')
    expect(seen.fills[0]?.text).toContain('ask me instead of doing it')
    expect(seen.fills[0]?.text.startsWith('Resume from')).toBe(true)
    expect(seen.submits).toEqual([])
  })

  test('a draft in the box is kept and set off by a blank line', async ($, on) => {
    const seen = world(on, { files, draft: 'mein Entwurf' })
    await start($)
    await handoff($, 'resume')

    expect(seen.fills[0]?.mode).toBe('append')
    expect(seen.fills[0]?.text.startsWith('\n\nResume from')).toBe(true)
  })

  test('a newer handoff of another root in the same slug folder is passed over', async ($, on) => {
    const seen = world(on, {
      files: { ...files, [`${DIR}/${name(START)}`]: doc('Foreign', '/work-repo', 'foreign steps') },
    })
    await start($)
    await handoff($, 'resume')

    expect(seen.fills[0]?.text).toContain(`${DIR}/${newest}`)
    expect(seen.fills[0]?.text).not.toContain('foreign steps')
    expect(await handoff($, 'list')).not.toContain('Foreign')
  })

  // The engine's own refusal causes (no_composer, dialog) cannot be raised by
  // a test hook; logic.test.ts drives those outcomes through deliverResume.
  test('a refusal without a cause sends nothing', async ($, on) => {
    const seen = world(on, { files, fill: { isFilled: false } })
    await start($)

    expect(await handoff($, 'resume')).toBe('Die Eingabe hat den Text nicht übernommen – nichts gesendet.')
    await seen.clock.settle()
    expect(seen.submits).toEqual([])
  })
})

describe('used and old handoffs', () => {
  const newest = name(START - DAY)
  const path = `${DIR}/${newest}`
  const files = { [`${DIR}/${name(START - 2 * DAY)}`]: doc('Older'), [path]: doc('Newest') }

  test('a resumed handoff is marked and not resumed twice', async ($, on) => {
    const seen = world(on, { files })
    await start($)

    await handoff($, 'resume')
    expect(seen.store[path]).toBe(START)

    expect(await handoff($, 'resume')).toBe(
      'Diese Übergabe wurde schon am 09.10.2026 14:30 fortgesetzt. Neue Übergabe mit /handoff, oder trotzdem: /handoff resume --force.',
    )
    expect(seen.fills).toHaveLength(1)
  })

  test('--force resumes anyway and moves the mark', async ($, on) => {
    const seen = world(on, { files })
    await start($)
    await handoff($, 'resume')
    await seen.clock.advance(60_000)

    expect(await handoff($, 'resume --force')).toContain('steht in der Eingabe')
    expect(seen.fills).toHaveLength(2)
    expect(seen.store[path]).toBe(START + 60_000)
  })

  test('nothing sent leaves no mark', async ($, on) => {
    const seen = world(on, { files, fill: { isFilled: false } })
    await start($)
    await handoff($, 'resume')

    expect(path in seen.store).toBe(false)
  })

  test('the mark outlives the session', async ($, on) => {
    const seen = world(on, { files })
    await start($)
    await handoff($, 'resume')
    // A new session.start: the store, unlike $.state, is kept.
    await start($)

    expect(await handoff($, 'resume')).toContain('wurde schon am 09.10.2026 14:30 fortgesetzt')
    expect(seen.fills).toHaveLength(1)
  })

  test('a mark from an earlier session blocks resume and the startup toast', async ($, on) => {
    const earlier = START - 60 * 60 * 1000
    const seen = world(on, { files, store: { [path]: earlier } })
    await start($)
    await seen.clock.settle()

    expect(seen.toasts).toEqual([])
    expect(await handoff($, 'resume')).toContain(`schon am ${germanDate(earlier)} fortgesetzt`)
  })

  test('a handoff older than seven days opens with a warning and the age is named', async ($, on) => {
    const old = START - 9 * DAY
    const seen = world(on, { files: { [`${DIR}/${name(old)}`]: doc('Old') } })
    await start($)

    const text = await handoff($, 'resume')

    expect(seen.fills[0]?.text.startsWith(
      'Warning: this handoff is 9 days old (30.09.2026 14:30); treat its state as outdated and verify everything.\n\nResume from',
    )).toBe(true)
    expect(text).toContain('\nAchtung: Diese Übergabe ist 9 Tage alt (vom 30.09.2026 14:30).')
  })

  test('a recent handoff gets no warning', async ($, on) => {
    const seen = world(on, { files })
    await start($)

    expect(await handoff($, 'resume')).not.toContain('Achtung')
    expect(seen.fills[0]?.text.startsWith('Resume from')).toBe(true)
  })

  test('list marks resumed handoffs', async ($, on) => {
    const earlier = START - 60 * 60 * 1000
    world(on, { files, store: { [path]: earlier } })
    await start($)

    const lines = (await handoff($, 'list')).split('\n')

    expect(lines[1]).toBe(`- ${germanDate(START - DAY)}  Newest  [${newest}]  (fortgesetzt am 09.10.2026 13:30)`)
    expect(lines[2]).toBe(`- ${germanDate(START - 2 * DAY)}  Older  [${name(START - 2 * DAY)}]`)
  })

  test('a store that cannot be read does not block resume', async ($, on) => {
    const seen = world(on, { files, failStore: { get: true } })
    await start($)

    expect(await handoff($, 'resume')).toBe(`Fortsetzung aus ${path} steht in der Eingabe – mit Enter absenden.`)
    expect(seen.fills).toHaveLength(1)
  })

  test('a store that cannot be written still lets the resume out, with a note', async ($, on) => {
    const seen = world(on, { files, failStore: { set: true } })
    await start($)

    const text = await handoff($, 'resume')

    expect(text).toBe(
      `Fortsetzung aus ${path} steht in der Eingabe – mit Enter absenden.\n(Vermerk „fortgesetzt“ nicht gespeichert.)`,
    )
    expect(text).not.toContain('Fehler')
    expect(seen.fills).toHaveLength(1)
    expect(path in seen.store).toBe(false)
  })

  test('a store that cannot be read still lists the handoffs, unmarked', async ($, on) => {
    world(on, { files, store: { [path]: START }, failStore: { get: true } })
    await start($)

    const lines = (await handoff($, 'list')).split('\n')

    expect(lines).toHaveLength(3)
    expect(lines[1]).toBe(`- ${germanDate(START - DAY)}  Newest  [${newest}]`)
  })

  test('writing a handoff drops marks of files that are gone, and nothing else', async ($, on) => {
    const gone = `${DIR}/handoff-2026-01-01-000000.md`
    const seen = world(on, { files, store: { [gone]: 1, [path]: 2, hintThreshold: 50 } })
    await start($, false)
    await handoff($, 'now')

    expect(seen.store).toEqual({ [path]: 2, hintThreshold: 50 })
  })
})

describe('/handoff list', () => {
  test('shows the five newest with time and first line', async ($, on) => {
    const files: Record<string, string> = { [`${DIR}/LATEST.md`]: 'x\n' }
    for (let i = 0; i < 7; i++) {
      files[`${DIR}/${name(START - i * DAY)}`] = doc(`Summary ${i}`)
    }
    const seen = world(on, { files })
    await start($)

    const lines = (await handoff($, 'list')).split('\n')

    expect(lines[0]).toBe(`Letzte Übergaben (${DIR}):`)
    expect(lines).toHaveLength(6)
    expect(lines[1]).toBe(`- ${germanDate(START)}  Summary 0  [${name(START)}]`)
    expect(lines[5]).toBe(`- ${germanDate(START - 4 * DAY)}  Summary 4  [${name(START - 4 * DAY)}]`)
    expect(seen.writes).toEqual([])
  })

  test('without handoffs it says so', async ($, on) => {
    world(on)
    await start($)

    expect(await handoff($, 'list')).toBe(`Keine Übergabe für dieses Projekt (${DIR}).`)
  })
})

describe('context hint', () => {
  test('fires exactly once past the threshold', async ($, on) => {
    const seen = world(on)
    await start($)

    await measure($, 79)
    expect(seen.toasts).toEqual([])
    await measure($, 81)
    await measure($, 90)
    await measure($, 30)
    await measure($, 95)

    expect(seen.toasts).toEqual(['Kontext 81 % – /handoff?'])
  })

  test('prefers the compaction window over the status line figure', async ($, on) => {
    const seen = world(on, { percent: { breakdown: 85, context: 60 } })
    await start($)
    await measure($, 60)

    expect(seen.toasts).toEqual(['Kontext 85 % – /handoff?'])
  })

  test('falls back to the measured figure when usage fails', async ($, on) => {
    const seen = world(on, { percent: 'fail' })
    await start($)
    await measure($, 79)
    await measure($, 82)

    expect(seen.toasts).toEqual(['Kontext 82 % – /handoff?'])
  })

  test('hint off suppresses it, and the choice is stored', async ($, on) => {
    const seen = world(on)
    await start($)

    expect(await handoff($, 'hint off')).toBe('Kontext-Hinweis aus.')
    await measure($, 95)
    expect(seen.toasts).toEqual([])
    expect(await handoff($, 'hint')).toBe('Kontext-Hinweis ist aus.')

    expect(await handoff($, 'hint on')).toBe('Kontext-Hinweis an (80 %).')
    await measure($, 96)
    expect(seen.toasts).toEqual(['Kontext 96 % – /handoff?'])
  })

  test('the breakdown is computed only near the threshold', async ($, on) => {
    const seen = world(on)
    await start($)

    await measure($, 50)
    expect(seen.usageCalls).toBe(0)
    await measure($, 56)
    expect(seen.usageCalls).toBe(1)
    // No status line figure yet: the breakdown decides.
    await $.session.measure({ context: { window: 200_000 }, rateLimits: [], changed: ['context'] })
    expect(seen.usageCalls).toBe(2)
    expect(seen.toasts).toEqual([])
  })

  test('a stored off from an earlier session holds', async ($, on) => {
    const seen = world(on, { store: { hintEnabled: false } })
    await start($)
    await measure($, 99)

    expect(seen.toasts).toEqual([])
  })

  test('hint <n> sets the threshold, invalid values are refused', async ($, on) => {
    const seen = world(on)
    await start($)

    expect(await handoff($, 'hint 0')).toContain('1 bis 99')
    expect(await handoff($, 'hint 50')).toBe('Kontext-Hinweis bei 50 %.')
    await measure($, 49)
    await measure($, 55)

    expect(seen.toasts).toEqual(['Kontext 55 % – /handoff?'])
  })

  test('the userConfig threshold applies without a stored one', { options: { hintThreshold: 60 } }, async ($, on) => {
    const seen = world(on)
    await start($)
    await measure($, 61)

    expect(seen.toasts).toEqual(['Kontext 61 % – /handoff?'])
  })
})

describe('startup toast', () => {
  test('a handoff younger than seven days is offered once', async ($, on) => {
    const at = START - 6 * DAY
    const seen = world(on, { files: { [`${DIR}/${name(at)}`]: doc('x') } })
    await start($)
    await seen.clock.settle()
    await start($)
    await seen.clock.settle()

    expect(seen.toasts).toEqual([`Übergabe vom ${germanDate(at)} vorhanden – /handoff resume`])
    expect(seen.toasts[0]).toBe('Übergabe vom 03.10.2026 14:30 vorhanden – /handoff resume')
  })

  test('an older handoff is not offered', async ($, on) => {
    const seen = world(on, { files: { [`${DIR}/${name(START - 8 * DAY)}`]: doc('x') } })
    await start($)
    await seen.clock.settle()

    expect(seen.toasts).toEqual([])
  })

  test('a recent handoff of another root is not offered', async ($, on) => {
    const seen = world(on, {
      files: {
        [`${DIR}/${name(START - DAY)}`]: doc('Foreign', '/work-repo'),
        [`${DIR}/${name(START - 9 * DAY)}`]: doc('Own but old'),
      },
    })
    await start($)
    await seen.clock.settle()

    expect(seen.toasts).toEqual([])
  })

  test('a session without a person at the prompt gets no toast', async ($, on) => {
    const seen = world(on, { files: { [`${DIR}/${name(START - DAY)}`]: doc('x') } })
    await start($, false)
    await seen.clock.settle()

    expect(seen.toasts).toEqual([])
  })
})

test('an unknown verb shows the usage', async ($, on) => {
  world(on)
  await start($)

  expect(await handoff($, 'bogus')).toBe('Verwendung: /handoff [now | resume [--force] | fresh | list | hint <1-99>|on|off]')
})

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 9 },
  view: {},
} as const

// The band on the terminal's main screen by default, where the fallback pill lives.
function band(
  $: Engine,
  props: { hasSurvey?: boolean; isWorking?: boolean; bodyColumns?: number } = {},
  isFullscreen = false,
) {
  return $.ui.mount({
    plugin: 'session-handoff',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { ...BAND_PROPS, ...props },
    viewport: { columns: 125, rows: 40, isFullscreen },
  })
}

const HINT = '? for shortcuts'

// The hint line in the fullscreen terminal by default; the desktop reports no fullscreen flag here.
function hintLine(
  $: Engine,
  o: {
    surface?: 'terminal' | 'desktop'
    columns?: number
    isFullscreen?: boolean
    isWorking?: boolean
    hint?: string
    hasViewport?: boolean
  } = {},
) {
  const surface = o.surface ?? 'terminal'
  const isFullscreen = 'isFullscreen' in o ? o.isFullscreen : surface === 'terminal' ? true : undefined

  return $.ui.mount({
    plugin: 'session-handoff',
    surface,
    component: 'PromptHint',
    props: { isDraft: false, isWorking: o.isWorking ?? false, hint: o.hint ?? HINT },
    ...(o.hasViewport === false
      ? {}
      : { viewport: { columns: o.columns ?? 120, rows: 40, ...(isFullscreen === undefined ? {} : { isFullscreen }) } }),
  })
}

const ENGINE_LINE = { type: 'engine', ref: 0 }
const PILL = /Neustart \+ Übergabe/

const SAVED = `${DIR}/${name(START)}`

describe('restart with handoff', () => {
  test('/handoff fresh asks, writes, clears, checks the id, submits, then marks', async ($, on) => {
    const seen = world(on)
    await start($, false)

    expect(await handoff($, 'fresh')).toBe('Neustart wird vorbereitet …')
    await seen.clock.settle()

    expect(seen.questions).toEqual([restartQuestion(0)])
    expect(seen.order).toEqual([
      'ask',
      'fork',
      `write ${name(START)}`,
      'write LATEST.md',
      'id',
      'clear',
      'id',
      'submit',
      `store.set ${name(START)}`,
    ])
    expect(seen.submits[0]?.startsWith('Resume from')).toBe(true)
    expect(seen.submits[0]).toContain(`saved at ${SAVED}`)
    expect(seen.submits[0]).toContain('## 1. Session intent\nBuild the parser.')
    expect(seen.submits[0]).toContain('at most 3 lines')
    expect(seen.store[SAVED]).toBe(START)
    expectOnlyHandoffWrites(seen.writes)
  })

  test('the pill runs the same path, on the terminal and the desktop', async ($, on) => {
    const seen = world(on)
    await start($, false)

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await hintLine($, { surface })
      expect(await ui.find({ type: 'Button', text: PILL })).toBeDefined()
      await ui.press({ key: 'restart' })
      await seen.clock.settle()
      await ui.unmount()
    }

    expect(seen.order.filter(step => step === 'clear')).toHaveLength(2)
    expect(seen.submits).toHaveLength(2)
  })

  for (const ask of ['Abbrechen', 'ja', 'dismiss'] as const) {
    test(`the answer "${ask}" does nothing`, async ($, on) => {
      const seen = world(on, { ask })
      await start($, false)
      await handoff($, 'fresh')
      await seen.clock.settle()

      expect(seen.order).toEqual(['ask'])
      expect(seen.toasts).toEqual([])
    })
  }

  test('a running main turn refuses; after its end the restart runs', async ($, on) => {
    const seen = world(on)
    await start($, false)
    await $.turn.start({ text: 'go', turnId: 't1' })

    await handoff($, 'fresh')
    await seen.clock.settle()
    expect(seen.toasts).toEqual(['Claude arbeitet gerade – nach der Antwort erneut.'])
    expect(seen.order).toEqual([])

    // A subagent's turn ending does not end the main one.
    const done = { answer: 'x', durationMs: 1, isAborted: false, reason: 'answer' } as const
    await $.turn.complete({ ...done, turnId: 'sub', agentId: 'sub-1' })
    await handoff($, 'fresh')
    await seen.clock.settle()
    expect(seen.order).toEqual([])

    await $.turn.complete({ ...done, turnId: 't1' })
    await handoff($, 'fresh')
    await seen.clock.settle()
    expect(seen.order).toContain('submit')
  })

  test('a reload during a running turn keeps the restart refused', async ($, on) => {
    const seen = world(on)
    await start($, false)
    await $.turn.start({ text: 'go', turnId: 't1' })
    // A hot reload runs session.start again in the middle of the turn.
    await start($, false)

    const ui = await hintLine($)
    await ui.press({ key: 'restart' })
    await seen.clock.settle()

    expect(seen.toasts).toEqual(['Claude arbeitet gerade – nach der Antwort erneut.'])
    expect(seen.order).toEqual([])
  })

  test('/handoff fresh without a surface starts nothing', async ($, on) => {
    const seen = world(on, { surfaces: [] })
    await start($, false)

    expect(await handoff($, 'fresh')).toBe('Neustart nur in einer interaktiven Sitzung möglich.')
    await seen.clock.settle()
    expect(seen.order).toEqual([])
  })

  test('a double press runs one restart', async ($, on) => {
    let answer: (label: string) => void = () => undefined
    const seen = world(on, { ask: () => new Promise<string>(resolve => (answer = resolve)) })
    await start($, false)

    await handoff($, 'fresh')
    await handoff($, 'fresh')
    await seen.clock.settle()
    // While it runs the pill is a dim label, nothing to press.
    const ui = await hintLine($)
    expect(await ui.find({ type: 'Button' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: PILL_BUSY })).toMatchObject({ props: { dimColor: true } })

    expect(seen.toasts).toEqual(['Neustart läuft bereits.'])
    answer(RESTART_YES)
    await seen.clock.settle()

    expect(seen.questions).toHaveLength(1)
    expect(seen.forks).toHaveLength(1)
    expect(seen.order.filter(step => step === 'clear')).toHaveLength(1)
    expect(await ui.find({ type: 'Button', text: PILL })).toBeDefined()
  })

  test('running agents are named in the question', async ($, on) => {
    const seen = world(on, {
      ask: 'Abbrechen',
      agents: [{ status: 'running' }, { status: 'pending' }, { status: 'completed' }],
    })
    await start($, false)
    await handoff($, 'fresh')
    await seen.clock.settle()

    expect(seen.questions).toEqual(['2 Agents laufen noch. Übergabe schreiben, Sitzung leeren und mit der Übergabe neu starten?'])
  })

  test('a failed handoff never clears', async ($, on) => {
    const seen = world(on, { fork: () => ({ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: ZERO }) })
    await start($, false)
    await handoff($, 'fresh')
    await seen.clock.settle()

    expect(seen.order).toEqual(['ask', 'fork'])
    expect(seen.toasts).toEqual(['Übergabe nicht gespeichert (api-error). Sitzung nicht geleert.'])
  })

  for (const clear of ['same-id', 'fail'] as const) {
    test(`a clear that ${clear === 'fail' ? 'fails' : 'keeps the session id'} leaves the handoff and sends nothing`, async ($, on) => {
      const seen = world(on, { clear })
      await start($, false)
      await handoff($, 'fresh')
      await seen.clock.settle()

      expect(seen.files.has(SAVED)).toBe(true)
      expect(seen.submits).toEqual([])
      expect(seen.order).not.toContain('submit')
      expect(SAVED in seen.store).toBe(false)
      expect(seen.toasts).toEqual([`Leeren fehlgeschlagen – Übergabe bleibt gespeichert: ${SAVED}`])
    })
  }

  for (const failIdRead of [1, 2]) {
    test(`an unreadable session id (read ${failIdRead}) counts as a failed clear`, async ($, on) => {
      const seen = world(on, { failIdRead })
      await start($, false)
      await handoff($, 'fresh')
      await seen.clock.settle()

      expect(seen.order.filter(step => step === 'clear')).toHaveLength(failIdRead === 1 ? 0 : 1)
      expect(seen.order).not.toContain('submit')
      expect(seen.files.has(SAVED)).toBe(true)
      expect(seen.toasts).toEqual([`Leeren fehlgeschlagen – Übergabe bleibt gespeichert: ${SAVED}`])
    })
  }

  test('a submit that fails falls back to the prompt box', async ($, on) => {
    const seen = world(on, { submit: 'fail' })
    await start($, false)
    await handoff($, 'fresh')
    await seen.clock.settle()

    expect(seen.order.slice(-3)).toEqual(['submit', 'fill', `store.set ${name(START)}`])
    expect(seen.fills[0]?.mode).toBe('append')
    expect(seen.fills[0]?.text).toContain(`saved at ${SAVED}`)
    expect(seen.fills[0]?.text.startsWith('Resume from')).toBe(true)
  })

  test('the fill fallback keeps a draft and sets the prompt off by a blank line', async ($, on) => {
    const seen = world(on, { submit: 'fail', draft: 'mein Entwurf' })
    await start($, false)
    await handoff($, 'fresh')
    await seen.clock.settle()

    expect(seen.fills[0]?.mode).toBe('append')
    expect(seen.fills[0]?.text.startsWith('\n\nResume from')).toBe(true)
  })

  test('when the box refuses too, a toast points to /handoff resume and nothing is marked', async ($, on) => {
    const seen = world(on, { submit: 'fail', fill: { isFilled: false } })
    await start($, false)
    await handoff($, 'fresh')
    await seen.clock.settle()

    expect(seen.toasts).toEqual(['Übergabe gespeichert – /handoff resume'])
    expect(SAVED in seen.store).toBe(false)
  })
})

// Another plugin drawing at the same site and composing with next(e). Its
// register closes over nothing: an inline plugin is loaded as a module is.
const otherBand = (tier: 'prepend' | 'append') => ({
  name: 'other-plugin',
  tier,
  register(on: On) {
    on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
      const below = await next(e)
      const { Box, Text } = $.ui.resolve(e)

      return (
        <Box flexDirection="column">
          {below}
          <Text>other plugin</Text>
        </Box>
      )
    })
  },
})

const otherHint = (tier: 'prepend' | 'append') => ({
  name: 'other-plugin',
  tier,
  register(on: On) {
    on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
      const below = await next(e)
      const { Box, Text } = $.ui.resolve(e)

      return (
        <Box flexDirection="row">
          {below}
          <Text>other plugin</Text>
        </Box>
      )
    })
  },
})

describe('hint line', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`embeds the engine line whole and adds the pill (${surface})`, async ($, on) => {
      const seen = world(on)
      await start($, false)
      const ui = await hintLine($, { surface })

      const drawn = (await ui.drawn()) as { type: string; props: unknown; children: unknown[] }
      expect(drawn).toMatchObject({ type: 'Box', props: { flexDirection: 'row' } })
      expect(drawn.children[0]).toEqual(ENGINE_LINE)
      expect(drawn.children[1]).toMatchObject({ type: 'Box', props: { flexShrink: 0, marginLeft: 2 } })
      expect(await ui.find({ type: 'Button', key: 'restart' })).toMatchObject({ props: { plain: true } })
      expect(await ui.find({ type: 'Text', text: PILL_LONG })).toMatchObject({
        props: { backgroundColor: 'claude', color: 'inverseText', bold: true },
      })
      // The hint is handed down as the engine wrote it.
      expect(seen.hints).toEqual([HINT])
    })
  }

  test('narrows to the short pill, then leaves it out', async ($, on) => {
    world(on)
    await start($, false)

    // free = columns - hint length - 8: 23 is short, 11 is none.
    const short = await hintLine($, { columns: HINT.length + 8 + 23 })
    expect(await short.find({ type: 'Text', text: PILL_SHORT })).toBeDefined()
    expect(await short.find({ type: 'Text', text: PILL_LONG })).toBeUndefined()
    await short.unmount()

    const long = await hintLine($, { columns: HINT.length + 8 + 24 })
    expect(await long.find({ type: 'Text', text: PILL_LONG })).toBeDefined()
    await long.unmount()

    const none = await hintLine($, { columns: HINT.length + 8 + 11 })
    expect(await none.drawn()).toEqual(ENGINE_LINE)
  })

  test('a desktop that has not measured gets the long pill', async ($, on) => {
    world(on)
    await start($, false)
    const ui = await hintLine($, { surface: 'desktop', hasViewport: false })

    expect(await ui.find({ type: 'Text', text: PILL_LONG })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'restart' })).toBeDefined()
  })

  test('a terminal without a viewport gets no pill', async ($, on) => {
    world(on)
    await start($, false)
    const ui = await hintLine($, { hasViewport: false })

    expect(await ui.drawn()).toEqual(ENGINE_LINE)
  })

  test('the terminal main screen gets no pill in the hint line', async ($, on) => {
    world(on)
    await start($, false)
    const ui = await hintLine($, { isFullscreen: false })

    expect(await ui.drawn()).toEqual(ENGINE_LINE)
  })

  test('shows a dim running label while Claude works', async ($, on) => {
    world(on)
    await start($, false)
    const ui = await hintLine($, { isWorking: true })

    expect(await ui.find({ type: 'Button' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: PILL_BUSY })).toMatchObject({ props: { dimColor: true } })
  })

  for (const tier of ['prepend', 'append'] as const) {
    test(`coexists with another plugin's hint (${tier})`, { plugins: [otherHint(tier)] }, async ($, on) => {
      world(on)
      await start($, false)
      const ui = await hintLine($)

      expect(await ui.find({ type: 'Text', text: 'other plugin' })).toBeDefined()
      expect(await ui.find({ type: 'Button', text: PILL })).toBeDefined()
      expect(JSON.stringify(await ui.drawn())).toContain(JSON.stringify(ENGINE_LINE))
    })
  }
})

describe('band', () => {
  test('in fullscreen this plugin adds no row', async ($, on) => {
    world(on)
    await start($, false)
    const ui = await band($, {}, true)

    expect(await ui.find({ type: 'Button' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
  })

  test('on the main screen a right-aligned pill falls back here and restarts', async ($, on) => {
    const seen = world(on)
    await start($, false)
    const ui = await band($)

    expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
    const drawn = (await ui.drawn()) as { children: unknown[] }
    expect(drawn.children[1]).toMatchObject({ type: 'Box', props: { width: 120, justifyContent: 'flex-end' } })
    expect(await ui.find({ type: 'Text', text: PILL_LONG })).toMatchObject({
      props: { backgroundColor: 'claude', color: 'inverseText', bold: true },
    })

    await ui.press({ key: 'restart' })
    await seen.clock.settle()
    expect(seen.order).toContain('submit')
  })

  test('the fallback steps aside for a survey and dims while Claude works', async ($, on) => {
    world(on)
    await start($, false)

    const survey = await band($, { hasSurvey: true })
    expect(await survey.find({ type: 'Button' })).toBeUndefined()
    expect(await survey.find({ type: 'Text', text: 'engine band' })).toBeDefined()
    await survey.unmount()

    const working = await band($, { isWorking: true })
    expect(await working.find({ type: 'Button' })).toBeUndefined()
    expect(await working.find({ type: 'Text', text: PILL_BUSY })).toMatchObject({ props: { dimColor: true } })
    await working.unmount()

    const narrow = await band($, { bodyColumns: 20 })
    expect(await narrow.find({ type: 'Text', text: PILL_SHORT })).toBeDefined()
  })

  for (const tier of ['prepend', 'append'] as const) {
    for (const isFullscreen of [false, true]) {
      test(`coexists with another plugin's band (${tier}, ${isFullscreen ? 'fullscreen' : 'main screen'})`, {
        plugins: [otherBand(tier)],
      }, async ($, on) => {
        world(on)
        await start($, false)
        const ui = await band($, {}, isFullscreen)

        expect(await ui.find({ type: 'Text', text: 'other plugin' })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
        if (isFullscreen) {
          expect(await ui.find({ type: 'Button' })).toBeUndefined()
        } else {
          expect(await ui.find({ type: 'Button', text: PILL })).toBeDefined()
        }
      })
    }
  }
})

test('a /clear starts the once-per-session hint over', async ($, on) => {
  const seen = world(on)
  await start($)
  await measure($, 85)
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: {} as never })
  await measure($, 90)

  expect(seen.toasts).toEqual(['Kontext 85 % – /handoff?', 'Kontext 90 % – /handoff?'])
})
