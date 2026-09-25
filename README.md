# dsh-codex-mcp

An MCP server that runs the locally installed **Codex CLI** (`codex exec`) inside an
isolated scratch directory and hands the result back to the agent as **paths, sizes and
sha256 hashes — never as inlined file bodies**. Zero dependencies, offline test suite.

## Why it exists

Two facts about `codex exec` shape this design:

1. **It defaults to Codex's read-only sandbox.** A wrapper that passes no sandbox flag gets
   a Codex that cannot write a single file, so the only channel back is the final message
   text — which means large artifacts get truncated or paraphrased.
2. **The caller decides what reaches the workspace.** Codex can *read* the workspace, but
   it must not *write* it. Artifacts land in a staging directory, the agent reviews them,
   and only then does anything get copied into a real destination.

Measured on macOS with `-s workspace-write -C <staging>/<runId>/work`:

| Probe | Result |
| --- | --- |
| Codex writes a file in its own working directory | allowed |
| Codex writes a file in the enclosing workspace | denied: `zsh:1: operation not permitted` |

## Install

Add the row in [`cordis.patch.yml`](cordis.patch.yml) to your profile patch layer,
replacing the `/absolute/path/...` placeholders:

`~/.dsh/profiles/<name>/cordis.patch.yml`

```yaml
- insert:
    - id: mcp-codex
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: codex
        command: /absolute/path/to/node
        args:
          - /absolute/path/to/dsh-codex-mcp/src/server.mjs
        cwd: /absolute/path/to/your/workspace
        toolCallTimeoutMs: 900000
        failOnStartupError: true
```

**No restart needed in practice.** Measured 2026-09-25: appending this row to the `desktop`
profile's patch layer made `mcp__codex__run` available **in the same session**, even though
only the `web` profile declares `patchReload: live`. Bundle membership changes
(`dsh plugin add/remove`) are the real startup boundary. If the tool does not appear, read the
server's stderr — never patch the DSH source; this integration is user-directory only.

The tool then appears as `mcp__codex__run`.

## Tool surface

One tool, on purpose: every tool schema is a permanent context tax.

### `mcp__codex__run`

| Argument | Required | Meaning |
| --- | --- | --- |
| `prompt` | yes | The complete, self-contained task. Codex does not see your conversation. |
| `model` | no | Codex model id for this call, e.g. `gpt-6-astra` for plan review. Defaults to `$CODEX_MCP_MODEL`, else Codex's own configuration. |
| `files` | no | Explicit artifact paths (relative to the artifact root) to report. Defaults to every file the run created. |
| `timeoutMs` | no | Deadline for the whole run. Defaults to `$CODEX_MCP_TIMEOUT_MS`, else `900000`. |

The result reports `ok`, exit code, duration, thread id, token usage, Codex's final
message, and the artifact list:

```
ok  exit=0  41.2s  model=gpt-6-astra
run        run-20260925-173301-a1b2
artifact   /path/to/workspace/.codex-staging/run-20260925-173301-a1b2/work
manifest   /path/to/workspace/.codex-staging/run-20260925-173301-a1b2/manifest.json
usage      input=18856 cached=0 output=2048

final message
-------------
review written to review.md

artifacts (1) — bodies are NOT included, read them yourself
-------------
    3412 B  sha256:1a2b3c4d5e6f7a8b  review.md
```

Read `review.md`, decide, then copy what you approve. Bodies are never inlined, so a large
artifact costs nothing until you actually read it.

## CLI

The CLI shares every module with the server and carries the diagnostics that are kept out
of the MCP surface:

```sh
codex-mcp env                              # how Codex will be launched, staging root, defaults
codex-mcp run -p "TASK" -m gpt-6-astra     # one run, text manifest
codex-mcp run --prompt-file task.md --json # one run, JSON manifest
codex-mcp runs --limit 5                   # finished runs under the staging root
codex-mcp prune --older-than-days 7 --keep 5   # delete old staged runs (--dry-run reports only)
codex-mcp serve                            # the MCP server on stdio
```

`codex-mcp run` exits `0` on success, `1` on a failed run, `2` on a usage error.

## Configuration

All optional; every default is portable.

| Variable | Effect |
| --- | --- |
| `CODEX_MCP_ENTRY` | Absolute path to the Codex entry point. Overrides discovery. |
| `CODEX_MCP_MODEL` | Default model id when a call passes none. |
| `CODEX_MCP_TIMEOUT_MS` | Default per-run deadline. |
| `CODEX_MCP_STAGING_DIR` | Staging root. Default `<cwd>/.codex-staging`. |

Entry-point discovery order: `CODEX_MCP_ENTRY` → `~/.local/bin/codex-desktop` (a wrapper
that pins the interpreter) → `~/.npm-global/lib/node_modules/@openai/codex/bin/codex.js` →
`codex` on `PATH`. Script entries are always spawned with the current node binary, so a
`#!/usr/bin/env node` shim never fails with `env: node: No such file or directory`.

## Security model

- `-s workspace-write` is **not** a tool parameter. A caller cannot widen or narrow the
  sandbox; the server always passes `workspace-write`.
- `-C` points at `<staging>/<runId>/work`, so Codex's writable root is the scratch
  directory. The workspace itself stays read-only to Codex (verified above).
- Sandboxed shell commands have **no network by default** (measured: `curl` returned
  `http_code 000`, exit 7), so a prompt-injected command cannot exfiltrate file contents.
- Artifact paths are resolved **inside** the artifact root: a path that escapes it, or a
  symbolic link, is reported as `rejected` — never read and never hashed.
- Run ids are format-checked, cannot escape the staging root, and an existing run directory
  is never overwritten.
- Credential-shaped environment variables (`/KEY|PASSWORD|SECRET|TOKEN/i`) are not inherited
  by Codex. Per-call `env` overrides are taken as explicit and trusted.
- A timeout kills the whole process group on POSIX, not just the direct child.
- `ok` means: exit 0, no error event, no timeout, **and something delivered** — a final
  message or at least one artifact. Codex legitimately exits 0 with an empty reply when the
  file *is* the answer, so an artifact-only run counts; a clean exit with neither does not.
  `terminalEvent` and `warnings` are reported separately instead of being folded into `ok`.
- The staging root is a staging area, not a destination: `.codex-staging/` is gitignored and
  `codex-mcp prune` clears it (default: keep runs newer than 7 days and the newest N runs).
- No API key or credential is read, stored or forwarded by this server. Codex uses its own
  authentication.

## Tests

```sh
node --test tests/*.test.mjs
```

39 offline tests: a fake `codex exec` fixture emulates the JSONL stream, writes scratch
files, and can fail, stay silent or hang on demand — plus explicit coverage for path
escapes, symlinks, run-id traversal, credential inheritance, deliverable semantics,
rejected-artifact rendering and pruning. No network call, no model spend. The live path is
covered separately by `scripts/live-review.mjs`, which does spend money.

## License

MIT.
