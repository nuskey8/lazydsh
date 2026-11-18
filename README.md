# lazydsh

[![CI](https://github.com/nuskey8/lazydsh/actions/workflows/ci.yml/badge.svg)](https://github.com/nuskey8/lazydsh/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/nuskey8/lazydsh)](https://github.com/nuskey8/lazydsh/releases/latest)
[![npm](https://img.shields.io/npm/v/lazydsh)](https://www.npmjs.com/package/lazydsh)

English | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

A lazier terminal UI for DeepSeek Harness.

![demo](assets/demo.png)

## Overview

lazydsh is a TUI harness powered by [DeepSeek Harness](https://deepseek.com/en/harness/) as its backend. It contains only the essential features required to handle DeepSeek Harness in a TUI, making it lightweight compared to other DSH TUI clients such as [dsh-TUI](https://dshtui.com/en).

## Features

### Lightweight & Fast

lazydsh is built on top of [pi](https://pi.dev/). It provides a simple, user-friendly, and high-performance TUI with only the necessary features.

### Standalone

lazydsh is **NOT** a DSH plugin.

Many DSH TUI clients are provided as plugins, which can lead to version compatibility issues with the core DSH installation.

lazydsh is an independent CLI tool containing only the core parts of DSH. It can run on Node without requiring the full DSH main package.

### Provider Independent

lazydsh supports all providers natively supported by pi out-of-the-box. You can connect and use subscriptions from OpenAI, Anthropic, Google, OpenCode, and others, in addition to DeepSeek.

## Installation

Node.js 24.9.0 or higher is required.

```sh
npm install -g lazydsh
```

## Usage

```sh
lazydsh — A lazier terminal UI for DeepSeek Harness.

Usage:
  lazydsh [flags]
  lazydsh <command> [arguments] [flags]
  echo "prompt" | lazydsh ask [flags]

Commands:
  ask [prompt]            Run one noninteractive request
  resume [session-id]     Continue a saved conversation
  login [provider]        Log in with OAuth or an API key
  logout [provider]       Remove saved provider credentials
  upgrade                 Update lazydsh to the latest version

Flags:
  --provider <id>         Provider (default: last used, then deepseek-official)
  --model <id>            Model (default: last used or provider default)
  --effort <level>        Initial reasoning effort
  --permission <preset>   Permission preset for ask (default: dsh policy)
  --cwd <path>            Working directory (default: current directory)
  --home <path>           DSH home directory
  --resume <id>           Continue a saved conversation
  --patch <path>          Additional dsh Cordis patch (repeatable)
  --list                  List providers and model IDs
  -h, --help              Show help

```

## Commands

| Command       | Arguments          | Description                                                            |
| ------------- | ------------------ | ---------------------------------------------------------------------- |
| `/clear`      | —                  | Clear the terminal and start a new conversation                        |
| `/resume`     | —                  | Select and resume a session                                            |
| `/cd`         | —                  | Choose the working directory for the session                           |
| `/permission` | `[preset]`         | View and select dsh permission presets                                 |
| `/model`      | —                  | Select provider and model                                              |
| `/login`      | `[provider]`       | Log in to a provider with OAuth or an API key                          |
| `/logout`     | `[provider]`       | Remove saved provider credentials                                      |
| `/file`       | `<path>            | clear`                                                                 | Attach a file/image to the next message or clear attachments |
| `/dsh`        | `<command> [args]` | Run native dsh commands (even if they conflict with TUI command names) |
| `/effort`     | `[level            | default]`                                                              | Select the reasoning effort for the current model            |
| `/new`        | —                  | Start a new conversation while keeping the current display             |
| `/rename`     | `[title]`          | Rename the current session title                                       |
| `/fork`       | —                  | Fork the session from a completed turn                                 |
| `/archive`    | —                  | Select and archive a session                                           |
| `/restore`    | —                  | Restore an archived session                                            |
| `/pin`        | —                  | Select and pin a session                                               |
| `/unpin`      | —                  | Unpin a session                                                        |
| `/ps`         | —                  | Check background jobs and their outputs                                |
| `/stop`       | —                  | Select a background job to stop                                        |
| `/session`    | —                  | Show the current session ID                                            |
| `/status`     | —                  | Display model, session, usage, account limits, and configuration       |
| `/compact`    | —                  | Summarize session history to clean up context                          |
| `/plan`       | `[off              | message]`                                                              | Start/end plan mode or give planning instructions            |
| `/goal`       | `[objective        | clear                                                                  | edit objective                                               | pause | resume]` | Create, view, edit, pause, resume, or delete goals |
| `/feedback`   | `<text>`           | Record feedback for dsh regarding the current session                  |
| `/export`     | `[path.zip]`       | Export sessions, child sessions, and attachments to a ZIP file         |
| `/quit`       | —                  | Exit lazydsh                                                           |

Additionally, any custom commands registered by dsh plugins are also available.

## Providers

Supported providers are as follows:

| Provider Name                 | ID                              | Authentication Method             |
| ----------------------------- | ------------------------------- | --------------------------------- |
| DeepSeek                      | `deepseek-official`             | API Key                           |
| OpenCode Go                   | `opencode-go`                   | API Key                           |
| OpenCode Zen                  | `opencode`                      | API Key                           |
| OpenAI Codex                  | `openai-codex`                  | OAuth                             |
| Amazon Bedrock                | `amazon-bedrock`                | AWS Credentials, Bearer Token     |
| Ant Ling                      | `ant-ling`                      | API Key                           |
| Anthropic                     | `anthropic`                     | API Key, OAuth                    |
| Azure                         | `azure`                         | API Key                           |
| Baseten                       | `baseten`                       | API Key                           |
| Cerebras                      | `cerebras`                      | API Key                           |
| Cloudflare AI Gateway         | `cloudflare-ai-gateway`         | API Key                           |
| Cloudflare Workers AI         | `cloudflare-workers-ai`         | API Key                           |
| DeepSeek                      | `deepseek`                      | API Key                           |
| Fireworks                     | `fireworks`                     | API Key                           |
| GitHub Copilot                | `github-copilot`                | OAuth, Token                      |
| Google                        | `google`                        | API Key                           |
| Google Vertex AI              | `google-vertex`                 | API Key, Google Cloud Credentials |
| Groq                          | `groq`                          | API Key                           |
| Hugging Face                  | `huggingface`                   | API Key                           |
| Kimi For Coding               | `kimi-coding`                   | API Key, OAuth                    |
| Meta                          | `meta`                          | API Key, OAuth                    |
| MiniMax                       | `minimax`                       | API Key                           |
| MiniMax CN                    | `minimax-cn`                    | API Key                           |
| Mistral                       | `mistral`                       | API Key                           |
| Moonshot AI                   | `moonshotai`                    | API Key                           |
| Moonshot AI CN                | `moonshotai-cn`                 | API Key                           |
| NVIDIA                        | `nvidia`                        | API Key                           |
| OpenAI                        | `openai`                        | API Key, OAuth                    |
| OpenRouter                    | `openrouter`                    | API Key, OAuth                    |
| Qwen Token Plan               | `qwen-token-plan`               | API Key                           |
| Qwen Token Plan CN            | `qwen-token-plan-cn`            | API Key                           |
| Qwen Token Plan Individual    | `qwen-token-plan-individual`    | API Key                           |
| Qwen Token Plan Individual CN | `qwen-token-plan-individual-cn` | API Key                           |
| Radius                        | `radius`                        | API Key, OAuth                    |
| Together                      | `together`                      | API Key                           |
| Vercel AI Gateway             | `vercel-ai-gateway`             | API Key                           |
| xAI                           | `xai`                           | API Key, OAuth                    |
| Xiaomi                        | `xiaomi`                        | API Key                           |
| Xiaomi Token Plan AMS         | `xiaomi-token-plan-ams`         | API Key                           |
| Xiaomi Token Plan CN          | `xiaomi-token-plan-cn`          | API Key                           |
| Xiaomi Token Plan SGP         | `xiaomi-token-plan-sgp`         | API Key                           |
| Z.AI                          | `zai`                           | API Key                           |
| Z.AI Coding CN                | `zai-coding-cn`                 | API Key                           |

## License

lazydsh is open-sourced under the [MIT License](LICENSE).
