/**
 * `codex-mcp` command line interface.
 *
 * A thin shell over the same modules the MCP server uses, so the two can never
 * disagree. The CLI carries the diagnostics that are deliberately absent from
 * the MCP surface (`env`, `runs`), because a tool schema costs the caller
 * context on every single turn while a CLI subcommand costs nothing.
 *
 * @module cli
 */

import { readFileSync } from 'node:fs'
import { environmentReport, describeRun } from './describe.mjs'
import { defaultStagingRoot, listRuns, pruneRuns, runCodex } from './run.mjs'

const USAGE = `codex-mcp — run the local Codex CLI behind a scratch-directory boundary

Usage:
  codex-mcp run --prompt "TASK" [options]   run one Codex task
  codex-mcp runs [--staging-root DIR] [--limit N]
  codex-mcp prune [--older-than-days N] [--keep N] [--dry-run]
  codex-mcp env                             show how Codex will be launched
  codex-mcp serve                           run the MCP server on stdio

run options:
  -p, --prompt TEXT        the complete, self-contained task
      --prompt-file FILE   read the task from a file instead
  -m, --model MODEL        Codex model id (default: $CODEX_MCP_MODEL, else Codex's own)
      --files a,b,c        report only these paths (relative to the artifact root)
      --timeout-ms N       deadline for the whole run (default: $CODEX_MCP_TIMEOUT_MS, else 900000)
      --staging-root DIR   where runs are staged (default: $CODEX_MCP_STAGING_DIR, else <cwd>/.codex-staging)
      --json               print the run manifest as JSON instead of text

Codex runs with -s workspace-write and -C <staging>/<runId>/work, so it can read
this workspace but can only write inside that scratch directory. Artifact bodies
are never printed here either: read the paths yourself and review them first.

Examples:
  codex-mcp run -p "Review the plan at plan/foo.md and write review.md" -m gpt-6-astra
  codex-mcp runs --limit 5
  codex-mcp env
`;

/** Parse `codex-mcp run` arguments. */
export function parseRunArgs(tokens) {
  const request = { prompt: [], files: undefined }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    const next = () => {
      index += 1
      if (index >= tokens.length) throw new Error(`${token} expects a value`)
      return tokens[index]
    }
    switch (token) {
      case '-p':
      case '--prompt':
        request.prompt.push(next())
        break
      case '--prompt-file':
        request.promptFile = next()
        break
      case '-m':
      case '--model':
        request.model = next()
        break
      case '--files':
        request.files = next()
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry !== '')
        break
      case '--timeout-ms':
        request.timeoutMs = Number(next())
        break
      case '--staging-root':
        request.stagingRoot = next()
        break
      case '--json':
        request.json = true
        break
      default:
        request.prompt.push(token)
    }
  }
  if (request.promptFile !== undefined) {
    request.prompt = readFileSync(request.promptFile, 'utf8')
  } else {
    request.prompt = request.prompt.join(' ').trim()
  }
  if (request.prompt === '') throw new Error('a prompt is required, e.g. codex-mcp run -p "TASK"')
  return request
}

/** Read one numeric flag value. */
function numberFlag(tokens, name, fallback) {
  const index = tokens.indexOf(name)
  if (index === -1) return fallback
  const value = Number(tokens[index + 1])
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} expects a positive number`)
  return value
}

/** Read one string flag value. */
function stringFlag(tokens, name, fallback) {
  const index = tokens.indexOf(name)
  if (index === -1) return fallback
  const value = tokens[index + 1]
  if (value === undefined) throw new Error(`${name} expects a value`)
  return value
}

/** Read one flag value that may legitimately be 0 (prune boundaries). */
function nonNegativeFlag(tokens, name, fallback) {
  const index = tokens.indexOf(name)
  if (index === -1) return fallback
  const value = Number(tokens[index + 1])
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} expects a number >= 0`)
  return value
}

/**
 * Run the CLI.
 *
 * @param argv - arguments after the executable name.
 * @returns the process exit code.
 */
export async function main(argv = []) {
  const [command, ...rest] = argv

  try {
    switch (command) {
      case 'run': {
        const request = parseRunArgs(rest)
        const result = await runCodex(request)
        process.stdout.write(request.json ? `${JSON.stringify(result, null, 2)}\n` : `${describeRun(result)}\n`)
        return result.ok ? 0 : 1
      }

      case 'runs': {
        const stagingRoot = stringFlag(rest, '--staging-root', defaultStagingRoot())
        const limit = numberFlag(rest, '--limit', 20)
        const runs = listRuns(stagingRoot, limit)
        if (runs.length === 0) {
          process.stdout.write(`no runs under ${stagingRoot}\n`)
          return 0
        }
        for (const run of runs) {
          process.stdout.write(
            `${run.ok ? 'ok  ' : 'FAIL'} ${run.runId}  ${run.createdAt ?? '?'}  ` +
              `${run.artifactCount ?? 0} artifact(s)  model=${run.model ?? 'codex default'}` +
              `${run.error ? `  error=${run.error}` : ''}\n`,
          )
        }
        return 0
      }

      case 'prune': {
        const stagingRoot = stringFlag(rest, '--staging-root', defaultStagingRoot())
        const days = nonNegativeFlag(rest, '--older-than-days', 7)
        const keep = nonNegativeFlag(rest, '--keep', 0)
        const dryRun = rest.includes('--dry-run')
        const removed = pruneRuns(stagingRoot, { maxAgeMs: days * 24 * 60 * 60 * 1000, keep, dryRun })
        if (removed.length === 0) {
          process.stdout.write(`nothing to prune under ${stagingRoot}\n`)
        } else {
          for (const runId of removed) process.stdout.write(`${dryRun ? 'would remove' : 'removed'} ${runId}\n`)
        }
        return 0
      }

      case 'env':
        process.stdout.write(`${environmentReport(process.env)}\n`)
        return 0

      case 'serve':
        await import('./server.mjs')
        return 0

      case undefined:
      case '-h':
      case '--help':
      case 'help':
        process.stdout.write(USAGE)
        return 0

      default:
        process.stderr.write(`unknown command: ${command}\n\n${USAGE}`)
        return 2
    }
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
