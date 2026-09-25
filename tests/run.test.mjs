/**
 * Tests for the codex runner: scratch isolation, artifact reporting, failure
 * surfacing and the read-back guard rails. Offline via tests/fixtures/fake-codex.mjs.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import {
  codexEnv,
  collectArtifacts,
  listRuns,
  parseCodexEvents,
  pruneRuns,
  readArtifact,
  runCodex,
} from '../src/run.mjs'
import { fakeEnv, removeDir, tempDir } from './helpers.mjs'

const scratch = tempDir()
after(() => removeDir(scratch))

describe('runCodex', () => {
  it('stages artifacts, reports hashes, and never inlines bodies', async () => {
    const stagingRoot = join(scratch, 'happy')
    const result = await runCodex({
      prompt: 'write two files',
      env: fakeEnv(stagingRoot, {
        FAKE_CODEX_FILES: JSON.stringify({ 'a.txt': 'alpha', 'nested/b.md': '# beta\n' }),
        FAKE_CODEX_MESSAGE: 'wrote a.txt and nested/b.md',
      }),
    })

    assert.equal(result.ok, true)
    assert.equal(result.exitCode, 0)
    assert.equal(result.model, null)

    const paths = result.artifacts.map((artifact) => artifact.path)
    assert.deepEqual(paths, ['a.txt', 'nested/b.md', 'prompt-echo.txt'])

    const alpha = result.artifacts.find((artifact) => artifact.path === 'a.txt')
    assert.equal(alpha.bytes, 5)
    assert.match(alpha.sha256, /^[0-9a-f]{64}$/)
    assert.equal(Object.hasOwn(alpha, 'text'), false, 'artifact descriptors must not carry content')

    // the prompt reached codex over stdin
    const echo = result.artifacts.find((artifact) => artifact.path === 'prompt-echo.txt')
    assert.equal(readFileSync(echo.absolutePath, 'utf8'), 'write two files')

    // the last message came from --output-last-message
    assert.equal(result.finalMessage, 'wrote a.txt and nested/b.md')

    // control files stay outside the artifact root
    assert.equal(result.artifactRoot, join(result.runDir, 'work'))
    assert.ok(result.manifestPath.endsWith('manifest.json'))
  })

  it('pins the sandbox to workspace-write and ignores a request to widen it', async () => {
    const stagingRoot = join(scratch, 'sandbox')
    const result = await runCodex({
      prompt: 'noop',
      // A caller cannot widen or narrow the sandbox: it is not part of the API.
      sandbox: 'danger-full-access',
      env: fakeEnv(stagingRoot, { FAKE_CODEX_FILES: '{}' }),
    })

    assert.equal(result.sandbox, 'workspace-write')
    assert.match(result.command, /-s workspace-write/)
    assert.ok(!result.command.includes('danger-full-access'))
    assert.ok(result.command.includes(`-C ${result.artifactRoot}`))
  })

  it('surfaces a failed turn instead of calling it success', async () => {
    const stagingRoot = join(scratch, 'failed')
    const result = await runCodex({
      prompt: 'noop',
      env: fakeEnv(stagingRoot, { FAKE_CODEX_MODE: 'fail', FAKE_CODEX_EXIT: '1' }),
    })

    assert.equal(result.ok, false)
    assert.equal(result.exitCode, 1)
    assert.ok(result.errors.some((error) => error.includes('model not available')))
  })

  it('times out and kills a hung codex', async () => {
    const stagingRoot = join(scratch, 'timeout')
    const result = await runCodex({
      prompt: 'noop',
      timeoutMs: 400,
      env: fakeEnv(stagingRoot, { FAKE_CODEX_SLEEP_MS: '10000' }),
    })

    assert.equal(result.timedOut, true)
    assert.equal(result.ok, false)
    assert.ok(result.durationMs < 9_000)
  })

  it('rejects an empty prompt', async () => {
    await assert.rejects(() => runCodex({ prompt: '   ' }), /prompt must be a non-empty string/)
  })

  it('reports only explicitly requested files', async () => {
    const stagingRoot = join(scratch, 'filtered')
    const result = await runCodex({
      prompt: 'noop',
      files: ['a.txt'],
      env: fakeEnv(stagingRoot, { FAKE_CODEX_FILES: JSON.stringify({ 'a.txt': 'alpha', 'b.txt': 'beta' }) }),
    })

    assert.deepEqual(result.artifacts.map((artifact) => artifact.path), ['a.txt'])
  })

  it('marks a requested file that the run never produced', async () => {
    const stagingRoot = join(scratch, 'missing')
    const result = await runCodex({
      prompt: 'noop',
      files: ['nope.txt'],
      env: fakeEnv(stagingRoot, { FAKE_CODEX_FILES: '{}' }),
    })

    assert.deepEqual(result.artifacts, [{ path: 'nope.txt', missing: true }])
  })
})

describe('readArtifact', () => {
  it('reads one artifact without leaving the run directory', async () => {
    const stagingRoot = join(scratch, 'read')
    const result = await runCodex({
      prompt: 'noop',
      env: fakeEnv(stagingRoot, { FAKE_CODEX_FILES: JSON.stringify({ 'a.txt': 'alpha' }) }),
    })

    const artifact = readArtifact(result.runId, 'a.txt', { stagingRoot })
    assert.equal(artifact.text, 'alpha')
    assert.equal(artifact.bytes, 5)
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/)
    assert.equal(artifact.truncated, false)

    assert.throws(() => readArtifact(result.runId, '../../../../etc/passwd', { stagingRoot }), /escapes the run directory/)
    assert.throws(() => readArtifact(result.runId, 'nope.txt', { stagingRoot }), /no such artifact/)
  })
})

describe('listRuns', () => {
  it('lists finished runs newest first', async () => {
    const stagingRoot = join(scratch, 'list')
    await runCodex({ prompt: 'one', runId: 'run-0001', env: fakeEnv(stagingRoot, { FAKE_CODEX_FILES: '{}' }) })
    await runCodex({ prompt: 'two', runId: 'run-0002', env: fakeEnv(stagingRoot, { FAKE_CODEX_FILES: '{}' }) })

    const runs = listRuns(stagingRoot)
    assert.deepEqual(runs.map((run) => run.runId), ['run-0002', 'run-0001'])
    assert.equal(runs[0].ok, true)
    assert.equal(runs[0].artifactCount, 1, 'the fake codex always writes prompt-echo.txt')
  })

  it('returns nothing for an unknown staging root', () => {
    assert.deepEqual(listRuns(join(scratch, 'does-not-exist')), [])
  })
})

describe('collectArtifacts', () => {
  it('does not treat a directory as an artifact', async () => {
    const stagingRoot = join(scratch, 'dirs')
    const result = await runCodex({
      prompt: 'noop',
      env: fakeEnv(stagingRoot, { FAKE_CODEX_FILES: JSON.stringify({ 'sub/deep.txt': 'x' }) }),
    })

    assert.deepEqual(collectArtifacts(result.artifactRoot).map((a) => a.path), ['prompt-echo.txt', 'sub/deep.txt'])
  })
})

describe('parseCodexEvents', () => {
  it('is tolerant of unknown events and collects the facts', () => {
    const parsed = parseCodexEvents(
      [
        '{"type":"thread.started","thread_id":"t-1"}',
        '{"type":"some.future.event","payload":{}}',
        '{"type":"item.completed","item":{"type":"reasoning","text":"hmm"}}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"final"}}',
        '{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":4}}',
        'not json at all',
        '',
      ].join('\n'),
    )

    assert.equal(parsed.threadId, 't-1')
    assert.deepEqual(parsed.agentMessages, ['final'])
    assert.deepEqual(parsed.usage, { input_tokens: 3, output_tokens: 4 })
    assert.equal(parsed.events.length, 5)
    assert.equal(parsed.errors.length, 1)
  })

  it('collects both error shapes', () => {
    const parsed = parseCodexEvents(
      [
        '{"type":"item.completed","item":{"type":"error","message":"metadata missing"}}',
        '{"type":"error","message":"model not available"}',
        '{"type":"turn.failed","error":{"message":"turn died"}}',
      ].join('\n'),
    )

    assert.deepEqual(parsed.errors, ['metadata missing', 'model not available', 'turn died'])
  })
})

// The hardening below was requested by an independent Codex review of this
// design: path escapes, symlink following, run-id traversal, credential
// inheritance, an empty "success", and unbounded staging growth.
describe('hardening', () => {
  it('refuses an artifact path that escapes the artifact root', async () => {
    const stagingRoot = join(scratch, 'escape')
    const sentinel = join(scratch, 'outside-secret.txt')
    writeFileSync(sentinel, 'do-not-hash-me')

    const result = await runCodex({
      prompt: 'noop',
      files: ['../outside-secret.txt'],
      env: fakeEnv(stagingRoot, { FAKE_CODEX_FILES: '{}' }),
    })

    const [artifact] = result.artifacts
    assert.equal(artifact.path, '../outside-secret.txt')
    assert.match(artifact.rejected, /escapes the artifact root/)
    assert.equal(artifact.sha256, undefined)
    assert.equal(artifact.absolutePath, undefined)
  })

  it('refuses to follow a symlink out of the artifact root', async () => {
    const stagingRoot = join(scratch, 'symlink')
    const result = await runCodex({
      prompt: 'noop',
      env: fakeEnv(stagingRoot, { FAKE_CODEX_FILES: '{}' }),
    })

    const sentinel = join(scratch, 'symlink-target.txt')
    writeFileSync(sentinel, 'outside')
    symlinkSync(sentinel, join(result.artifactRoot, 'leak.txt'))

    const leak = collectArtifacts(result.artifactRoot).find((artifact) => artifact.path === 'leak.txt')
    assert.equal(leak, undefined, 'symlinks are skipped by the default scan')

    const requested = collectArtifacts(result.artifactRoot, { files: ['leak.txt'] })
    assert.match(requested[0].rejected, /symbolic link/)
    assert.equal(requested[0].sha256, undefined)
  })

  it('rejects a run id that would escape or overwrite', async () => {
    const stagingRoot = join(scratch, 'runid')
    const env = fakeEnv(stagingRoot, { FAKE_CODEX_FILES: '{}' })

    await assert.rejects(() => runCodex({ prompt: 'x', runId: '../evil', env }), /no path separator/)
    await assert.rejects(() => runCodex({ prompt: 'x', runId: 'a/b', env }), /no path separator/)

    await runCodex({ prompt: 'x', runId: 'run-fixed', env })
    await assert.rejects(
      () => runCodex({ prompt: 'x', runId: 'run-fixed', env }),
      /refusing to overwrite/,
    )
  })

  it('does not hand credential-shaped variables to codex', () => {
    const env = codexEnv(
      {
        PATH: '/usr/bin',
        HOME: '/home/x',
        OPENAI_API_KEY: 'sk-secret',
        GH_TOKEN: 'ghp_secret',
        MY_PASSWORD: 'hunter2',
        AWS_SECRET_ACCESS_KEY: 'secret',
        HARMLESS: 'keep-me',
      },
      { CODEX_MCP_ENTRY: '/fake/codex.mjs' },
    )

    assert.equal(env.PATH, '/usr/bin')
    assert.equal(env.HOME, '/home/x')
    assert.equal(env.HARMLESS, 'keep-me')
    assert.equal(env.CODEX_MCP_ENTRY, '/fake/codex.mjs')
    for (const name of ['OPENAI_API_KEY', 'GH_TOKEN', 'MY_PASSWORD', 'AWS_SECRET_ACCESS_KEY']) {
      assert.equal(env[name], undefined, `${name} must not reach codex`)
    }
  })

  it('does not call a clean exit with nothing delivered a success', async () => {
    const stagingRoot = join(scratch, 'silent')
    const result = await runCodex({
      prompt: 'noop',
      env: fakeEnv(stagingRoot, { FAKE_CODEX_MODE: 'silent' }),
    })

    assert.equal(result.exitCode, 0)
    assert.equal(result.ok, false)
    assert.equal(result.terminalEvent, true)
    assert.deepEqual(result.artifacts, [])
    assert.ok(result.warnings.some((warning) => warning.includes('neither a final message nor an artifact')))
  })

  it('accepts an artifact-only run, because the file can be the whole answer', async () => {
    const stagingRoot = join(scratch, 'file-only')
    const result = await runCodex({
      prompt: 'create hello.txt',
      files: ['hello.txt'],
      env: fakeEnv(stagingRoot, {
        FAKE_CODEX_MODE: 'silent',
        FAKE_CODEX_FILES: JSON.stringify({ 'hello.txt': 'hi\n' }),
      }),
    })

    assert.equal(result.ok, true, 'measured: codex exits 0 with an empty reply when the file is the answer')
    assert.equal(result.finalMessage, '')
    assert.equal(result.artifacts.length, 1)
    assert.equal(result.artifacts[0].bytes, 3)
    assert.ok(result.warnings.some((warning) => warning.includes('no final message')))
  })

  it('prunes old runs while keeping the newest, and supports dry runs', async () => {
    const stagingRoot = join(scratch, 'prune')
    const env = fakeEnv(stagingRoot, { FAKE_CODEX_FILES: '{}' })
    for (const runId of ['run-0001', 'run-0002', 'run-0003']) {
      await runCodex({ prompt: 'x', runId, env })
    }

    const dry = pruneRuns(stagingRoot, { maxAgeMs: 0, keep: 1, dryRun: true })
    assert.deepEqual(dry, ['run-0002', 'run-0001'], 'newest first, keeping one')
    assert.equal(listRuns(stagingRoot).length, 3, 'a dry run removes nothing')

    const removed = pruneRuns(stagingRoot, { maxAgeMs: 0, keep: 1 })
    assert.deepEqual(removed, ['run-0002', 'run-0001'])
    assert.deepEqual(listRuns(stagingRoot).map((run) => run.runId), ['run-0003'])
    assert.equal(existsSync(join(stagingRoot, 'run-0001')), false)

    assert.deepEqual(pruneRuns(stagingRoot, { maxAgeMs: 7 * 24 * 60 * 60 * 1000, keep: 0 }), [], 'recent runs survive')
  })
})
