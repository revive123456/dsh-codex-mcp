/**
 * Human- and model-readable rendering of one Codex run.
 *
 * Deliberately terse and content-free: the artifact list carries paths, sizes
 * and hashes, never bodies. Keeping bodies out of the render is what makes the
 * "artifacts pass through the caller" rule cheap to honour.
 *
 * @module describe
 */

import { defaultStagingRoot } from './run.mjs'
import { resolveEntry } from './resolve.mjs'

/** Render one run result as compact plain text. */
export function describeRun(result) {
  const lines = []
  lines.push(
    `${result.ok ? 'ok' : 'FAILED'}  exit=${result.exitCode === null ? 'null' : result.exitCode}` +
      `${result.timedOut ? ' (timed out)' : ''}  ${(result.durationMs / 1000).toFixed(1)}s  ` +
      `model=${result.model ?? 'codex default'}  terminal=${result.terminalEvent ? 'yes' : 'no'}`,
  )
  lines.push(`run        ${result.runId}`)
  lines.push(`artifact   ${result.artifactRoot}`)
  lines.push(`manifest   ${result.manifestPath}`)
  if (result.threadId) lines.push(`thread     ${result.threadId}`)
  if (result.usage) {
    const usage = result.usage
    lines.push(
      `usage      input=${usage.input_tokens ?? '?'} cached=${usage.cached_input_tokens ?? '?'} ` +
        `output=${usage.output_tokens ?? '?'}`,
    )
  }
  if (result.errors.length > 0) {
    lines.push('errors')
    for (const error of result.errors) lines.push(`  - ${String(error).slice(0, 400)}`)
  }
  if (result.warnings?.length > 0) {
    lines.push('warnings')
    for (const warning of result.warnings) lines.push(`  - ${String(warning).slice(0, 400)}`)
  }

  lines.push('', 'final message', '-------------')
  lines.push(result.finalMessage === '' ? '(empty)' : result.finalMessage)

  lines.push('', `artifacts (${result.artifacts.length}) — bodies are NOT included, read them yourself`, '-------------')
  if (result.artifacts.length === 0) lines.push('(none)')
  for (const artifact of result.artifacts) {
    if (artifact.missing) {
      lines.push(`missing    ${artifact.path}${artifact.note ? ` (${artifact.note})` : ''}`)
      continue
    }
    if (artifact.rejected !== undefined) {
      lines.push(`rejected   ${artifact.path} (${artifact.rejected})`)
      continue
    }
    lines.push(
      `${String(artifact.bytes).padStart(8)} B  sha256:${artifact.sha256.slice(0, 16)}  ${artifact.path}` +
        `${artifact.binary ? '  (binary)' : ''}`,
    )
  }

  if (result.stderrTail.trim() !== '') {
    lines.push('', 'stderr tail', '-------------', result.stderrTail.trim().slice(-1_500))
  }
  return lines.join('\n')
}

/** Render the resolved launch environment, for `env` diagnostics. */
export function describeEnvironment({ entry, stagingRoot = defaultStagingRoot(), timeoutMs, model }) {
  return [
    `entry      ${entry.entry}`,
    `source     ${entry.source}`,
    `spawn      ${entry.command}${entry.args.length > 0 ? ` ${entry.args.join(' ')}` : ''}`,
    `interpreter pinned  ${entry.interpreterPinned ? 'yes' : 'no'}`,
    `staging    ${stagingRoot}`,
    `timeout    ${timeoutMs} ms`,
    `model      ${model === '' ? '(codex default)' : model}`,
    `node       ${process.execPath} (${process.version})`,
  ].join('\n')
}

/**
 * Render the resolved launch environment for the CLI's `env` command.
 *
 * Lives here rather than in `server.mjs` so that importing it never starts the
 * stdio server as a side effect.
 */
export function environmentReport(env = process.env, timeoutMs, model) {
  return describeEnvironment({
    entry: resolveEntry({ env }),
    stagingRoot: defaultStagingRoot(env),
    timeoutMs: timeoutMs ?? env.CODEX_MCP_TIMEOUT_MS ?? 900_000,
    model: String(model ?? env.CODEX_MCP_MODEL ?? '').trim(),
  })
}
