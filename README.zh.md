# dsh-codex-mcp

把本机安装的 **Codex CLI**（`codex exec`）包成一个 MCP server：每次运行都在**隔离草稿区**里干活，
结果以**路径 + 字节数 + sha256**的形式回传 —— **从不内联文件正文**。零依赖，测试全离线。

## 为什么这么设计

`codex exec` 有两个必须正视的事实：

1. **它默认跑在只读沙箱里。** 不显式传沙箱参数的封装会得到一个「连一个文件都写不出来」的 Codex，
   唯一回传通道只剩最终答复文本 —— 大文件要么被截断，要么被改写走样。
2. **产物是否入仓必须由调用者决定。** Codex 可以**读**工作区，但不该**写**工作区：产物先落到暂存区，
   由 agent 审核后，才把批准的部分拷进正式位置。

在 macOS 上实测（`-s workspace-write -C <staging>/<runId>/work`）：

| 探针 | 结果 |
| --- | --- |
| Codex 写自己的工作目录 | 允许 |
| Codex 写外层工作区 | 拒绝：`zsh:1: operation not permitted` |

## 安装

把 [`cordis.patch.yml`](cordis.patch.yml) 里的 row 追加进 profile 的 patch 层，
并把 `/absolute/path/...` 换成真实绝对路径：

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

**实测无需重启。** 2026-09-25 实测：把这段 row 追加进 `desktop` profile 的 patch 层后，
`mcp__codex__run` **在同一会话内**就可用 —— 尽管只有 `web` profile 声明了 `patchReload: live`。
真正的启动边界是 bundle membership（`dsh plugin add/remove`）。
若工具没出现，先看 server 的 stderr —— **绝不要去改 DSH 源码**；本集成只动用户目录。

接好后工具名是 `mcp__codex__run`。

## 工具面

**只有一个工具**，这是刻意的：每个工具 schema 都是每轮固定的上下文税。

### `mcp__codex__run`

| 参数 | 必填 | 含义 |
| --- | --- | --- |
| `prompt` | 是 | 完整、自包含的任务描述。Codex **看不到**当前对话。 |
| `model` | 否 | 本次使用的 Codex 模型，如方案审核用 `gpt-6-astra`。默认取 `$CODEX_MCP_MODEL`，再退回 Codex 自身配置。 |
| `files` | 否 | 只报告这些产物路径（相对产物根目录）。默认报告本次新建的全部文件。 |
| `timeoutMs` | 否 | 整次运行的截止时间。默认 `$CODEX_MCP_TIMEOUT_MS`，再退回 `900000`。 |

返回内容含 `ok`、退出码、耗时、thread id、token 用量、Codex 最终答复，以及产物清单：

```
ok  exit=0  41.2s  model=gpt-6-astra
run        run-20260925-173301-a1b2
artifact   /path/to/workspace/.codex-staging/run-20260925-173301-a1b2/work
manifest   /path/to/workspace/.codex-staging/run-20260925-173301-a1b2/manifest.json

artifacts (1) — bodies are NOT included, read them yourself
-------------
    3412 B  sha256:1a2b3c4d5e6f7a8b  review.md
```

自己去读 `review.md`，判断后再拷贝。正文不进上下文，所以大产物在你不读它之前**一分钱上下文都不花**。

## CLI

CLI 与 server 共用全部模块，并承载那些**刻意不进 MCP 工具面**的诊断能力：

```sh
codex-mcp env                              # Codex 会怎么被启动、暂存区、默认值
codex-mcp run -p "TASK" -m gpt-6-astra     # 跑一次，文本清单
codex-mcp run --prompt-file task.md --json # 跑一次，JSON 清单
codex-mcp runs --limit 5                   # 列出已完成的 run
codex-mcp prune --older-than-days 7 --keep 5   # 清理旧暂存 run（--dry-run 只报告）
codex-mcp serve                            # 在 stdio 上跑 MCP server
```

退出码：`0` 成功，`1` 运行失败，`2` 用法错误。

## 配置

全部可选，默认值都可移植。

| 变量 | 作用 |
| --- | --- |
| `CODEX_MCP_ENTRY` | Codex 入口的绝对路径，覆盖自动发现。 |
| `CODEX_MCP_MODEL` | 调用未指定模型时的默认模型。 |
| `CODEX_MCP_TIMEOUT_MS` | 默认单次运行截止时间。 |
| `CODEX_MCP_STAGING_DIR` | 暂存根目录，默认 `<cwd>/.codex-staging`。 |

入口发现顺序：`CODEX_MCP_ENTRY` → `~/.local/bin/codex-desktop`（钉死解释器的 wrapper）→
`~/.npm-global/lib/node_modules/@openai/codex/bin/codex.js` → `PATH` 上的 `codex`。
脚本型入口一律用当前 node 二进制启动，所以 `#!/usr/bin/env node` 的 shim 不会出现
`env: node: No such file or directory`。

## 安全模型

- `-s workspace-write` **不是**工具参数：调用者既不能放宽也不能收紧沙箱。
- `-C` 指向 `<staging>/<runId>/work`，所以 Codex 的可写根就是草稿区；工作区对 Codex 始终只读（上面已实测）。
- 沙箱内的 shell 命令**默认没有网络**（实测 `curl` 返回 `http_code 000`、exit 7），提示注入也无法外传文件内容。
- 产物路径必须在产物根**之内**：越界路径与符号链接一律标 `rejected`，**不读、不哈希**。
- `runId` 有格式校验，不能穿越暂存根；已存在的 run 目录**绝不覆盖**。
- 形如 `/KEY|PASSWORD|SECRET|TOKEN/i` 的环境变量**不会**被 Codex 继承；单次 `env` 覆盖视为显式可信。
- 超时在 POSIX 下杀**整个进程组**，不只杀直接子进程。
- `ok` 的含义：exit 0 + 无 error 事件 + 未超时 + **有交付**（有最终答复，或有至少一个产物）。
  实测发现 Codex 在「文件本身就是答案」时会 exit 0 但答复为空，所以只有产物也算成功；两者皆无才算失败。
  `terminalEvent` 与 `warnings` 单独输出，不塞进 `ok`。
- 暂存区不是目的地：`.codex-staging/` 已 gitignore，`codex-mcp prune` 负责清理（默认保留 7 天内、且保底保留最新 N 条）。
- 本 server 不读取、不存储、不转发任何 API Key；Codex 用它自己的登录态。

## 测试

```sh
node --test tests/*.test.mjs
```

39 项离线测试：fake `codex exec` 模拟 JSONL 事件流、写草稿文件，并可按需失败/沉默/挂死；
另含路径越界、符号链接、runId 穿越、凭据继承、交付语义、`rejected` 渲染、清理策略的专门覆盖。
不联网、不花钱。真实链路另由 `scripts/live-review.mjs` 覆盖（**花钱**）。

## License

MIT。
