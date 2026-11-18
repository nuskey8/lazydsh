# lazydsh

[![CI](https://github.com/nuskey8/lazydsh/actions/workflows/ci.yml/badge.svg)](https://github.com/nuskey8/lazydsh/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/nuskey8/lazydsh)](https://github.com/nuskey8/lazydsh/releases/latest)
[![npm](https://img.shields.io/npm/v/lazydsh)](https://www.npmjs.com/package/lazydsh)

[English](README.md) | [日本語](README.ja.md) | 简体中文

A lazier terminal UI for DeepSeek Harness.

![demo](assets/demo.png)

## 简介

lazydsh 是一个以 [DeepSeek Harness](https://deepseek.com/en/harness/) 作为后端的 TUI 客户端。它仅包含在 TUI 中操作 DeepSeek Harness 所需的最小功能，与 [dsh-TUI](https://dshtui.com/en) 等其他 DeepSeek Harness 的 TUI 相比，运行更加轻量。

## 特性

### 轻量且高速

lazydsh 基于 [pi](https://pi.dev/) 构建。它提供了仅包含必要功能的、简单易用且高速运行的 TUI。

### 独立运行

lazydsh **不是** DSH 插件。

许多 DSH 的 TUI 客户端作为插件提供，这有时会导致与 DSH 核心版本之间的兼容性问题。

lazydsh 是一个独立的 CLI 工具，仅包含 DSH 的核心部分。它可以在 Node 上运行，而无需安装完整的 DSH 主包。

### 供应商无关

lazydsh 默认支持 pi 原生支持的所有供应商。除了 DeepSeek，您还可以连接并使用 OpenAI、Anthropic、Google、OpenCode 等任意的订阅服务。

## 安装

安装需要 Node.js 24.9.0 或更高版本。

```sh
npm install -g lazydsh
```

## 用法

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

## 命令

| 命令          | 参数               | 说明                                                   |
| ------------- | ------------------ | ------------------------------------------------------ |
| `/clear`      | —                  | 清除屏幕显示，同时保留当前会话                         |
| `/resume`     | —                  | 选择并恢复一个会话                                     |
| `/cd`         | —                  | 为会话选择工作目录                                     |
| `/permission` | `[preset]`         | 查看并选择 dsh 的权限预设                              |
| `/model`      | —                  | 选择供应商和模型                                       |
| `/login`      | `[provider]`       | 使用 OAuth 或 API 密钥登录供应商                       |
| `/logout`     | `[provider]`       | 删除已保存的供应商凭据                                 |
| `/file`       | `<path>            | clear`                                                 | 向下一条消息附加文件/图片，或取消附加 |
| `/dsh`        | `<command> [args]` | 运行原生的 dsh 命令（即使与 TUI 命令名称冲突时也可以） |
| `/effort`     | `[level            | default]`                                              | 选择当前模型的推理 effort (思考强度)  |
| `/new`        | —                  | 使用当前模型开始新的对话                               |
| `/rename`     | `[title]`          | 修改当前会话的标题                                     |
| `/fork`       | —                  | 从已完成的对话轮次中分支新会话                         |
| `/archive`    | —                  | 选择并归档会话                                         |
| `/restore`    | —                  | 恢复已归档的会话                                       |
| `/pin`        | —                  | 选择并置顶会话                                         |
| `/unpin`      | —                  | 取消会话置顶                                           |
| `/ps`         | —                  | 检查后台任务及其输出                                   |
| `/stop`       | —                  | 选择并停止后台任务                                     |
| `/session`    | —                  | 显示当前的会话 ID                                      |
| `/status`     | —                  | 显示模型、会话、使用量、账户限额以及配置信息           |
| `/compact`    | —                  | 总结会话历史以精简上下文                               |
| `/plan`       | `[off              | message]`                                              | 开始/结束 plan 模式或给出规划指令     |
| `/goal`       | `[objective        | clear                                                  | edit objective                        | pause | resume]` | 创建、查看、编辑、暂停、恢复或删除目标 |
| `/feedback`   | `<text>`           | 针对当前会话向 dsh 记录反馈                            |
| `/export`     | `[path.zip]`       | 将会话、子会话及附件导出为 ZIP 文件                    |
| `/quit`       | —                  | 退出 lazydsh                                           |

此外，如果 dsh 插件注册了自定义命令，这些命令也可以正常使用。

## 供应商

支持的供应商如下：

| 供应商名称                    | ID                              | 认证方式                    |
| ----------------------------- | ------------------------------- | --------------------------- |
| DeepSeek                      | `deepseek-official`             | API 密钥                    |
| OpenCode Go                   | `opencode-go`                   | API 密钥                    |
| OpenCode Zen                  | `opencode`                      | API 密钥                    |
| OpenAI Codex                  | `openai-codex`                  | OAuth                       |
| Amazon Bedrock                | `amazon-bedrock`                | AWS 凭证、Bearer 令牌       |
| Ant Ling                      | `ant-ling`                      | API 密钥                    |
| Anthropic                     | `anthropic`                     | API 密钥、OAuth             |
| Azure                         | `azure`                         | API 密钥                    |
| Baseten                       | `baseten`                       | API 密钥                    |
| Cerebras                      | `cerebras`                      | API 密钥                    |
| Cloudflare AI Gateway         | `cloudflare-ai-gateway`         | API 密钥                    |
| Cloudflare Workers AI         | `cloudflare-workers-ai`         | API 密钥                    |
| DeepSeek                      | `deepseek`                      | API 密钥                    |
| Fireworks                     | `fireworks`                     | API 密钥                    |
| GitHub Copilot                | `github-copilot`                | OAuth、令牌                 |
| Google                        | `google`                        | API 密钥                    |
| Google Vertex AI              | `google-vertex`                 | API 密钥、Google Cloud 凭证 |
| Groq                          | `groq`                          | API 密钥                    |
| Hugging Face                  | `huggingface`                   | API 密钥                    |
| Kimi For Coding               | `kimi-coding`                   | API 密钥、OAuth             |
| Meta                          | `meta`                          | API 密钥、OAuth             |
| MiniMax                       | `minimax`                       | API 密钥                    |
| MiniMax CN                    | `minimax-cn`                    | API 密钥                    |
| Mistral                       | `mistral`                       | API 密钥                    |
| Moonshot AI                   | `moonshotai`                    | API 密钥                    |
| Moonshot AI CN                | `moonshotai-cn`                 | API 密钥                    |
| NVIDIA                        | `nvidia`                        | API 密钥                    |
| OpenAI                        | `openai`                        | API 密钥、OAuth             |
| OpenRouter                    | `openrouter`                    | API 密钥、OAuth             |
| Qwen Token Plan               | `qwen-token-plan`               | API 密钥                    |
| Qwen Token Plan CN            | `qwen-token-plan-cn`            | API 密钥                    |
| Qwen Token Plan Individual    | `qwen-token-plan-individual`    | API 密钥                    |
| Qwen Token Plan Individual CN | `qwen-token-plan-individual-cn` | API 密钥                    |
| Radius                        | `radius`                        | API 密钥、OAuth             |
| Together                      | `together`                      | API 密钥                    |
| Vercel AI Gateway             | `vercel-ai-gateway`             | API 密钥                    |
| xAI                           | `xai`                           | API 密钥、OAuth             |
| Xiaomi                        | `xiaomi`                        | API 密钥                    |
| Xiaomi Token Plan AMS         | `xiaomi-token-plan-ams`         | API 密钥                    |
| Xiaomi Token Plan CN          | `xiaomi-token-plan-cn`          | API 密钥                    |
| Xiaomi Token Plan SGP         | `xiaomi-token-plan-sgp`         | API 密钥                    |
| Z.AI                          | `zai`                           | API 密钥                    |
| Z.AI Coding CN                | `zai-coding-cn`                 | API 密钥                    |

## 许可证

lazydsh 遵循 [MIT 许可证](LICENSE) 开源。
