# dsh-codex-mcp

Hand a job to the **Codex CLI** on your machine and get the result back in a form you can
review — without giving Codex write access to your project.

## What it does

- **Runs one Codex task.** Give it a complete job — "review this plan", "review this patch" —
  and it runs `codex exec` and brings back Codex's answer.
- **Keeps Codex away from your files.** Codex works in its own temporary folder. It can read
  your project, but it can only write inside that folder.
- **Hands you a list, not a wall of text.** You get Codex's answer plus a list of the files it
  produced, with their size and a sha256 checksum. You open what you need, decide, and copy in
  only what you approve.
- **One tool, one job.** Nothing else to learn or configure.

Typical uses: reviewing a plan, reviewing a patch or a pull request, getting a second opinion.

## Requirements

- Node.js 22.19+ or 24+
- A working `codex` CLI on the same machine, already logged in

## Install

1. Add this block to the end of `~/.dsh/profiles/<your-profile>/cordis.patch.yml`, replacing
   every `/absolute/path/...` with a real path:

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

2. Restart the DSH app once. (In practice it also works without a restart — when we tested it,
   the new row was live in the same session.)

You now have one new tool: `mcp__codex__run`.

## Usage

Ask your agent for a review and it calls the tool for you. The arguments:

| Argument | Required | What it means |
| --- | --- | --- |
| `prompt` | yes | The whole job, written out. Codex cannot see your chat, so include the paths it should read and the file name it should write. |
| `model` | no | Which Codex model to use, for example `gpt-6-astra` for careful reviews. Defaults to your Codex setting. |
| `files` | no | Report only these files. Defaults to everything the run created. |
| `timeoutMs` | no | How long the run may take, in milliseconds. Default: 15 minutes. |

What comes back looks like this:

```
ok  exit=0  140.1s  model=gpt-6-astra  terminal=yes
run        run-20260925-181307-9c44
artifact   /path/to/your/workspace/.codex-staging/run-20260925-181307-9c44/work
manifest   /path/to/your/workspace/.codex-staging/run-20260925-181307-9c44/manifest.json
final message
-------------
review written to review.md
artifacts (1) — bodies are NOT included, read them yourself
-------------
    2500 B  sha256:6676042702213315  review.md
```

`artifact` is the folder Codex was allowed to write. Open the files listed under it, read them,
then copy the parts you agree with into your project.

**Tip:** put a size limit in your prompt ("at most 60 lines", "top 5 risks only"). Long answers
can be cut off by the model provider; short, structured ones come back reliably.

## Command line (optional)

The same engine, handy for trying things by hand:

```sh
codex-mcp run -p "Review the plan at plan/foo.md and write review.md" -m gpt-6-astra
codex-mcp runs                                  # list finished runs
codex-mcp prune --older-than-days 7 --keep 5    # clear old temporary runs
codex-mcp env                                   # show how Codex will be started
```

## Settings (optional)

| Variable | What it does |
| --- | --- |
| `CODEX_MCP_ENTRY` | Full path to the `codex` program, if it is not found automatically. |
| `CODEX_MCP_MODEL` | Default model when a call does not name one. |
| `CODEX_MCP_TIMEOUT_MS` | Default time limit for a run. |
| `CODEX_MCP_STAGING_DIR` | Where temporary run folders go. Default: `<your-workspace>/.codex-staging`. |

## Safety

- Codex can read your project, but it can only write inside the temporary folder for that run.
- Commands Codex runs cannot reach the network, so it cannot upload your files.
- Codex uses its own login. This tool never reads, stores or forwards your keys.
- Nothing Codex produces enters your project by itself — you decide what to copy.

## Development

```sh
node --test tests/*.test.mjs
```

The tests are offline: they use a fake Codex, so they never call a model and cost nothing.
For a real run there is `scripts/live-review.mjs` — that one does cost money.

## License

MIT.
