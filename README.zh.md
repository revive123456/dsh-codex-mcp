# dsh-codex-mcp

把一件事交给本机的 **Codex CLI** 去做，然后把结果干干净净地拿回来 —— 同时 Codex 碰不到你的项目文件。

## 它能做什么

- **替你跑一次 Codex 任务。** 给它一件完整的事（"帮我审这份方案""帮我审这个改动"），它去跑
  `codex exec`，再把 Codex 的答复带回来。
- **不让 Codex 碰你的文件。** Codex 只在自己的临时目录里干活。它能**读**你的项目，但只能**写**
  那个临时目录。
- **只给你一份清单，不往对话里灌正文。** 你拿到 Codex 的答复，外加它产出的文件清单：文件名、大小、
  校验值（sha256）。你按需打开、自己判断，再把认可的部分拷进项目。
- **只有一个工具。** 没有别的要学，也没有别的要配。

适合用来：审方案、审代码改动 / PR、要一个第二意见。

## 需要什么

- Node.js 22.19 以上或 24 以上
- 同一台机器上一个能正常用、已登录的 `codex` 命令

## 安装

1. 把下面这段加到 `~/.dsh/profiles/<你的 profile>/cordis.patch.yml` 的末尾，并把每个
   `/absolute/path/...` 换成你自己的真实路径：

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

2. 重启一次 DSH 应用。（实测也可以不重启：加上这段配置后，同一个会话里就能用了。）

装好后你会多出一个工具：`mcp__codex__run`。

## 怎么用

跟我说"帮我审一下这个"，我就会去调它。你可以指定的东西：

| 参数 | 必填 | 含义 |
| --- | --- | --- |
| `prompt` | 是 | 整件事写清楚。Codex 看不到我们的对话，所以要写清让它读哪些文件、把结论写到哪个文件名。 |
| `model` | 否 | 用哪个 Codex 模型，比如 `gpt-6-astra` 适合仔细审。不填就用你 Codex 自己的设置。 |
| `files` | 否 | 只报告这些文件。不填就报告这次跑出来的全部文件。 |
| `timeoutMs` | 否 | 这次最多跑多久（毫秒）。默认 15 分钟。 |

返回长这样：

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

`artifact` 就是 Codex 被允许写入的那个目录。打开它列出的文件、读完，再把认可的部分拷进你的项目。

**小提示**：在 prompt 里写清篇幅要求（例如"不超过 60 行""只列前 5 个风险"）。太长的答复会被模型
服务端截断，短而结构固定的答复才稳定。

## 命令行（可选）

同一套内核，想手动试试时用：

```sh
codex-mcp run -p "审一下 plan/foo.md，把结论写到 review.md" -m gpt-6-astra
codex-mcp runs                                  # 列出跑过的任务
codex-mcp prune --older-than-days 7 --keep 5    # 清理旧的临时目录
codex-mcp env                                   # 看看 Codex 会怎么被启动
```

## 配置（可选）

| 环境变量 | 作用 |
| --- | --- |
| `CODEX_MCP_ENTRY` | `codex` 程序的完整路径（自动找不到时用）。 |
| `CODEX_MCP_MODEL` | 调用没指定模型时的默认模型。 |
| `CODEX_MCP_TIMEOUT_MS` | 默认的单次时间上限。 |
| `CODEX_MCP_STAGING_DIR` | 临时运行目录放在哪。默认 `<你的工作区>/.codex-staging`。 |

## 安全

- Codex 能读你的项目，但只能写进这次运行的临时目录。
- Codex 执行的命令连不上网络，所以它没法把你的文件传出去。
- Codex 用它自己的登录态。这个工具不读取、不保存、也不转发你的任何密钥。
- Codex 产出的东西不会自己进你的项目 —— 拷什么由你决定。

## 开发

```sh
node --test tests/*.test.mjs
```

测试全离线：用的是假的 Codex，不调模型、不花钱。真实调用在 `scripts/live-review.mjs`（**这个花钱**）。

## License

MIT。
