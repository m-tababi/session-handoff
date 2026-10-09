import { describe, expect, test } from 'claude-code/testing'

import {
  HANDOFF_PROMPT,
  ageDays,
  deliverResume,
  isHandoffPath,
  staleWarning,
  usedAt,
  fileTime,
  firstLine,
  handoffFiles,
  handoffPrompt,
  isRecent,
  isWithin,
  nextFileName,
  parentOf,
  parseThreshold,
  slugFor,
  splitReply,
  timestamp,
} from '../hooks/handoff'

const file = (name: string) => ({ name, kind: 'file' })

test('the slug is the absolute path with slashes turned into dashes', () => {
  expect(slugFor('/home/u/work/proj')).toBe('-home-u-work-proj')
  expect(slugFor('/work/repo/')).toBe('-work-repo')
  expect(parentOf('/work/repo/.git')).toBe('/work/repo')
  expect(parentOf('/.git')).toBe('/')
  expect(isWithin('/home/u/.claude/handoffs/-home-u', '/home/u')).toBe(true)
  expect(isWithin('/home/u2/x', '/home/u')).toBe(false)
})

test('timestamps are local time and round-trip through the file name', () => {
  const at = new Date(2026, 0, 2, 3, 4, 5).getTime()

  expect(timestamp(at)).toBe('2026-01-02-030405')
  expect(fileTime(`handoff-${timestamp(at)}.md`)).toBe(at)
  expect(fileTime(`handoff-${timestamp(at)}-3.md`)).toBe(at)
  expect(fileTime('LATEST.md')).toBeNull()
})

test('handoff files sort newest first, suffixes after their base, others left out', () => {
  const names = handoffFiles([
    file('handoff-2026-10-08-090000.md'),
    file('LATEST.md'),
    file('handoff-2026-10-09-143005.md'),
    file('handoff-2026-10-09-143005-2.md'),
    { name: 'handoff-2026-10-10-000000.md', kind: 'dir' },
    file('notes.md'),
  ])

  expect(names).toEqual(['handoff-2026-10-09-143005-2.md', 'handoff-2026-10-09-143005.md', 'handoff-2026-10-08-090000.md'])
})

test('a taken name gets the next free suffix', () => {
  const stamp = '2026-10-09-143005'

  expect(nextFileName(stamp, new Set())).toBe('handoff-2026-10-09-143005.md')
  expect(nextFileName(stamp, new Set(['handoff-2026-10-09-143005.md', 'handoff-2026-10-09-143005-2.md']))).toBe(
    'handoff-2026-10-09-143005-3.md',
  )
})

test('thresholds are whole numbers from 1 to 99', () => {
  expect(parseThreshold(80)).toBe(80)
  expect(parseThreshold('50')).toBe(50)
  expect(parseThreshold(0)).toBeNull()
  expect(parseThreshold(100)).toBeNull()
  expect(parseThreshold('8x')).toBeNull()
  expect(parseThreshold('')).toBeNull()
  expect(parseThreshold(undefined)).toBeNull()
})

test('the reply splits into summary and body', () => {
  expect(splitReply('LATEST: Done  here.\n\n## 1. Session intent\nx')).toEqual({
    summary: 'Done here.',
    body: '## 1. Session intent\nx',
  })
  expect(splitReply('## 1. x').summary).toBe('Handoff without a summary line.')
  expect(splitReply('LATEST: only a summary\n\n').body).toBe('')
  expect(firstLine('# Done here.\n\n- Project: /x')).toBe('Done here.')
})

test('the prompt has the ten sections, the secrets rule and the git facts', () => {
  const prompt = handoffPrompt(
    { isRepo: true, branch: 'feature/x', status: ' M a.ts\n', log: 'abc1234 feat: x\n' },
    '/work/repo',
  )

  for (let n = 1; n <= 10; n++) {
    expect(prompt).toContain(`## ${n}. `)
  }
  expect(prompt).toContain('verified')
  expect(prompt).toContain('Never include passwords, API keys, tokens or other secrets')
  expect(prompt).toContain('- Project root: /work/repo')
  expect(prompt).toContain('- Branch: feature/x')
  expect(prompt).toContain(' M a.ts')
  expect(prompt).toContain('abc1234 feat: x')
  expect(handoffPrompt({ isRepo: true, branch: null, status: '', log: null }, '/r')).toContain('(clean)')
  expect(handoffPrompt({ isRepo: false, branch: null, status: null, log: null }, '/r')).toBe(
    HANDOFF_PROMPT + '\n\nFacts the plugin collected just now (trust them over memory; use them in sections 7 and 8):\n- Project root: /r\n- Not a git repository.',
  )
})

test('recent means under seven days', () => {
  const day = 24 * 60 * 60 * 1000

  expect(isRecent(0, 6 * day)).toBe(true)
  expect(isRecent(0, 7 * day)).toBe(false)
})

describe('resume delivery', () => {
  function io(filled: { isFilled: boolean; refusal?: 'no_composer' | 'dialog' }) {
    const seen = { fills: [] as string[], submits: [] as string[] }

    return {
      seen,
      io: {
        fill: async (text: string) => {
          seen.fills.push(text)

          return filled
        },
        submitLater: (text: string) => void seen.submits.push(text),
      },
    }
  }

  test('a filled box sends nothing itself', async () => {
    const { io: box, seen } = io({ isFilled: true })

    expect(await deliverResume(box, 'go', '/h/x.md')).toEqual({
      text: 'Fortsetzung aus /h/x.md steht in der Eingabe – mit Enter absenden.',
      isSent: true,
    })
    expect(seen.fills).toEqual(['go'])
    expect(seen.submits).toEqual([])
  })

  test('no prompt box falls back to a submit', async () => {
    const { io: box, seen } = io({ isFilled: false, refusal: 'no_composer' })

    expect(await deliverResume(box, 'go', '/h/x.md')).toEqual({
      text: 'Keine Eingabezeile – Fortsetzung aus /h/x.md wird gesendet.',
      isSent: true,
    })
    expect(seen.submits).toEqual(['go'])
  })

  test('a dialog or an unknown refusal sends nothing', async () => {
    const dialog = io({ isFilled: false, refusal: 'dialog' })
    const unknown = io({ isFilled: false })

    // isSent false: resume leaves no "resumed" mark for these.
    expect(await deliverResume(dialog.io, 'go', '/h/x.md')).toEqual({
      text: 'Ein Dialog ist offen – nichts gesendet. Danach /handoff resume erneut.',
      isSent: false,
    })
    expect(await deliverResume(unknown.io, 'go', '/h/x.md')).toEqual({
      text: 'Die Eingabe hat den Text nicht übernommen – nichts gesendet.',
      isSent: false,
    })
    expect(dialog.seen.submits).toEqual([])
    expect(unknown.seen.submits).toEqual([])
  })
})

test('a week-old handoff gets a warning, a younger one none', () => {
  const at = new Date(2026, 8, 30, 14, 30, 5).getTime()
  const day = 24 * 60 * 60 * 1000

  expect(staleWarning(at, at + 6 * day)).toBeNull()
  expect(ageDays(at, at + 9 * day + 5000)).toBe(9)
  expect(staleWarning(at, at + 9 * day)).toBe(
    'Warning: this handoff is 9 days old (30.09.2026 14:30); treat its state as outdated and verify everything.',
  )
})

test('resume marks are numbers under a handoff file path', () => {
  expect(usedAt(5)).toBe(5)
  expect(usedAt('5')).toBeNull()
  expect(usedAt(undefined)).toBeNull()
  expect(isHandoffPath('/h/.claude/handoffs/-r/handoff-2026-10-09-143005.md')).toBe(true)
  expect(isHandoffPath('/h/.claude/handoffs/-r/handoff-2026-10-09-143005-2.md')).toBe(true)
  expect(isHandoffPath('hintThreshold')).toBe(false)
  expect(isHandoffPath('/h/.claude/handoffs/-r/LATEST.md')).toBe(false)
})
