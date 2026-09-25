/**
 * CLI tests: the human-facing surface and the diagnostics that are deliberately
 * kept out of the MCP tool schema. Offline via the fake codex.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { fakeEnv, removeDir, runCli, tempDir } from './helpers.mjs'

const scratch = tempDir()
after(() => removeDir(scratch))

describe('codex-mcp CLI', () => {
  it('prints usage and exits 0 for help', async () => {
    const { code, stdout } = await runCli(['--help'])
    assert.equal(code, 0)
    assert.match(stdout, /Usage:/)
    assert.match(stdout, /workspace-write/)
  })

  it('exits 2 for an unknown command', async () => {
    const { code, stderr } = await runCli(['frobnicate'])
    assert.equal(code, 2)
    assert.match(stderr, /unknown command: frobnicate/)
  })

  it('reports how codex will be launched', async () => {
    const { code, stdout } = await runCli(['env'], fakeEnv(join(scratch, 'env')))
    assert.equal(code, 0)
    assert.match(stdout, /source\s+CODEX_MCP_ENTRY/)
    assert.match(stdout, /staging\s+/)
  })

  it('runs a task, prints the manifest, and never prints bodies', async () => {
    const stagingRoot = join(scratch, 'run')
    const env = fakeEnv(stagingRoot, {
      FAKE_CODEX_FILES: JSON.stringify({ 'a.txt': 'SECRET-BODY-MARKER' }),
      FAKE_CODEX_MESSAGE: 'all done',
    })

    const text = await runCli(['run', '-p', 'do the thing', '-m', 'gpt-6-astra'], env)
    assert.equal(text.code, 0)
    assert.match(text.stdout, /^ok\s+exit=0/m)
    assert.match(text.stdout, /all done/)
    assert.match(text.stdout, /a\.txt/)
    assert.ok(!text.stdout.includes('SECRET-BODY-MARKER'))

    const json = await runCli(['run', '--prompt', 'again', '--json'], env)
    assert.equal(json.code, 0)
    const manifest = JSON.parse(json.stdout)
    assert.equal(manifest.ok, true)
    assert.equal(manifest.sandbox, 'workspace-write')
    assert.equal(manifest.artifacts.length, 2)

    const runs = await runCli(['runs', '--staging-root', stagingRoot], env)
    assert.equal(runs.code, 0)
    assert.match(runs.stdout, /^ok\s+run-/m)
  })

  it('exits 1 when the run fails', async () => {
    const stagingRoot = join(scratch, 'cli-fail')
    const env = fakeEnv(stagingRoot, { FAKE_CODEX_MODE: 'fail', FAKE_CODEX_EXIT: '1' })
    const { code, stdout } = await runCli(['run', '-p', 'noop'], env)
    assert.equal(code, 1)
    assert.match(stdout, /^FAILED/m)
  })

  it('requires a prompt', async () => {
    const { code, stderr } = await runCli(['run'], fakeEnv(join(scratch, 'noprompt')))
    assert.equal(code, 1)
    assert.match(stderr, /a prompt is required/)
  })

  it('prunes staged runs and accepts a zero boundary', async () => {
    const stagingRoot = join(scratch, 'prune-cli')
    const env = fakeEnv(stagingRoot, { FAKE_CODEX_FILES: '{}' })
    await runCli(['run', '-p', 'one'], env)
    await runCli(['run', '-p', 'two'], env)

    const boundaries = ['--staging-root', stagingRoot, '--older-than-days', '0', '--keep', '1']
    const dry = await runCli(['prune', ...boundaries, '--dry-run'], env)
    assert.equal(dry.code, 0)
    assert.match(dry.stdout, /^would remove run-/m)

    const real = await runCli(['prune', ...boundaries], env)
    assert.equal(real.code, 0)
    assert.match(real.stdout, /^removed run-/m)

    const remaining = await runCli(['runs', '--staging-root', stagingRoot], env)
    assert.equal(remaining.stdout.trim().split('\n').length, 1, 'keep=1 leaves exactly one run')
  })
})
