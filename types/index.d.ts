// Session-scoped flags; each lives in $.state so a hot reload keeps it.
export type SessionHandoffFlag = boolean

declare module 'claude-code' {
  interface PluginState {
    'session-handoff': {
      // A handoff is being written; a second /handoff now waits for it.
      busy: SessionHandoffFlag
      // The context hint was shown in this session.
      hinted: SessionHandoffFlag
      // The startup check for a recent handoff ran (session.start runs again on reload).
      startupChecked: SessionHandoffFlag
      // A main-thread turn runs (turn.start until its turn.complete).
      isTurnRunning: SessionHandoffFlag
      // A restart (button or /handoff fresh) is underway.
      restarting: SessionHandoffFlag
    }
  }
}
