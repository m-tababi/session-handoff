# session-handoff

A Claude Code plugin that writes a structured handoff of the current session on request and starts a fresh conversation from it.

## What it does

- **`/handoff`** asks a fork of the current session for a handoff report in ten sections and saves it to `~/.claude/handoffs/<project-slug>/`. `LATEST.md` in the same folder points at the newest file.
- **`/handoff resume`** puts a continue prompt into the input box. The prompt holds the full text and path of this project's newest handoff. Nothing is sent until you press Enter. `/handoff resume --force` resumes a handoff that was already resumed.
- **Restart with handoff.** The restart pill ` ⟲ Neustart + Übergabe ` and the command `/handoff fresh` run the same steps:
  1. A confirm dialog appears.
  2. A handoff is written.
  3. The built-in `/clear` runs.
  4. The full handoff is submitted automatically as the first prompt of the fresh conversation.
- **Resume tracking.** A handoff that has been resumed is marked. Resuming it again needs `--force`, and `/handoff list` shows the mark.
- **Age warning.** A handoff that is 7 days old or older gets a warning at the top of the resume prompt.
- **Startup reminder.** In interactive sessions, a toast at session start names a handoff that is under 7 days old and has not been resumed.
- **Context hint.** A one-time toast (`Kontext NN % – /handoff?`) appears when the context window passes a threshold. The default threshold is 80 %.
- **Files are never deleted.** The plugin only ever adds handoff files and rewrites `LATEST.md`.

Nothing happens automatically. Handoffs are written only by `/handoff`, by the pill, or by `/handoff fresh`. The session is cleared only after you confirm with "Ja, neu starten".

## Requirements

- Claude Code with the plugin (mods) API for function hooks. Tested on Claude Code 2.1.295.
- `git` on `PATH` (optional; outside a repository the plugin uses the session root).
- `HOME` set to an absolute path.
- The restart pill:
  - **Fullscreen terminal or desktop app:** the pill sits in the hint line under the prompt (`? for shortcuts`) and is clicked with the mouse.
  - **Terminal main screen (not fullscreen):** a right-aligned pill appears in the band above the prompt. It can be reached with a click or with `ctrl+x tab`.
  - Everywhere, `/handoff fresh` is the keyboard route.

## A note on language

- **User-facing strings are German.** This covers command output, toasts, the confirm dialog and its buttons, the pill labels and the `/handoff` description. Dates use `DD.MM.YYYY HH:MM`.
- **The prompts sent to the model are English.** These are the handoff prompt and the resume prompt.
- **The handoff text** is written in whatever language the model answers in.
- The code is not localized, and there is no language setting.

## Installation

The repository is its own single-plugin marketplace. It is private, so whoever installs it needs read access to `m-tababi/session-handoff` through their git or GitHub credentials.

From a shell:

```sh
claude plugin marketplace add m-tababi/session-handoff
claude plugin install session-handoff@session-handoff
```

Or at the prompt of a Claude Code terminal session:

```
/plugin install session-handoff --marketplace m-tababi/session-handoff
```

For local development, add the cloned folder as a marketplace:

```sh
claude plugin marketplace add /path/to/session-handoff
claude plugin install session-handoff@session-handoff
```

Alternatively, run one session with the plugin loaded from disk: `claude --plugin-dir /path/to/session-handoff`.

## Commands and options

| Command | What it does |
| --- | --- |
| `/handoff`, `/handoff now` | Writes a handoff and updates `LATEST.md`. The command returns once the fork has answered, which can take a minute in a long session. |
| `/handoff resume` | Appends the resume prompt for this project's newest handoff to the input box, after a blank line if a draft is there. It does not send it. |
| `/handoff resume --force` | Resumes a handoff that is already marked as resumed and updates the mark. |
| `/handoff fresh` | Starts the restart with handoff (see below). In a session without a UI (`claude -p`), it starts nothing. |
| `/handoff list` | Lists this project's 5 newest handoffs with time, summary line and resume mark. |
| `/handoff hint` | Shows the current context-hint setting. |
| `/handoff hint <1-99>` | Sets the context-hint threshold in percent and turns the hint on. |
| `/handoff hint on` / `off` | Turns the context hint on or off. |

`/handoff hint` settings are kept in the plugin's store and carry over to later sessions.

| Plugin option (`userConfig`) | Default | Meaning |
| --- | --- | --- |
| `hintThreshold` | `80` | Context fill in percent (1-99) for the one-time hint. A value set with `/handoff hint` overrides it. |

## How it works

### Writing a handoff

1. **Finding the project.** In git, the project is the folder above the common git directory, so all worktrees of a repository share one handoff folder. A submodule uses its own top level. Outside git, the project is the session root. Symbolic links are resolved. The shell's current directory is never used.
2. **Collecting git facts.** The plugin runs read-only git commands with a 10 s timeout each: `rev-parse`, `symbolic-ref`, `status --porcelain` and `log --oneline -5`.
3. **Asking the fork.** It calls `$.model.fork` with a prompt that asks for a summary line and ten sections:
   1. intent
   2. back-and-forth
   3. tools and skills
   4. sources
   5. iterations
   6. decisions
   7. current state (verified / not verified)
   8. asset map
   9. next steps with commands
   10. notes for the next agent
4. **Saving the file.** The reply goes to `handoff-YYYY-MM-DD-HHMMSS.md`, with `-2`, `-3`, ... for a second file in the same second. The file starts with the summary line and a header that names the project root, the time and the branch.
5. **If it fails.** When the fork gives no answer (`nothing-to-fork`, `api-error`, `aborted`, or an empty reply) or the write fails, nothing is saved. The command output and a toast give the reason.

### Resuming

The resume prompt tells the model to:

- read the whole handoff;
- state in at most 3 lines where things stand and what the next step is;
- check anything marked as done or verified before relying on it;
- continue with the steps that need no approval, and ask where the handoff says a step waits for a go-ahead.

`resume`, `list` and the startup toast only consider files whose header names the current project root.

If the session has no input box, the prompt is submitted directly. If a dialog is open, nothing is sent and nothing is marked.

### Restart

**Refusals.** The restart is refused while a main-thread turn is running or another restart is underway.

**Confirmation.** The dialog names any subagents that are still running, because `/clear` ends them. Only "Ja, neu starten" proceeds.

**Failure toasts.**

| Failure | Toast | What happens |
| --- | --- | --- |
| The handoff is not written | The reason, followed by "Sitzung nicht geleert." | The session is not cleared. |
| `/clear` fails, or the session id does not change | "Leeren fehlgeschlagen – Übergabe bleibt gespeichert: <path>" | Nothing is sent. |
| The automatic submit is refused | None | The prompt goes into the input box instead. |
| The input box refuses too | "Übergabe gespeichert – /handoff resume" | The prompt is not sent. |

The restart's prompt carries no age warning, since its handoff was just written.

**Pill states.** While a restart runs or a turn is in progress, the pill shows as a dim ` ⟲ läuft … ` label. In the hint line, the pill shortens to ` ⟲ Neustart ` when space is short and is left out below 12 free cells.

### Resume marks

After a resume or restart has delivered its prompt, the plugin store records the time under the handoff's absolute path. Writing a new handoff removes marks whose file no longer exists. The handoff files themselves are never deleted.

### Files

```
~/.claude/handoffs/<project-slug>/handoff-YYYY-MM-DD-HHMMSS.md
~/.claude/handoffs/<project-slug>/LATEST.md   (line 1: newest file name, line 2: summary)
```

`<project-slug>` is the project path with every `/` replaced by `-` (`/home/u/work/proj` becomes `-home-u-work-proj`).

## Privacy

- **Local files.** Handoffs are plain-text Markdown files under `~/.claude/handoffs/`. The plugin never writes into the project and never touches `.gitignore`. If the handoff folder would lie inside the project (for example, the project is `$HOME`), the command refuses.
- **One model request per handoff.** Writing a handoff uses `$.model.fork`, a model request over the session's own transcript. That request carries:
  - the conversation;
  - the project root path;
  - the branch name;
  - `git status --porcelain` output (file names);
  - the last five commit subjects.
- **Prompts sent from saved handoffs.** `resume` and the restart send the full handoff text as a prompt in the session.
- **No other network use.** The plugin makes no other requests.
- **Secrets.** The handoff prompt tells the model never to include passwords, API keys, tokens or other secrets. This is an instruction to the model, not a filter. Review handoffs before sharing them.

## Limitations

- `/clear` during a restart ends running subagents together with the old conversation.
- A resume counts as done once the prompt is in the input box, even if you clear it without sending. Use `--force` then.
- The input box receives the whole handoff, so a long handoff makes a long prompt.
- Slugs can collide: `/a-b/c` and `/a/b-c` both become `-a-b-c`. The project header keeps their handoffs apart, but `LATEST.md` in the shared folder points at whichever was written last.
- File times use the session clock in local time. Handoffs written in different time zones sort by their own local stamps.
- Running turns are tracked from `turn.start` and `turn.complete`. If the engine ever skipped a `turn.complete`, the restart would be refused until the next main-thread turn ends.
- The layout of the pill next to the engine's own hint-line pills has only been checked in live sessions, not in automated tests.

## Development

```sh
claude plugin validate .
claude plugin test .
```

`claude plugin test` runs every `*.test.ts` and `*.test.tsx` under `tests/`. To type-check, use a `tsconfig.json` kept outside the plugin folder, as described in the header of the engine's `claude-code.d.ts`. Once the engine has loaded the plugin, `tsc -p .` works with the types it writes to `.claude-plugin/types/`. That folder is ignored by git.

```
.claude-plugin/
  plugin.json        plugin manifest (name, version, userConfig)
  marketplace.json   single-plugin marketplace for this repository
hooks/
  hooks.json         lists the hooks module
  register.tsx       hooks, slash command, restart pill, engine calls
  handoff.ts         pure helpers: paths, file names, prompts, texts
types/
  index.d.ts         the plugin's $.state contract
tests/
  logic.test.ts      helper tests
  handoff.test.tsx   hook and UI tests against a test engine
```

## License

MIT. See [LICENSE](LICENSE).
