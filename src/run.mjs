/**
 * Run one local `codex exec` inside an isolated scratch directory and report
 * its artifacts by path, size and hash — never by content.
 *
 * Why this exists: `codex exec` defaults to Codex's read-only sandbox, so a
 * caller that passes no sandbox flag gets a Codex that cannot write a single
 * file, and the only channel back is the final message text. This module gives
 * every run its own scratch directory, runs Codex there with an explicit
 * `-s workspace-write`, and returns a manifest instead. The caller decides what
 * to read and what to copy into the workspace, so the model never writes a
 * production path directly.
 *
 * Hardening (found by an independent Codex review of this design):
 * - artifact paths are resolved inside the artifact root; escapes and symbolic
 *   links are refused rather than hashed;
 * - run ids are format-checked and cannot escape the staging root or overwrite
 *   an existing run;
 * - credential-shaped environment variables are not inherited by Codex;
 * - a run only counts as `ok` when it exited 0, reported no error event, did not
 *   time out, and produced a non-empty final message;
 * - a timeout kills the whole process group, not just the direct child.
 *
 * @module run
 */

import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { resolveEntry } from './resolve.mjs'

/** The only sandbox mode this server uses: Codex may write its scratch, nothing else. */
export const SANDBOX = 'workspace-write'

/** Environment variable selecting the default Codex model. */
export const MODEL_ENV = 'CODEX_MCP_MODEL'

/** Environment variable overriding the staging root. */
export const STAGING_ENV = 'CODEX_MCP_STAGING_DIR'

/** Environment variable overriding the per-run deadline. */
export const TIMEOUT_ENV = 'CODEX_MCP_TIMEOUT_MS'

/** Deadline for one run when nothing else is configured. */
export const DEFAULT_TIMEOUT_MS = 900_000

/** Final-message bytes returned to the caller before truncation. */
export const MAX_FINAL_MESSAGE_BYTES = 16_384

/** Accepted run-id format: no separators, so it can never escape a directory. */
export const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * Names never inherited by Codex. DSH scrubs its own children, but a directly
 * invoked CLI inherits the caller's shell, so this package drops
 * credential-shaped names itself. Per-call `env` overrides are trusted as-is.
 */
const SENSITIVE_ENV_RE = /KEY|PASSWORD|SECRET|TOKEN/i

const MAX_STDOUT_BYTES = 8 * 1024 * 1024
const MAX_STDERR_BYTES = 64 * 1024

/** Files this module owns inside the run directory; never reported as artifacts. */
const CONTROL_FILES = new Set(['prompt.txt', 'last-message.txt', 'manifest.json'])

const WORK_DIR = 'work'
const LAST_MESSAGE = 'last-message.txt'
const MANIFEST = 'manifest.json'

const SKIP_DIRS = new Set(['.git', 'node_modules'])

/**
 * Build a sortable, collision-resistant run id.
 * @param now - clock reading to stamp.
 * @param random - hex suffix.
 */
export function newRunId(now = new Date(), random = randomBytes(2).toString('hex')) {
  const pad = (value) => String(value).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `run-${stamp}-${random}`
}

/** The staging root: one directory holding one subdirectory per run. */
export function defaultStagingRoot(env = process.env, cwd = process.cwd()) {
  const configured = env[STAGING_ENV]
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured)
  return join(cwd, '.codex-staging')
}

/**
 * Build the environment handed to Codex: the inherited environment minus
 * credential-shaped names, then the caller's explicit per-call overrides.
 *
 * @param inherited - the environment to filter.
 * @param overrides - explicit values for one call, trusted verbatim.
 */
export function codexEnv(inherited = process.env, overrides = {}) {
  const env = {}
  for (const [name, value] of Object.entries(inherited)) {
    if (SENSITIVE_ENV_RE.test(name)) continue
    env[name] = value
  }
  return { ...env, ...overrides }
}

/** True when `target` is `root` itself or below it. */
function isInside(root, target) {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Parse a positive integer, or return the fallback. */
function positiveInt(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

/**
 * Read a `codex exec --json` event stream.
 *
 * Tolerant by design: an unknown event type is data, not an error, and a
 * non-JSON line is recorded as a diagnostic instead of aborting the run.
 *
 * @param text - the captured stdout.
 * @returns the events plus the facts the caller needs.
 */
export function parseCodexEvents(text) {
  const events = []
  const errors = []
  const agentMessages = []
  let usage = null
  let threadId = null

  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      errors.push(`unparsable JSONL line: ${line.slice(0, 200)}`)
      continue
    }
    events.push(event)
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') threadId = event.thread_id
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      if (typeof event.item.text === 'string') agentMessages.push(event.item.text)
    }
    if (event.type === 'item.completed' && event.item?.type === 'error' && typeof event.item.message === 'string') {
      errors.push(event.item.message)
    }
    if (event.type === 'error' && typeof event.message === 'string') errors.push(event.message)
    if (event.type === 'turn.failed') errors.push(event.error?.message ?? 'codex reported a failed turn')
    if (event.type === 'turn.completed' && event.usage) usage = event.usage
  }

  return { events, errors, agentMessages, usage, threadId }
}

/** Walk a directory, depth first, skipping symlinks, VCS and dependency noise. */
function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name)
    const info = lstatSync(abs)
    if (info.isSymbolicLink()) continue
    if (info.isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(abs, out)
      continue
    }
    if (info.isFile()) out.push(abs)
  }
  return out
}

/** sha256 of a buffer, hex encoded. */
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** Describe one file inside the artifact root without reading outside it. */
function describeArtifact(root, target) {
  const relativePath = relative(root, target).split(sep).join('/')
  if (!existsSync(target)) return { path: relativePath, missing: true }
  const info = lstatSync(target)
  if (info.isSymbolicLink()) return { path: relativePath, rejected: 'symbolic link' }
  if (!info.isFile()) return { path: relativePath, missing: true, note: 'not a regular file' }
  const buffer = readFileSync(target)
  return {
    path: relativePath,
    absolutePath: target,
    bytes: buffer.length,
    sha256: sha256(buffer),
    binary: buffer.includes(0),
  }
}

/**
 * Report the files a run produced. Content is never included: the caller reads
 * what it needs and reviews it before copying anything anywhere.
 *
 * A requested path that resolves outside the artifact root is reported as
 * `rejected` instead of being read, so a path in a manifest can never name a
 * file the model was not allowed to write.
 *
 * @param workDir - the directory Codex was allowed to write.
 * @param options - optional explicit `files` list (paths relative to workDir).
 * @returns artifact descriptors, sorted by path.
 */
export function collectArtifacts(workDir, options = {}) {
  const root = resolve(workDir)
  const requested = options.files
  const artifacts = []

  if (Array.isArray(requested) && requested.length > 0) {
    for (const entry of requested) {
      const target = resolve(root, String(entry))
      if (!isInside(root, target)) {
        artifacts.push({
          path: String(entry).split(sep).join('/'),
          rejected: 'path escapes the artifact root',
        })
        continue
      }
      artifacts.push(describeArtifact(root, target))
    }
  } else {
    for (const target of walk(root)) artifacts.push(describeArtifact(root, target))
  }

  return artifacts.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * Run one Codex task in a fresh scratch directory.
 *
 * @param options - prompt, optional model/files/timeoutMs/stagingRoot/runId/env.
 * @returns the run manifest: ids, paths, outcome, final message and artifacts.
 */
export async function runCodex(options = {}) {
  const prompt = options.prompt
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new Error('codex run: prompt must be a non-empty string')
  }

  const env = codexEnv(process.env, options.env)
  const model = String(options.model ?? env[MODEL_ENV] ?? '').trim()
  const timeoutMs = positiveInt(options.timeoutMs ?? env[TIMEOUT_ENV], DEFAULT_TIMEOUT_MS)
  const stagingRoot = resolve(options.stagingRoot ?? defaultStagingRoot(env, options.cwd ?? process.cwd()))
  const runId = options.runId ?? newRunId()
  if (!RUN_ID_RE.test(runId)) {
    throw new Error(`codex run: runId must match ${RUN_ID_RE} and contain no path separator, received ${JSON.stringify(runId)}`)
  }
  const runDir = resolve(stagingRoot, runId)
  if (runDir === stagingRoot || !isInside(stagingRoot, runDir)) {
    throw new Error(`codex run: runId escapes the staging root: ${JSON.stringify(runId)}`)
  }
  if (existsSync(runDir)) {
    throw new Error(`codex run: run directory already exists, refusing to overwrite it: ${runDir}`)
  }

  const workDir = join(runDir, WORK_DIR)
  mkdirSync(workDir, { recursive: true })

  const entry = resolveEntry({ env, nodePath: options.nodePath ?? process.execPath })
  const lastMessagePath = join(runDir, LAST_MESSAGE)
  const codexArgs = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--ephemeral',
    '-s',
    SANDBOX,
    '-C',
    workDir,
    '--output-last-message',
    lastMessagePath,
  ]
  if (model !== '') codexArgs.push('-m', model)

  writeFileSync(join(runDir, 'prompt.txt'), prompt)

  const argv = [...entry.args, ...codexArgs]
  const startedAt = Date.now()
  // A detached child leads its own process group on POSIX, so a timeout can
  // signal Codex *and* the shell commands it spawned.
  const detached = process.platform !== 'win32'
  const child = spawn(entry.command, argv, {
    cwd: workDir,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached,
  })

  const signalChild = (signal) => {
    if (detached) {
      try {
        process.kill(-child.pid, signal)
        return
      } catch {
        // The group is already gone; fall back to the direct child.
      }
    }
    child.kill(signal)
  }

  const outcome = await new Promise((settle) => {
    let stdout = ''
    let stderr = ''
    let stdoutOverflow = false
    let timedOut = false
    let settled = false

    const killTimer = setTimeout(() => {
      timedOut = true
      signalChild('SIGTERM')
      const hardKill = setTimeout(() => signalChild('SIGKILL'), 5_000)
      hardKill.unref?.()
    }, timeoutMs)
    killTimer.unref?.()

    const finish = (code, signal, spawnError) => {
      if (settled) return
      settled = true
      clearTimeout(killTimer)
      settle({ code, signal, spawnError, stdout, stderr, timedOut, stdoutOverflow })
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (stdout.length < MAX_STDOUT_BYTES) stdout += chunk
      else stdoutOverflow = true
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += chunk
    })
    child.on('error', (error) => finish(null, null, error))
    child.on('close', (code, signal) => finish(code, signal, null))
    // Codex reads the task from stdin; an EPIPE here is already surfaced by `close`.
    child.stdin.on('error', () => {})
    child.stdin.end(prompt)
  })

  const parsed = parseCodexEvents(outcome.stdout)
  let finalMessage = ''
  if (existsSync(lastMessagePath)) finalMessage = readFileSync(lastMessagePath, 'utf8')
  else if (parsed.agentMessages.length > 0) finalMessage = parsed.agentMessages[parsed.agentMessages.length - 1]

  if (Buffer.byteLength(finalMessage, 'utf8') > MAX_FINAL_MESSAGE_BYTES) {
    finalMessage = `${Buffer.from(finalMessage).subarray(0, MAX_FINAL_MESSAGE_BYTES).toString('utf8')}\n[truncated]`
  }

  const terminalEvent = parsed.events.some(
    (event) => event.type === 'turn.completed' || event.type === 'turn.failed',
  )
  const errors = [...parsed.errors]
  if (outcome.spawnError) errors.push(String(outcome.spawnError.message ?? outcome.spawnError))
  if (outcome.stdoutOverflow) errors.push('codex stdout exceeded the capture limit; the event stream is incomplete')

  const warnings = []
  if (!terminalEvent) warnings.push('no terminal turn event was observed in the event stream')
  if (finalMessage.trim() === '') warnings.push('codex produced no final message')

  const artifacts = collectArtifacts(workDir, options)
  // A run delivered something if it answered or produced at least one artifact:
  // Codex legitimately exits 0 with an empty reply when the file *is* the answer
  // (measured: "create hello.txt" exits 0 with an empty final message).
  const delivered = finalMessage.trim() !== '' || artifacts.some((artifact) => !artifact.missing && !artifact.rejected)
  if (!delivered) warnings.push('codex produced neither a final message nor an artifact')

  const result = {
    runId,
    runDir,
    workDir,
    artifactRoot: workDir,
    manifestPath: join(runDir, MANIFEST),
    createdAt: new Date(startedAt).toISOString(),
    ok:
      outcome.spawnError == null &&
      !outcome.timedOut &&
      outcome.code === 0 &&
      parsed.errors.length === 0 &&
      delivered,
    exitCode: outcome.code,
    signal: outcome.signal,
    timedOut: outcome.timedOut,
    durationMs: Date.now() - startedAt,
    sandbox: SANDBOX,
    model: model === '' ? null : model,
    codex: { entry: entry.entry, source: entry.source },
    threadId: parsed.threadId,
    terminalEvent,
    usage: parsed.usage,
    eventCount: parsed.events.length,
    finalMessage,
    errors,
    warnings,
    stderrTail: outcome.stderr.slice(-4_000),
    artifacts,
    command: [entry.command, ...argv].join(' '),
  }

  writeFileSync(result.manifestPath, `${JSON.stringify(result, null, 2)}\n`)
  return result
}

/** The control files a run directory keeps outside the artifact root. */
export function controlFiles() {
  return [...CONTROL_FILES]
}

/**
 * List finished runs under a staging root, newest first.
 *
 * @param stagingRoot - directory holding one subdirectory per run.
 * @param limit - maximum entries to return.
 */
export function listRuns(stagingRoot = defaultStagingRoot(), limit = 20) {
  if (!existsSync(stagingRoot)) return []
  const runs = []
  for (const name of readdirSync(stagingRoot).sort().reverse()) {
    const manifestPath = join(stagingRoot, name, MANIFEST)
    if (!existsSync(manifestPath)) continue
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
      runs.push({
        runId: parsed.runId,
        createdAt: parsed.createdAt,
        ok: parsed.ok,
        exitCode: parsed.exitCode,
        durationMs: parsed.durationMs,
        model: parsed.model,
        artifactCount: Array.isArray(parsed.artifacts) ? parsed.artifacts.length : 0,
      })
    } catch (error) {
      runs.push({ runId: name, error: String(error?.message ?? error) })
    }
    if (runs.length >= limit) break
  }
  return runs
}

/**
 * Delete staged runs older than `maxAgeMs`, always keeping the `keep` newest.
 *
 * The manifest is the audit record, so pruning is explicit and conservative:
 * the default keeps a week, and `dryRun` reports without deleting.
 *
 * @param stagingRoot - directory holding one subdirectory per run.
 * @param options - maxAgeMs, keep (newest runs preserved), dryRun.
 * @returns the run ids that were (or would be) removed.
 */
export function pruneRuns(stagingRoot = defaultStagingRoot(), options = {}) {
  // 0 is meaningful here: "everything except the newest `keep` runs".
  const maxAgeMs =
    Number.isFinite(options.maxAgeMs) && options.maxAgeMs >= 0
      ? options.maxAgeMs
      : 7 * 24 * 60 * 60 * 1000
  const keep = Number.isFinite(options.keep) ? Math.max(0, Math.floor(options.keep)) : 0
  const now = Date.now()
  const removed = []

  listRuns(stagingRoot, Number.MAX_SAFE_INTEGER).forEach((run, index) => {
    if (index < keep) return
    const created = Date.parse(run.createdAt ?? '')
    if (Number.isFinite(created) && now - created <= maxAgeMs) return
    removed.push(run.runId)
    if (options.dryRun !== true) {
      const runDir = resolve(stagingRoot, run.runId)
      if (isInside(resolve(stagingRoot), runDir) && runDir !== resolve(stagingRoot)) {
        rmSync(runDir, { recursive: true, force: true })
      }
    }
  })

  return removed
}

/**
 * Read one artifact of a finished run, refusing to escape that run's directory.
 *
 * @param runId - the run to read from.
 * @param relativePath - path relative to the run's artifact root.
 * @param options - stagingRoot and maxBytes.
 */
export function readArtifact(runId, relativePath, options = {}) {
  const stagingRoot = resolve(options.stagingRoot ?? defaultStagingRoot())
  const runDir = resolve(stagingRoot, String(runId))
  if (runDir === stagingRoot || !isInside(stagingRoot, runDir)) {
    throw new Error(`artifact read: run id escapes the staging root: ${runId}`)
  }
  const root = join(runDir, WORK_DIR)
  const target = resolve(root, String(relativePath))
  if (target === root || !isInside(root, target)) {
    throw new Error(`artifact read: path escapes the run directory: ${relativePath}`)
  }
  if (!existsSync(target)) throw new Error(`artifact read: no such artifact: ${runId}/${relativePath}`)
  const info = lstatSync(target)
  if (info.isSymbolicLink()) throw new Error(`artifact read: refusing to follow a symbolic link: ${relativePath}`)
  if (!info.isFile()) throw new Error(`artifact read: not a regular file: ${runId}/${relativePath}`)

  const buffer = readFileSync(target)
  const maxBytes = positiveInt(options.maxBytes, 262_144)
  const cut = buffer.subarray(0, Math.min(buffer.length, maxBytes))
  return {
    runId,
    path: relative(root, target).split(sep).join('/'),
    absolutePath: target,
    bytes: buffer.length,
    sha256: sha256(buffer),
    binary: buffer.includes(0),
    truncated: buffer.length > cut.length,
    text: buffer.includes(0) ? null : cut.toString('utf8'),
  }
}
