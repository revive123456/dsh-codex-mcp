#!/usr/bin/env node
/**
 * Fake `codex exec` for offline tests.
 *
 * Emulates exactly the surface this package depends on: `--json` JSONL on
 * stdout, `-C <dir>` as the writable scratch, `--output-last-message <file>`,
 * the prompt arriving on stdin, and a process exit code. It never touches the
 * network and never calls a real model.
 *
 * Environment knobs:
 * - FAKE_CODEX_FILES    JSON object of {relativePath: content} to create in -C
 * - FAKE_CODEX_MESSAGE  the agent_message text (default "done")
 * - FAKE_CODEX_MODE     "ok" (default) or "fail"
 * - FAKE_CODEX_EXIT     exit code override
 * - FAKE_CODEX_SLEEP_MS delay before finishing, for timeout tests
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const argv = process.argv.slice(2)
const flagValue = (flag) => {
  const index = argv.indexOf(flag)
  return index === -1 ? undefined : argv[index + 1]
}

const workDir = flagValue('-C')
const lastMessagePath = flagValue('--output-last-message')
const prompt = readFileSync(0, 'utf8')

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`)

emit({ type: 'thread.started', thread_id: 'fake-thread-0001' })
emit({ type: 'turn.started' })

if (workDir !== undefined) {
  const files = JSON.parse(process.env.FAKE_CODEX_FILES ?? '{}')
  for (const [name, content] of Object.entries(files)) {
    const target = join(workDir, name)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  // Proof that the task arrived over stdin rather than as an argv string.
  // Skipped in "silent" mode, where the run must deliver nothing at all.
  if ((process.env.FAKE_CODEX_MODE ?? 'ok') !== 'silent') {
    writeFileSync(join(workDir, 'prompt-echo.txt'), prompt)
  }
}

const sleepMs = Number(process.env.FAKE_CODEX_SLEEP_MS ?? 0)
if (Number.isFinite(sleepMs) && sleepMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, sleepMs))
}

if ((process.env.FAKE_CODEX_MODE ?? 'ok') === 'fail') {
  emit({ type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'model metadata not found' } })
  emit({ type: 'error', message: 'model not available' })
  emit({ type: 'turn.failed', error: { message: 'model not available' } })
  process.exit(Number(process.env.FAKE_CODEX_EXIT ?? 1))
}

// "silent": a clean exit that produced no answer and no last-message file.
if (process.env.FAKE_CODEX_MODE === 'silent') {
  emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 0 } })
  process.exit(0)
}

const message = process.env.FAKE_CODEX_MESSAGE ?? 'done'
if (workDir !== undefined) emit({ type: 'item.completed', item: { id: 'item_1', type: 'reasoning', text: 'thinking' } })
emit({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: message } })
emit({ type: 'turn.completed', usage: { input_tokens: 11, cached_input_tokens: 0, output_tokens: 7 } })

if (lastMessagePath !== undefined) writeFileSync(lastMessagePath, message)
process.exit(Number(process.env.FAKE_CODEX_EXIT ?? 0))
