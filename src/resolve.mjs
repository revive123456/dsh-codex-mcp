/**
 * Resolve how to launch the local Codex CLI on this machine.
 *
 * There is no single portable answer. An npm global shim is a
 * `#!/usr/bin/env node` script, which dies with `env: node: No such file or
 * directory` whenever the caller's PATH has no `node` — exactly the case for a
 * Finder-launched desktop app (PATH is only /usr/bin:/bin:/usr/sbin:/sbin).
 * A wrapper that pins the interpreter, or an absolute `codex.js`, are both
 * directly spawnable, so this module resolves one entry point and returns an
 * argv prefix that never depends on the caller's PATH containing `node`.
 *
 * Resolution order:
 *   1. `CODEX_MCP_ENTRY` — explicit override; script paths are spawned with
 *      `process.execPath` so a bare npm shim also works.
 *   2. `<home>/.local/bin/codex-desktop` — a wrapper that pins the interpreter.
 *   3. `<home>/.npm-global/lib/node_modules/@openai/codex/bin/codex.js`.
 *   4. `codex` on `PATH`.
 *
 * @module resolve
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/** Environment variable that pins the Codex entry point. */
export const ENTRY_ENV = 'CODEX_MCP_ENTRY'

const SCRIPT_RE = /\.(?:mjs|cjs|js)$/i

/** True when an entry is a JavaScript file that needs an explicit interpreter. */
export function isScriptEntry(entry) {
  return SCRIPT_RE.test(entry)
}

/** Find an entry named `name` on `PATH`, or undefined. */
function searchPath(name, pathValue, exists) {
  for (const dir of String(pathValue ?? '').split(delimiter)) {
    if (dir === '') continue
    const candidate = join(dir, name)
    if (exists(candidate)) return candidate
  }
  return undefined
}

/**
 * Candidate entry points, most explicit first.
 * @returns {{entry: string, source: string}[]}
 */
export function entryCandidates({ env = process.env, home = homedir(), exists = existsSync } = {}) {
  const candidates = []
  const explicit = env[ENTRY_ENV]
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    candidates.push({ entry: explicit, source: ENTRY_ENV })
  }
  candidates.push({ entry: join(home, '.local', 'bin', 'codex-desktop'), source: 'codex-desktop wrapper' })
  candidates.push({
    entry: join(home, '.npm-global', 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
    source: 'npm global codex.js',
  })
  const onPath = searchPath('codex', env.PATH, exists)
  if (onPath !== undefined) candidates.push({ entry: onPath, source: 'PATH' })
  return candidates
}

/**
 * Resolve the Codex entry point and the argv prefix used to spawn it.
 *
 * @param options - injectable environment, home, existence check and node path.
 * @returns the entry, where it came from, and the spawn prefix.
 * @throws Error when no candidate exists.
 */
export function resolveEntry({ env = process.env, home = homedir(), exists = existsSync, nodePath = process.execPath } = {}) {
  const candidates = entryCandidates({ env, home, exists })
  const found = candidates.find((candidate) => exists(candidate.entry))
  if (found === undefined) {
    throw new Error(
      `could not find the Codex CLI; set ${ENTRY_ENV} to an absolute path. Tried: ` +
        candidates.map((candidate) => candidate.entry).join(', '),
    )
  }
  const script = isScriptEntry(found.entry)
  return {
    entry: found.entry,
    source: found.source,
    command: script ? nodePath : found.entry,
    args: script ? [found.entry] : [],
    interpreterPinned: script,
  }
}
