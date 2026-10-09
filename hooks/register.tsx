import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import {
  DEFAULT_HINT,
  LIST_LIMIT,
  PILL_BUSY,
  PILL_LONG,
  PILL_SHORT,
  RESTART_NO,
  RESTART_YES,
  USAGE,
  ageDays,
  alreadyResumedText,
  deliverResume,
  fileTime,
  firstLine,
  germanDate,
  handoffDocument,
  handoffFiles,
  handoffPrompt,
  hintRoom,
  isHandoffPath,
  isRecent,
  isWithin,
  latestPointer,
  listText,
  nextFileName,
  parentOf,
  parseThreshold,
  pillSize,
  projectOf,
  restartQuestion,
  resumePrompt,
  slugFor,
  splitReply,
  staleWarning,
  timestamp,
  usedAt,
} from './handoff'
import type { GitFacts } from './handoff'

const busy = atom({ plugin: 'session-handoff', key: 'busy' } as const, false)
const hinted = atom({ plugin: 'session-handoff', key: 'hinted' } as const, false)
const startupChecked = atom({ plugin: 'session-handoff', key: 'startupChecked' } as const, false)
const isTurnRunning = atom({ plugin: 'session-handoff', key: 'isTurnRunning' } as const, false)
const restarting = atom({ plugin: 'session-handoff', key: 'restarting' } as const, false)

// Statuses of a subagent that still works; the clear ends its conversation.
const ACTIVE_AGENT = new Set(['pending', 'running', 'waiting'])

const GIT_TIMEOUT_MS = 10_000
const TOAST_MS = 8000

// Where this project's handoffs live; `base` is the session root git runs in.
type Place = { base: string; root: string; dir: string }

async function git($: EngineInterface, args: string[], cwd: string): Promise<string | null> {
  try {
    const ran = await $.process.run(['git', ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS })

    return ran.exitCode === 0 ? ran.stdout : null
  } catch {
    return null
  }
}

async function realPath($: EngineInterface, path: string): Promise<string> {
  try {
    return (await $.fs.stat(path, { resolve: true })).realPath ?? path
  } catch {
    return path
  }
}

// The project is the repository (worktrees share it through the common git
// dir), else the working directory. Answers a German refusal text instead.
async function locate($: EngineInterface): Promise<Place | string> {
  const home = (await $.env.get('HOME'))?.replace(/\/+$/, '')
  if (home === undefined || !home.startsWith('/')) {
    return 'HOME ist nicht gesetzt oder nicht absolut – keine Übergabe geschrieben oder gelesen.'
  }

  // The session root, not cwd: a shell `cd` during the session does not move it.
  const base = await $.session.root()
  const common = (await git($, ['rev-parse', '--path-format=absolute', '--git-common-dir'], base))?.trim()
  let top: string = base
  if (common !== undefined && common !== '') {
    // A submodule's common dir is .git/modules/<name>; its own toplevel names it.
    top = common.endsWith('/.git')
      ? parentOf(common)
      : ((await git($, ['rev-parse', '--show-toplevel'], base))?.trim() || base)
  }

  const root = await realPath($, top)
  const dir = `${home}/.claude/handoffs/${slugFor(root)}`
  // Compared resolved, as root is; the write keeps HOME's own spelling.
  if (isWithin(`${await realPath($, home)}/.claude/handoffs/${slugFor(root)}`, root)) {
    return `Der Übergabeordner ${dir} läge im Projekt ${root} – nichts geschrieben oder gelesen.`
  }

  return { base, root, dir }
}

async function gitFacts($: EngineInterface, cwd: string): Promise<GitFacts> {
  const inside = await git($, ['rev-parse', '--is-inside-work-tree'], cwd)
  if (inside?.trim() !== 'true') {
    return { isRepo: false, branch: null, status: null, log: null }
  }

  const branch = (await git($, ['symbolic-ref', '--short', '-q', 'HEAD'], cwd))?.trim() || null
  const status = await git($, ['status', '--porcelain'], cwd)
  const log = await git($, ['log', '--oneline', '-5'], cwd)

  return { isRepo: true, branch, status, log }
}

async function savedHandoffs($: EngineInterface, dir: string): Promise<string[]> {
  try {
    return handoffFiles(await $.fs.list(dir))
  } catch {
    return []
  }
}

// This project's handoffs, newest first, with their text: files whose header
// names another root (a slug shared by two paths) are left out.
async function ownHandoffs($: EngineInterface, place: Place, limit: number): Promise<{ name: string; text: string }[]> {
  const own = []
  for (const name of await savedHandoffs($, place.dir)) {
    if (own.length >= limit) {
      break
    }

    const text = await $.fs.read(`${place.dir}/${name}`).catch(() => null)
    if (text !== null && projectOf(text) === place.root) {
      own.push({ name, text })
    }
  }

  return own
}

function toast($: EngineInterface, text: string): void {
  $.ui.toast(text, { timeoutMs: TOAST_MS })
}

// One written handoff: its path and text, or why there is none (`toast` the
// short form for a toast). Callers toast; this never does.
type Written = { text: string; toast: string | null; path: string | null; document: string | null }

function notWritten(text: string, short: string | null = null): Written {
  return { text, toast: short, path: null, document: null }
}

async function writeNow($: EngineInterface): Promise<string> {
  const written = await writeHandoff($)
  if (written.toast !== null) {
    toast($, written.toast)
  }

  return written.text
}

async function writeHandoff($: EngineInterface): Promise<Written> {
  const place = await locate($)
  if (typeof place === 'string') {
    return notWritten(place)
  }

  let isMine = false
  await update($, busy, isBusy => {
    isMine = !isBusy

    return true
  })
  if (!isMine) {
    return notWritten('Es wird bereits eine Übergabe geschrieben.')
  }

  try {
    const facts = await gitFacts($, place.base)
    const reply = await $.model.fork({ prompt: handoffPrompt(facts, place.root) })
    const parts = reply.isAnswered ? splitReply(reply.text) : null
    if (parts === null || parts.body === '') {
      const reason = reply.isAnswered ? 'empty-reply' : reply.reason

      return notWritten(
        `Keine Übergabe geschrieben: der Fork lieferte keine Antwort (${reason}).`,
        `Übergabe nicht gespeichert (${reason}).`,
      )
    }

    const now = await $.clock.now()
    const taken = new Set((await $.fs.list(place.dir).catch(() => [])).map(entry => entry.name))
    const name = nextFileName(timestamp(now), taken)
    const path = `${place.dir}/${name}`
    const document = handoffDocument({ ...parts, root: place.root, at: now, branch: facts.branch })
    let target = path
    try {
      await $.fs.write(path, document)
      target = `${place.dir}/LATEST.md`
      await $.fs.write(target, latestPointer(name, parts.summary))
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)

      return notWritten(
        `Übergabe nicht gespeichert: ${target} konnte nicht geschrieben werden (${why}).`,
        'Übergabe nicht gespeichert (Schreibfehler).',
      )
    }
    await pruneResumed($).catch(() => undefined)

    return { text: `Übergabe gespeichert: ${path}\n${parts.summary}`, toast: `Übergabe gespeichert: ${name}`, path, document }
  } finally {
    await update($, busy, () => false)
  }
}

// Drops resume marks whose handoff file is gone; the hint settings stay.
async function pruneResumed($: EngineInterface): Promise<void> {
  for (const key of await $.store.keys()) {
    if (isHandoffPath(key) && !(await $.fs.exists(key))) {
      await $.store.delete(key)
    }
  }
}

async function resume($: EngineInterface, isForced: boolean): Promise<string> {
  const place = await locate($)
  if (typeof place === 'string') {
    return place
  }

  const [newest] = await ownHandoffs($, place, 1)
  if (newest === undefined) {
    return `Keine Übergabe für dieses Projekt (${place.dir}).`
  }

  const path = `${place.dir}/${newest.name}`
  // A store that fails to answer counts as "not resumed": it never blocks a resume.
  const used = usedAt(await $.store.get(path).catch(() => undefined))
  if (used !== null && !isForced) {
    return alreadyResumedText(used)
  }

  const now = await $.clock.now()
  const at = fileTime(newest.name)
  const warning = at === null ? null : staleWarning(at, now)
  const delivered = await deliverResume(
    {
      fill: text => fillAfterDraft($, text),
      // A command.run hook must not await a submit: the prompt waits for this hook.
      submitLater: text => {
        $.clock.after(0, () => {
          void $.prompt.submit({ text }).catch(() => undefined)
        })
      },
    },
    resumePrompt(path, newest.text, warning),
    path,
  )
  // Marked only once something went out; the key is the file's absolute path.
  // The prompt is out by then, so a failed mark is a note, never an error.
  const isMarked = delivered.isSent ? await $.store.set(path, now).then(() => true, () => false) : true
  const note = isMarked ? '' : '\n(Vermerk „fortgesetzt“ nicht gespeichert.)'
  const age = at === null || warning === null ? '' : `\nAchtung: Diese Übergabe ist ${ageDays(at, now)} Tage alt (vom ${germanDate(at)}).`

  return delivered.text + note + age
}

// The restart behind the band's button and /handoff fresh: ask, write a
// handoff, clear the conversation, then send the fresh one the handoff. Path
// and text stay in this closure; only the flags live in $.state.
// Appended after a draft the person typed, set off by a blank line.
async function fillAfterDraft($: EngineInterface, text: string) {
  const { text: draft } = await $.prompt.read()

  return $.prompt.fill({ text: draft === '' ? text : `\n\n${text}`, mode: 'append' })
}

// `isWorkingAtDraw` is the band's `isWorking` when the button was drawn: a
// second witness beside the atom, which a reload mid-turn cannot have reset.
async function restart($: EngineInterface, isWorkingAtDraw = false): Promise<void> {
  if (isWorkingAtDraw || (await read($, isTurnRunning))) {
    toast($, 'Claude arbeitet gerade – nach der Antwort erneut.')

    return
  }

  let isMine = false
  await update($, restarting, isRestarting => {
    isMine = !isRestarting

    return true
  })
  if (!isMine) {
    toast($, 'Neustart läuft bereits.')

    return
  }

  try {
    const agents = await $.agent.list().catch(() => [])
    const active = agents.filter(agent => ACTIVE_AGENT.has(agent.status)).length
    let answer: string
    try {
      answer = await $.ui.ask(restartQuestion(active), [RESTART_YES, RESTART_NO])
    } catch {
      // Dismissed, or no one to ask (-p): nothing happens.
      return
    }
    if (answer !== RESTART_YES) {
      return
    }

    const written = await writeHandoff($)
    if (written.path === null || written.document === null || !(await $.fs.exists(written.path).catch(() => false))) {
      toast($, `${written.toast ?? written.text} Sitzung nicht geleert.`)

      return
    }

    const { path, document } = written
    // An id that cannot be read counts as a failed clear, before as after.
    const before = await $.session.id().catch(() => null)
    const isRun = before !== null && (await $.command.run({ command: 'clear' }).then(() => true, () => false))
    const after = isRun ? await $.session.id().catch(() => null) : null
    const isCleared = after !== null && after !== before
    if (!isCleared) {
      toast($, `Leeren fehlgeschlagen – Übergabe bleibt gespeichert: ${path}`)

      return
    }

    // The fresh conversation has nothing but this prompt.
    const text = resumePrompt(path, document)
    // A hook's drop enters nothing, as a rejection does: both fall back to the box.
    let isSent = await $.prompt.submit({ text }).then(
      submitted => submitted.drop === undefined,
      () => false,
    )
    if (!isSent) {
      const filled = await fillAfterDraft($, text).catch(() => ({ isFilled: false }))
      isSent = filled.isFilled
    }
    if (!isSent) {
      toast($, 'Übergabe gespeichert – /handoff resume')

      return
    }

    await $.store.set(path, await $.clock.now()).catch(() => undefined)
  } finally {
    await update($, restarting, () => false)
  }
}

async function list($: EngineInterface): Promise<string> {
  const place = await locate($)
  if (typeof place === 'string') {
    return place
  }

  const items = []
  for (const { name, text } of await ownHandoffs($, place, LIST_LIMIT)) {
    items.push({ name, line: firstLine(text), usedAt: usedAt(await $.store.get(`${place.dir}/${name}`).catch(() => undefined)) })
  }

  return listText(place.dir, items)
}

// The stored choice wins over the userConfig value; null means the hint is off.
async function hintLimit($: EngineInterface, configured: number): Promise<number | null> {
  if ((await $.store.get('hintEnabled')) === false) {
    return null
  }

  return parseThreshold(await $.store.get('hintThreshold')) ?? configured
}

async function hint($: EngineInterface, value: string | undefined, configured: number): Promise<string> {
  if (value === undefined) {
    const limit = await hintLimit($, configured)

    return limit === null ? 'Kontext-Hinweis ist aus.' : `Kontext-Hinweis bei ${limit} %.`
  }

  if (value === 'off' || value === 'on') {
    await $.store.set('hintEnabled', value === 'on')

    return value === 'on' ? `Kontext-Hinweis an (${await hintLimit($, configured)} %).` : 'Kontext-Hinweis aus.'
  }

  const n = parseThreshold(value)
  if (n === null) {
    return `Schwelle muss eine ganze Zahl von 1 bis 99 sein. ${USAGE}`
  }

  await $.store.set('hintThreshold', n)
  await $.store.set('hintEnabled', true)

  return `Kontext-Hinweis bei ${n} %.`
}

// The compaction window's fill when the breakdown has it, else the status line's.
async function fillPercent($: EngineInterface, fallback: number | undefined): Promise<number | undefined> {
  try {
    const { context } = await $.session.usage({ breakdown: 'summary' })

    return context.breakdown?.percentage ?? context.percent ?? fallback
  } catch {
    return fallback
  }
}

async function offerResume($: EngineInterface): Promise<void> {
  let isFirst = false
  await update($, startupChecked, isChecked => {
    isFirst = !isChecked

    return true
  })
  if (!isFirst) {
    return
  }

  const place = await locate($)
  if (typeof place === 'string') {
    return
  }

  const [newest] = await ownHandoffs($, place, 1)
  const at = newest === undefined ? null : fileTime(newest.name)
  // Only the newest handoff counts: resume takes that one, so a resumed newest is not offered.
  const isUsed = newest !== undefined && usedAt(await $.store.get(`${place.dir}/${newest.name}`)) !== null
  if (at !== null && !isUsed && isRecent(at, await $.clock.now())) {
    toast($, `Übergabe vom ${germanDate(at)} vorhanden – /handoff resume`)
  }
}

export const register: Register = (on, options) => {
  const configured = parseThreshold(options.hintThreshold) ?? DEFAULT_HINT

  on('session.start', async ($, e, next) => {
    // A fork or restart in flight is lost with the old environment on a hot
    // reload, its finally never runs; a fresh environment starts with none.
    // isTurnRunning stays: a reload mid-turn must not allow a restart during work.
    await update($, busy, () => false)
    await update($, restarting, () => false)
    await $.command.register({
      name: 'handoff',
      description: 'Übergabe schreiben (now), fortsetzen (resume), Neustart mit Übergabe (fresh), auflisten (list), Kontext-Hinweis (hint)',
      argumentHint: '[now|resume [--force]|fresh|list|hint <n>|on|off]',
    })
    const started = await next(e)

    // session.start runs again on a hot reload; the atom keeps it to one check.
    // Not awaited: the first prompt does not wait on git and the file reads.
    if (e.isInteractive) {
      void offerResume($).catch(() => undefined)
    }

    return started
  })

  on('command.run', { command: 'handoff' }, async ($, e) => {
    const [verb = 'now', value] = e.args.trim().toLowerCase().split(/\s+/).filter(Boolean)

    try {
      if (verb === 'now') {
        return { text: await writeNow($) }
      }

      if (verb === 'resume') {
        return { text: await resume($, value === '--force') }
      }

      if (verb === 'fresh') {
        // No surface (a -p run): no one to ask, and nothing to restart into.
        if ((await $.session.surfaces()).length === 0) {
          return { text: 'Neustart nur in einer interaktiven Sitzung möglich.' }
        }

        // The question and the clear run from a timer: this hook must not wait on them.
        $.clock.after(0, () => {
          void restart($).catch(() => undefined)
        })

        return { text: 'Neustart wird vorbereitet …' }
      }

      if (verb === 'list') {
        return { text: await list($) }
      }

      if (verb === 'hint') {
        return { text: await hint($, value, configured) }
      }
    } catch (err) {
      return { text: `session-handoff: Fehler (${err instanceof Error ? err.message : String(err)}).` }
    }

    return { text: USAGE }
  }).catch(() => ({ text: 'session-handoff: Befehl fehlgeschlagen.' }))

  // turn.start is raised for the main loop only; a subagent's turn.complete carries its agentId.
  on('turn.start', async ($, e, next) => {
    await update($, isTurnRunning, () => true)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const completed = await next(e)
    if (e.agentId == null) {
      await update($, isTurnRunning, () => false)
    }

    return completed
  }).catch(($, e, next) => next(e))

  // After a /clear no session.start follows: the once-per-session flags start over here.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, hinted, () => false)
      await update($, startupChecked, () => false)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // The restart pill beside the engine's hint line, whose own tree (and its
  // live pills) is embedded whole, never rewritten. The line is clickable in
  // the fullscreen terminal and on the desktop; the terminal's main screen
  // gets the band row below instead.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const below = await next(e)
    if (e.viewport?.isFullscreen === false) {
      return below
    }

    // A desktop that has not measured yet lays the line out itself: the long pill.
    const size =
      e.surface === 'desktop' && e.viewport?.columns === undefined
        ? 'long'
        : pillSize(hintRoom(e.viewport?.columns, e.props.hint))
    if (size === null) {
      return below
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const isBusy = (await read($, restarting)) || e.props.isWorking
    const pill = isBusy ? (
      <Text dimColor>{PILL_BUSY}</Text>
    ) : (
      <Button key="restart" plain onPress={() => void restart($, e.props.isWorking).catch(() => undefined)}>
        <Text backgroundColor="claude" color="inverseText" bold>
          {size === 'long' ? PILL_LONG : PILL_SHORT}
        </Text>
      </Button>
    )

    return (
      <Box flexDirection="row">
        {below}
        <Box flexShrink={0} marginLeft={2}>
          {pill}
        </Box>
      </Box>
    )
  })

  // Fallback on the terminal's main screen, where the hint line takes no
  // clicks: the same pill, right-aligned in the band and reachable by keyboard.
  // In fullscreen (and on the desktop) this plugin draws nothing here.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const below = await next(e)
    if (e.viewport?.isFullscreen !== false) {
      return below
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const isBusy = (await read($, restarting)) || e.props.isWorking
    const label = pillSize(e.props.bodyColumns) === 'long' ? PILL_LONG : PILL_SHORT
    const mine = (
      <Box width={e.props.bodyColumns} justifyContent="flex-end">
        {isBusy ? (
          <Text dimColor>{PILL_BUSY}</Text>
        ) : (
          <Button key="restart" plain onPress={() => void restart($, e.props.isWorking).catch(() => undefined)}>
            <Text backgroundColor="claude" color="inverseText" bold>
              {label}
            </Text>
          </Button>
        )}
      </Box>
    )

    // An empty band below draws nothing of its own.
    return (below as RenderElement | null | undefined) == null ? (
      mine
    ) : (
      <Box flexDirection="column">
        {below}
        {mine}
      </Box>
    )
  })

  // Raised after each main-thread turn: one hint per session past the threshold.
  on('session.measure', async ($, e, next) => {
    const measured = await next(e)
    if (!e.changed.includes('context') || (await read($, hinted))) {
      return measured
    }

    const limit = await hintLimit($, configured)
    const measuredPercent = e.context.percent
    // The breakdown is only worth computing near the threshold.
    if (limit === null || (measuredPercent !== undefined && measuredPercent < limit - 25)) {
      return measured
    }

    const percent = await fillPercent($, measuredPercent)
    if (percent === undefined || percent < limit) {
      return measured
    }

    let isFirst = false
    await update($, hinted, isHinted => {
      isFirst = !isHinted

      return true
    })
    if (isFirst) {
      toast($, `Kontext ${percent} % – /handoff?`)
    }

    return measured
  }).catch(($, e, next) => next(e))
}
