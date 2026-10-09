// Pure helpers of session-handoff: names, paths, prompts and texts. No `$` here.

export const DEFAULT_HINT = 80
const DAY_MS = 24 * 60 * 60 * 1000
export const RECENT_MS = 7 * DAY_MS
export const LIST_LIMIT = 5
// Long git output is cut so the fork prompt stays small.
const FACT_MAX_LINES = 60

const FILE_NAME = /^handoff-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})(?:-(\d+))?\.md$/

export type GitFacts = {
  branch: string | null
  status: string | null
  log: string | null
  isRepo: boolean
}

export const HANDOFF_PROMPT = `Write a cold-start handoff for this session, so a new agent with no access to this conversation can pick up the work exactly where it stands. Do not call any tools and do not write any files: the plugin saves your answer outside the project. Answer with the document only.

Line 1 must be exactly "LATEST: " followed by one sentence on where the session landed. Then a blank line, then the handoff in markdown with these sections, each as a "##" heading:

## 1. Session intent
The goal and what the user actually wanted.
## 2. The back-and-forth
The meaningful requests, responses and pivots, in order, and why they happened.
## 3. Tools and skills used
Each material tool or skill used and what it accomplished.
## 4. Research, data, and sources
Outside information brought in and the findings that shaped decisions. "None" if none.
## 5. Iterations and generations
Versions, generated assets and what changed each pass. "None" if none.
## 6. Decisions locked
Settled decisions and why each was made. List unresolved decisions separately.
## 7. Current state
What is done, in progress or blocked. Mark every item "verified" (tests run, output seen) or "not verified".
## 8. Asset map
Every file created, changed or important to the work, with its absolute path and what it is for.
## 9. Open threads and next steps
Open questions, then the exact next steps in order, with the commands to run where they matter. Mark steps that wait for the user's go-ahead.
## 10. For the next agent
What to read first and the traps a cold start is likely to hit.

Rules: use only facts from this conversation and the facts below, and mark anything assumed. Include exact paths, commands, branch names, ports and test results when they matter. Never include passwords, API keys, tokens or other secrets. Do not use em dashes.`

/** `/a/b/c` -> `-a-b-c`: the folder name under ~/.claude/handoffs. */
export function slugFor(root: string): string {
  const trimmed = root.length > 1 ? root.replace(/\/+$/, '') : root

  return trimmed.replaceAll('/', '-')
}

/** The folder above a path, `/` for a top-level one. */
export function parentOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const cut = trimmed.lastIndexOf('/')

  return cut <= 0 ? '/' : trimmed.slice(0, cut)
}

/** True when `path` is `root` itself or lies below it. */
export function isWithin(path: string, root: string): boolean {
  const base = root.replace(/\/+$/, '')

  return path === base || path.startsWith(`${base}/`)
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Local time as `YYYY-MM-DD-HHMMSS`, the stamp in a handoff's file name. */
export function timestamp(ms: number): string {
  const d = new Date(ms)

  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  )
}

/** Local time as `DD.MM.YYYY HH:MM`. */
export function germanDate(ms: number): string {
  const d = new Date(ms)

  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Hint threshold in percent: whole numbers 1 to 99, else null. */
export function parseThreshold(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN

  return Number.isInteger(n) && n >= 1 && n <= 99 ? n : null
}

/** The time a handoff's file name carries, or null for any other name. */
export function fileTime(name: string): number | null {
  const m = FILE_NAME.exec(name)
  if (m === null) {
    return null
  }

  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number]

  return new Date(y, mo - 1, d, h, mi, s).getTime()
}

function sortKey(name: string): string {
  const m = FILE_NAME.exec(name)

  return m === null ? '' : `${m.slice(1, 7).join('')}-${(m[7] ?? '1').padStart(6, '0')}`
}

/** Handoff file names from a listing, newest first; LATEST.md and others left out. */
export function handoffFiles(entries: readonly { name: string; kind: string }[]): string[] {
  return entries
    .filter(e => e.kind === 'file' && FILE_NAME.test(e.name))
    .map(e => e.name)
    .sort((a, b) => (sortKey(a) < sortKey(b) ? 1 : sortKey(a) > sortKey(b) ? -1 : 0))
}

/** `handoff-<stamp>.md`, or with `-2`, `-3`, ... when that name is taken. */
export function nextFileName(stamp: string, taken: ReadonlySet<string>): string {
  let name = `handoff-${stamp}.md`
  for (let n = 2; taken.has(name); n++) {
    name = `handoff-${stamp}-${n}.md`
  }

  return name
}

export function isRecent(at: number, now: number): boolean {
  return now - at < RECENT_MS
}

/** Whole days between `at` and `now`. */
export function ageDays(at: number, now: number): number {
  return Math.floor((now - at) / DAY_MS)
}

/** The warning a resume prompt opens with when the handoff is a week old or more. */
export function staleWarning(at: number, now: number): string | null {
  if (isRecent(at, now)) {
    return null
  }

  return `Warning: this handoff is ${ageDays(at, now)} days old (${germanDate(at)}); treat its state as outdated and verify everything.`
}

/** A store value as the time a handoff was resumed, or null. */
export function usedAt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** True for a store key that marks a resumed handoff: its absolute file path. */
export function isHandoffPath(key: string): boolean {
  return key.startsWith('/') && FILE_NAME.test(key.slice(key.lastIndexOf('/') + 1))
}

function cut(text: string): string {
  const lines = text.replace(/\s+$/, '').split('\n')
  if (lines.length <= FACT_MAX_LINES) {
    return lines.join('\n')
  }

  return [...lines.slice(0, FACT_MAX_LINES), `... (${lines.length - FACT_MAX_LINES} more lines)`].join('\n')
}

/** The fork's prompt: the ten sections plus what the plugin read from git itself. */
export function handoffPrompt(facts: GitFacts, root: string): string {
  const lines = ['', '', 'Facts the plugin collected just now (trust them over memory; use them in sections 7 and 8):']
  lines.push(`- Project root: ${root}`)

  if (!facts.isRepo) {
    lines.push('- Not a git repository.')

    return HANDOFF_PROMPT + lines.join('\n')
  }

  lines.push(`- Branch: ${facts.branch ?? 'unknown (detached HEAD or git failed)'}`)
  lines.push('- git status --porcelain:')
  lines.push(facts.status === null ? '  (git failed)' : facts.status.trim() === '' ? '  (clean)' : fence(cut(facts.status)))
  lines.push('- git log --oneline -5:')
  lines.push(facts.log === null ? '  (git failed)' : facts.log.trim() === '' ? '  (no commits)' : fence(cut(facts.log)))

  return HANDOFF_PROMPT + lines.join('\n')
}

function fence(text: string): string {
  return '```\n' + text + '\n```'
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Splits the fork's reply into the one-sentence summary and the document. */
export function splitReply(text: string): { summary: string; body: string } {
  const lines = text.replace(/^\s+/, '').split('\n')
  const m = /^LATEST:\s*(.+)$/.exec(lines[0] ?? '')
  if (m !== null && m[1] !== undefined) {
    return { summary: oneLine(m[1]), body: lines.slice(1).join('\n').trim() }
  }

  return { summary: 'Handoff without a summary line.', body: text.trim() }
}

/** The saved file: the summary as line 1, so a listing can show it. */
export function handoffDocument(args: {
  summary: string
  body: string
  root: string
  at: number
  branch: string | null
}): string {
  const meta = [`- Project: ${args.root}`, `- Written: ${timestamp(args.at)}`]
  if (args.branch !== null) {
    meta.push(`- Branch: ${args.branch}`)
  }

  return `# ${args.summary}\n\n${meta.join('\n')}\n\n${args.body}\n`
}

export function latestPointer(name: string, summary: string): string {
  return `${name}\n${summary}\n`
}

/**
 * The project a saved handoff names in its header (`- Project: <root>`), or
 * null. Two roots can share a slug folder; this tells their files apart.
 */
export function projectOf(text: string): string | null {
  for (const line of text.split(/\r?\n/).slice(1, 6)) {
    if (line.startsWith('- Project: ')) {
      return line.slice('- Project: '.length).trim()
    }
  }

  return null
}

/** Line 1 of a saved handoff without its heading mark. */
export function firstLine(text: string): string {
  return (text.split(/\r?\n/)[0] ?? '').replace(/^#+\s*/, '').trim()
}

export function resumePrompt(path: string, content: string, warning: string | null = null): string {
  return (
    (warning === null ? '' : `${warning}\n\n`) +
    `Resume from the handoff of this project saved at ${path}, quoted below; it records an earlier session ` +
    'whose conversation you do not have. First read the whole handoff. Then tell me in at most 3 lines where we ' +
    'stand and what the next step is. Before you rely on anything it marks as done or verified, check it ' +
    '(run the checks, do not trust the report). Then continue with the next steps that need no approval; ' +
    'where the handoff says a step waits for my go-ahead, ask me instead of doing it.\n\n' +
    `<handoff path="${path}">\n${content.trim()}\n</handoff>`
  )
}

// What resume needs from the engine, as plain functions so every outcome of
// the prompt box can be exercised (a test hook cannot raise the engine's own
// refusal causes: the site strips a cause a hook writes).
export type ResumeIo = {
  fill: (text: string) => Promise<{ isFilled: boolean; refusal?: 'no_composer' | 'dialog' }>
  submitLater: (text: string) => void
}

/**
 * Puts the resume prompt in the box; submits it only where no box exists.
 * `isSent` is true once the box took it or the submit was started.
 */
export async function deliverResume(io: ResumeIo, text: string, path: string): Promise<{ text: string; isSent: boolean }> {
  const filled = await io.fill(text)
  if (filled.isFilled) {
    return { text: `Fortsetzung aus ${path} steht in der Eingabe – mit Enter absenden.`, isSent: true }
  }

  if (filled.refusal === 'no_composer') {
    io.submitLater(text)

    return { text: `Keine Eingabezeile – Fortsetzung aus ${path} wird gesendet.`, isSent: true }
  }

  if (filled.refusal === 'dialog') {
    return { text: 'Ein Dialog ist offen – nichts gesendet. Danach /handoff resume erneut.', isSent: false }
  }

  return { text: 'Die Eingabe hat den Text nicht übernommen – nichts gesendet.', isSent: false }
}

export function alreadyResumedText(at: number): string {
  return `Diese Übergabe wurde schon am ${germanDate(at)} fortgesetzt. Neue Übergabe mit /handoff, oder trotzdem: /handoff resume --force.`
}

/** The `/handoff list` text: newest first, time and line 1 of each, resumed ones marked. */
export function listText(dir: string, items: readonly { name: string; line: string; usedAt: number | null }[]): string {
  if (items.length === 0) {
    return `Keine Übergabe für dieses Projekt (${dir}).`
  }

  const rows = items.map(({ name, line, usedAt: used }) => {
    const at = fileTime(name)
    const mark = used === null ? '' : `  (fortgesetzt am ${germanDate(used)})`

    return `- ${at === null ? name : germanDate(at)}  ${line || '(leer)'}  [${name}]${mark}`
  })

  return [`Letzte Übergaben (${dir}):`, ...rows].join('\n')
}

export const USAGE = 'Verwendung: /handoff [now | resume [--force] | fresh | list | hint <1-99>|on|off]'

// The restart pill's texts, padded so the background color frames them.
export const PILL_LONG = ' ⟲ Neustart + Übergabe '
export const PILL_SHORT = ' ⟲ Neustart '
export const PILL_BUSY = ' ⟲ läuft … '

/**
 * Which pill fits in `free` cells: the long one from 24, the short one from
 * 12, none below (or when the room is unknown).
 */
export function pillSize(free: number): 'long' | 'short' | null {
  return free >= 24 ? 'long' : free >= 12 ? 'short' : null
}

/**
 * The cells left on the hint line for a pill: the line's width less the
 * engine's text and a margin of 8 (its pills draw wider than that text).
 */
export function hintRoom(columns: number | undefined, hint: string): number {
  return columns === undefined ? -1 : columns - hint.length - 8
}
export const RESTART_YES = 'Ja, neu starten'
export const RESTART_NO = 'Abbrechen'

/** The restart question, naming subagents that still run (they end with the clear). */
export function restartQuestion(runningAgents: number): string {
  const note =
    runningAgents === 0 ? '' : runningAgents === 1 ? '1 Agent läuft noch. ' : `${runningAgents} Agents laufen noch. `

  return `${note}Übergabe schreiben, Sitzung leeren und mit der Übergabe neu starten?`
}
