/**
 * Protocol-level tests for the MCP server: handshake, tool catalogue, a real
 * tool call against the fake codex, and error shaping. Offline throughout.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fakeEnv, removeDir, startServer, tempDir } from './helpers.mjs'

const scratch = tempDir()
after(() => removeDir(scratch))

describe('codex-mcp MCP surface', () => {
  it('completes the handshake and advertises exactly one tool', async () => {
    const stagingRoot = join(scratch, 'handshake')
    const server = startServer(fakeEnv(stagingRoot))
    try {
      const init = await server.request('initialize', { protocolVersion: '2024-11-05' })
      assert.equal(init.serverInfo.name, 'codex-mcp')
      assert.equal(init.protocolVersion, '2024-11-05')
      assert.equal(init.capabilities.tools.listChanged, false)
      assert.match(init.instructions, /scratch/i)

      const { tools } = await server.request('tools/list')
      assert.equal(tools.length, 1, 'a second tool would be a permanent context tax')
      assert.equal(tools[0].name, 'run')
      assert.deepEqual(tools[0].inputSchema.required, ['prompt'])
      assert.equal(tools[0].inputSchema.additionalProperties, false)
      assert.deepEqual(Object.keys(tools[0].inputSchema.properties).sort(), [
        'files',
        'model',
        'prompt',
        'timeoutMs',
      ])

      assert.deepEqual(await server.request('ping'), {})
    } finally {
      await server.close()
    }
  })

  it('runs a task and returns paths and hashes without inlining bodies', async () => {
    const stagingRoot = join(scratch, 'call')
    const server = startServer(
      fakeEnv(stagingRoot, {
        FAKE_CODEX_FILES: JSON.stringify({ 'review.md': 'SECRET-BODY-MARKER' }),
        FAKE_CODEX_MESSAGE: 'review written',
      }),
    )
    try {
      await server.request('initialize', {})
      const result = await server.request('tools/call', {
        name: 'run',
        arguments: { prompt: 'review the plan', model: 'gpt-6-astra' },
      })

      assert.equal(result.isError, undefined)
      const text = result.content.map((part) => part.text).join('\n')
      assert.match(text, /^ok\s+exit=0/m)
      assert.match(text, /review\.md/)
      assert.match(text, /sha256:[0-9a-f]{16}/)
      assert.match(text, /model=gpt-6-astra/)
      assert.match(text, /review written/)
      assert.ok(!text.includes('SECRET-BODY-MARKER'), 'artifact bodies must never be inlined')
    } finally {
      await server.close()
    }
  })

  it('returns tool failures as readable isError results', async () => {
    const stagingRoot = join(scratch, 'errors')
    const server = startServer(fakeEnv(stagingRoot, { FAKE_CODEX_MODE: 'fail', FAKE_CODEX_EXIT: '1' }))
    try {
      await server.request('initialize', {})

      const failedRun = await server.request('tools/call', { name: 'run', arguments: { prompt: 'noop' } })
      assert.equal(failedRun.isError, undefined)
      assert.match(failedRun.content[0].text, /^FAILED/m)
      assert.match(failedRun.content[0].text, /model not available/)

      const unknown = await server.request('tools/call', { name: 'nope', arguments: {} })
      assert.equal(unknown.isError, true)
      assert.match(unknown.content[0].text, /unknown tool: nope/)

      const noPrompt = await server.request('tools/call', { name: 'run', arguments: {} })
      assert.equal(noPrompt.isError, true)
      assert.match(noPrompt.content[0].text, /prompt must be a non-empty string/)
    } finally {
      await server.close()
    }
  })

  it('reports an unknown method as a JSON-RPC error', async () => {
    const server = startServer(fakeEnv(join(scratch, 'unknown')))
    try {
      await assert.rejects(() => server.request('tools/prompts', {}), /method not found/)
    } finally {
      await server.close()
    }
  })

  it('renders a rejected artifact path instead of crashing', async () => {
    // Regression: `rejected` descriptors carry no sha256, so a renderer that
    // assumes every non-missing artifact has one throws inside the tool call.
    const stagingRoot = join(scratch, 'rejected')
    const server = startServer(fakeEnv(stagingRoot, { FAKE_CODEX_FILES: JSON.stringify({ 'ok.txt': 'fine' }) }))
    try {
      await server.request('initialize', {})
      const result = await server.request('tools/call', {
        name: 'run',
        arguments: { prompt: 'noop', files: ['../escape.txt', 'ok.txt'] },
      })

      assert.equal(result.isError, undefined)
      const text = result.content[0].text
      assert.match(text, /rejected\s+\.\.\/escape\.txt \(path escapes the artifact root\)/)
      assert.match(text, /ok\.txt/)
      assert.ok(!text.includes('undefined'), 'no field should render as undefined')
    } finally {
      await server.close()
    }
  })
})
