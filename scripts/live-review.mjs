#!/usr/bin/env node
/**
 * Live end-to-end check of the MCP server: one REAL Codex run over the stdio
 * JSON-RPC surface, exactly as the harness drives it.
 *
 * Costs money, needs network and a working Codex login, and is therefore NOT
 * part of `npm test` (which stays offline and free).
 *
 * Usage:
 *   node scripts/live-review.mjs --prompt-file plan/task.md --model gpt-6-astra [--files review.md]
 *
 * Prints the tool result and exits 0 when the run succeeded.
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = resolve(HERE, '..', 'src', 'server.mjs')

/** Read `--flag value` from argv. */
function flag(argv, name) {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

const argv = process.argv.slice(2)
const promptFile = flag(argv, '--prompt-file')
const prompt = promptFile === undefined ? flag(argv, '--prompt') : readFileSync(resolve(promptFile), 'utf8')
if (typeof prompt !== 'string' || prompt.trim() === '') {
  process.stderr.write('usage: node scripts/live-review.mjs --prompt-file FILE [--model MODEL] [--files a,b]\n')
  process.exit(2)
}
const model = flag(argv, '--model')
const files = flag(argv, '--files')?.split(',').map((entry) => entry.trim()).filter(Boolean)
const timeoutMs = Number(flag(argv, '--timeout-ms') ?? 900_000)

const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'inherit'] })
child.stdout.setEncoding('utf8')

const pending = new Map()
let buffer = ''
let nextId = 1

child.stdout.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line === '') continue
    const message = JSON.parse(line)
    const entry = pending.get(message.id)
    if (entry === undefined) continue
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(message.error.message))
    else entry.resolve(message.result)
  }
})

const request = (method, params) =>
  new Promise((resolvePromise, rejectPromise) => {
    const id = nextId
    nextId += 1
    pending.set(id, { resolve: resolvePromise, reject: rejectPromise })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })

try {
  const init = await request('initialize', { protocolVersion: '2024-11-05' })
  process.stdout.write(`server: ${init.serverInfo.name} ${init.serverInfo.version}\n`)

  const { tools } = await request('tools/list')
  process.stdout.write(`tools: ${tools.map((tool) => tool.name).join(', ')}\n\n`)

  const result = await request('tools/call', { name: 'run', arguments: { prompt, model, files, timeoutMs } })
  const text = result.content.map((part) => part.text).join('\n')
  process.stdout.write(`${text}\n`)
  process.exitCode = result.isError === true || !/^ok\b/m.test(text) ? 1 : 0
} finally {
  child.stdin.end()
  await new Promise((resolvePromise) => {
    child.on('close', resolvePromise)
    setTimeout(() => child.kill('SIGKILL'), 3_000).unref?.()
  })
}
