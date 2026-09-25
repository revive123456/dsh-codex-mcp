/**
 * codex-mcp MCP server over stdio (newline-delimited JSON-RPC 2.0).
 *
 * Exposes exactly ONE tool, on purpose. Every tool schema is a permanent tax on
 * the caller's context, and the whole point of this server is context economy:
 * `run` does the work and returns paths plus hashes; reading an artifact is the
 * caller's own file-read call, targeted and offsettable, instead of a second
 * schema that would inline bodies into the transcript. Diagnostics live in the
 * CLI (`codex-mcp env|runs`), where they cost nothing per turn.
 *
 * Protocol notes:
 * - stdout carries ONLY JSON-RPC frames; all diagnostics go to stderr.
 * - Tool failures come back as `isError` results rather than JSON-RPC errors,
 *   so the caller reads the real message instead of a generic one.
 *
 * @module server
 */

import { describeRun } from './describe.mjs'
import { DEFAULT_TIMEOUT_MS, MODEL_ENV, TIMEOUT_ENV, runCodex } from './run.mjs'

/** Server identity reported during `initialize`. */
export const SERVER_NAME = 'codex-mcp'

/** Server version reported during `initialize`. */
export const SERVER_VERSION = '0.1.0'

const SUPPORTED_PROTOCOL = '2024-11-05'

const INSTRUCTIONS = [
  'Run the local Codex CLI on a self-contained task and get its artifacts back as paths plus sha256.',
  'Codex is confined to workspace-write inside its own scratch directory: it can read this workspace but cannot write anywhere except its scratch.',
  'Artifact bodies are never inlined — read the paths under the artifact root, review them, and only then write the approved content into the workspace.',
  'Use it for plan review, code review and independent second opinions.',
].join(' ')

/** Tool catalogue exposed to the harness. */
export const TOOLS = [
  {
    name: 'run',
    description:
      'Run one Codex CLI task (`codex exec`) in an isolated scratch directory. Returns Codex\'s final ' +
      'message plus an artifact manifest (path, bytes, sha256 per file) — file bodies are NEVER included. ' +
      'Codex can read the workspace but can only write inside its own scratch directory. Read the artifact ' +
      'paths yourself, review them, and only then copy what you approve into the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            'The complete, self-contained task for Codex. It does not share this conversation, so include ' +
            'everything it needs (paths it may read, the exact question, and the output file it should write).',
        },
        model: {
          type: 'string',
          description:
            `Optional Codex model id for this call (for example gpt-6-astra for plan review). Omit to use the ` +
            `deployment default from ${MODEL_ENV}, or Codex's own configuration.`,
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional explicit list of artifact paths (relative to the artifact root) to report. Omit to ' +
            'report every file the run created.',
        },
        timeoutMs: {
          type: 'number',
          description:
            `Deadline in milliseconds for the whole run. Defaults to the deployment value ` +
            `(${TIMEOUT_ENV}, else ${DEFAULT_TIMEOUT_MS}).`,
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
]

/** Write one JSON-RPC frame to stdout. */
function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

/** Build a successful JSON-RPC response. */
function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

/** Build a JSON-RPC error response. */
function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

/** Wrap text into a successful MCP tool result. */
function textResult(text) {
  return { content: [{ type: 'text', text }] }
}

/** Wrap an error into a failed MCP tool result the caller can read and act on. */
function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error)
  return { content: [{ type: 'text', text: `error: ${message}` }], isError: true }
}

/** Service one `tools/call`. */
async function callTool(name, args) {
  switch (name) {
    case 'run': {
      const request = args ?? {}
      const result = await runCodex(request)
      return textResult(describeRun(result))
    }

    default:
      throw new Error(`unknown tool: ${String(name)}`)
  }
}

const HANDLERS = {
  initialize(params) {
    const requested = params?.protocolVersion
    const protocolVersion =
      typeof requested === 'string' && requested.length > 0 ? requested : SUPPORTED_PROTOCOL
    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: INSTRUCTIONS,
    }
  },

  ping() {
    return {}
  },

  'tools/list'() {
    return { tools: TOOLS }
  },

  async 'tools/call'(params) {
    try {
      return await callTool(params?.name, params?.arguments)
    } catch (error) {
      return errorResult(error)
    }
  },
}

/** Dispatch one parsed JSON-RPC message. */
async function dispatch(message) {
  const { id, method, params } = message ?? {}

  // Notifications carry no id and must never be answered.
  const isNotification = id === undefined || id === null

  const handler = HANDLERS[method]
  if (handler === undefined) {
    if (!isNotification) replyError(id, -32601, `method not found: ${String(method)}`)
    return
  }
  if (isNotification) return

  try {
    reply(id, await handler(params))
  } catch (error) {
    replyError(id, -32603, error instanceof Error ? error.message : String(error))
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')

process.stdin.on('data', (chunk) => {
  buffer += chunk
  let newlineIndex
  while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newlineIndex).trim()
    buffer = buffer.slice(newlineIndex + 1)
    if (line.length === 0) continue

    let parsed
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      process.stderr.write(`[${SERVER_NAME}] bad frame dropped: ${String(error)}\n`)
      continue
    }

    dispatch(parsed).catch((error) => {
      process.stderr.write(`[${SERVER_NAME}] dispatch failed: ${String(error)}\n`)
    })
  }
})

process.stdin.on('end', () => process.exit(0))

process.stderr.write(`[${SERVER_NAME}] ready (pid ${process.pid})\n`)
