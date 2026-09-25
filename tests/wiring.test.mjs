/**
 * Repository hygiene and wiring tests.
 *
 * These are the "can this be published as a standalone repo" gates from the
 * workspace AGENTS.md: no machine-specific paths, no secrets, complete
 * package metadata, and a profile snippet that matches the real server path.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, it } from 'node:test'
import { ROOT } from './helpers.mjs'

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** Every file under the given directories, recursively. */
function filesUnder(...dirs) {
  const out = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name)
      if (statSync(abs).isDirectory()) walk(abs)
      else out.push(abs)
    }
  }
  for (const dir of dirs) walk(join(ROOT, dir))
  return out
}

describe('repository hygiene', () => {
  it('declares the metadata a publishable package needs', () => {
    assert.equal(pkg.name, 'dsh-codex-mcp')
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
    assert.equal(pkg.license, 'MIT')
    assert.match(pkg.engines.node, /\^22\.19|>=24/)
    assert.ok(Array.isArray(pkg.files) && pkg.files.includes('src') && pkg.files.includes('bin'))
    assert.equal(pkg.exports['./server'], './src/server.mjs')
    assert.equal(pkg.exports['./cli'], './src/cli.mjs')
    assert.equal(pkg.bin['codex-mcp'], 'bin/codex-mcp.mjs')
    assert.ok(existsSync(join(ROOT, 'LICENSE')))
    assert.match(readFileSync(join(ROOT, 'LICENSE'), 'utf8'), /^MIT License/)
  })

  it('keeps machine-specific absolute paths out of the sources and tests', () => {
    // Assembled at runtime so this file itself can be scanned with the rest.
    const forbiddenPaths = [
      new RegExp('/Use' + 'rs/'),
      new RegExp('ds_' + 'workspace'),
      new RegExp('/usr/local' + '/bin'),
    ]
    const scanned = filesUnder('src', 'bin', 'tests')
    assert.ok(scanned.length >= 8, 'expected to scan the sources, the CLI and the other tests')
    for (const file of scanned) {
      const text = readFileSync(file, 'utf8')
      for (const pattern of forbiddenPaths) {
        assert.ok(!pattern.test(text), `${relative(ROOT, file)} matches forbidden pattern ${pattern}`)
      }
    }
  })

  it('keeps secret literals out of the shipped sources', () => {
    // Tests are not published (`files` in package.json omits them) and use
    // obviously fake values, so the literal-secret check covers src and bin only.
    const secretLiteral = /(?:api[_-]?key|password|secret|token)\s*[:=]\s*['"][^'"]{4,}/i
    for (const file of filesUnder('src', 'bin')) {
      const text = readFileSync(file, 'utf8')
      assert.ok(!secretLiteral.test(text), `${relative(ROOT, file)} looks like it embeds a credential`)
    }
  })

  it('does not let importing the package start the MCP server', () => {
    const index = readFileSync(join(ROOT, 'src', 'index.mjs'), 'utf8')
    assert.ok(!/from '\.\/server\.mjs'/.test(index), 'index.mjs must not re-export the server module')
    assert.match(index, /deliberately NOT re-exported/)
  })

  it('ships a profile snippet that points at the real server entry', () => {
    const snippetPath = join(ROOT, 'cordis.patch.yml')
    assert.ok(existsSync(snippetPath), 'cordis.patch.yml must exist')
    const snippet = readFileSync(snippetPath, 'utf8')

    assert.match(snippet, /@deepseek-ai\/dsh-mcp-client/)
    assert.match(snippet, /serverName:\s*codex\b/)
    assert.match(snippet, /src\/server\.mjs/)
    assert.match(snippet, /transport:\s*stdio/)
    assert.ok(!/\/Use[' + ']rs\//.test(snippet), 'the snippet must not hard-code a user home')
    assert.ok(existsSync(join(ROOT, 'src', 'server.mjs')))
  })

  it('documents the restart requirement and the artifact-handling rule', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
    assert.match(readme, /restart/i)
    assert.match(readme, /restart/i)
    assert.match(readme, /sha256/)
  })

  it('ignores the local staging area', () => {
    assert.match(readFileSync(join(ROOT, '.gitignore'), 'utf8'), /\.codex-staging\//)
  })
})
