/**
 * Shared test helpers: temp directories and a minimal MCP stdio client.
 * Everything here is offline; no test in this package spends money.
 *
 * @module tests/helpers
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Repository root. */
export const ROOT = join(HERE, '..')

/** The fake codex used by every test. */
export const FAKE_CODEX = join(HERE, 'fixtures', 'fake-codex.mjs')

/** The MCP server entry point. */
export const SERVER = join(ROOT, 'src', 'server.mjs')

/** The CLI entry point. */
export const BIN = join(ROOT, 'bin', 'codex-mcp.mjs')

/** Create a throwaway directory under the OS temp dir. */
export function tempDir(prefix = 'codex-mcp-test-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Remove a directory tree, ignoring absence. */
export function removeDir(path) {
  rmSync(path, { recursive: true, force: true })
}

/** Environment that points the package at the fake codex and a temp staging root. */
export function fakeEnv(stagingRoot, extra = {}) {
  return {
    CODEX_MCP_ENTRY: FAKE_CODEX,
    CODEX_MCP_STAGING_DIR: stagingRoot,
    ...extra,
  }
}

/**
 * Start the MCP server and speak JSON-RPC 2.0 to it over stdio.
 *
 * @returns request/notify/close handles plus captured stderr.
 */
export function startServer(env = {}, serverPath = SERVER) {
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const pending = new Map()
  const stderr = []
  let buffer = ''
  let nextId = 1

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let newlineIndex
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim()
      buffer = buffer.slice(newlineIndex + 1)
      if (line === '') continue
      const message = JSON.parse(line)
      const entry = pending.get(message.id)
      if (entry === undefined) continue
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message))
      else entry.resolve(message.result)
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => stderr.push(chunk))

  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId
      nextId += 1
      pending.set(id, { resolve, reject })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })

  const close = () =>
    new Promise((resolve) => {
      child.on('close', () => resolve())
      child.stdin.end()
      setTimeout(() => child.kill('SIGTERM'), 2_000).unref?.()
    })

  return { request, close, stderr: () => stderr.join('') }
}

/** Run the CLI to completion and capture its output. */
export function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}
