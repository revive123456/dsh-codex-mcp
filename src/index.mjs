/**
 * Public entry point for the `dsh-codex-mcp` package.
 * @module index
 */

export { describeRun, describeEnvironment, environmentReport } from './describe.mjs'
export { entryCandidates, resolveEntry, isScriptEntry, ENTRY_ENV } from './resolve.mjs'
export {
  DEFAULT_TIMEOUT_MS,
  MAX_FINAL_MESSAGE_BYTES,
  MODEL_ENV,
  RUN_ID_RE,
  SANDBOX,
  STAGING_ENV,
  TIMEOUT_ENV,
  codexEnv,
  collectArtifacts,
  defaultStagingRoot,
  listRuns,
  newRunId,
  parseCodexEvents,
  pruneRuns,
  readArtifact,
  runCodex,
} from './run.mjs'

// `./server.mjs` is deliberately NOT re-exported: importing it starts the stdio
// server as a side effect. Load it through `./server` or `codex-mcp serve`.
