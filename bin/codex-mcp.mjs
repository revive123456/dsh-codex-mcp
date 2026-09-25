#!/usr/bin/env node
/** Executable entry point for the codex-mcp CLI. */
import { main } from '../src/cli.mjs'

process.exitCode = await main(process.argv.slice(2))
