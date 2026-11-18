# lazydsh

[![CI](https://github.com/nuskey8/lazydsh/actions/workflows/ci.yml/badge.svg)](https://github.com/nuskey8/lazydsh/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/nuskey8/lazydsh)](https://github.com/nuskey8/lazydsh/releases/latest)
[![npm](https://img.shields.io/npm/v/lazydsh)](https://www.npmjs.com/package/lazydsh)

[English](README.md) | [简体中文](README.zh-CN.md) | 日本語

A lazier terminal UI for DeepSeek Harness.

![demo](assets/demo.png)

## 概要

lazydshは[DeepSeek Harness](https://deepseek.com/en/harness/)をバックエンドに動作するTUIハーネスです。DeepSeek HarnessをTUIで扱うための最小限の機能のみを有し、[dsh-TUI](https://dshtui.com/en)などの他のDeepSeek Harness用TUIと比較して軽量に動作するようになっています。

## 特徴

### 軽量・高速

lazydshは[pi](https://pi.dev/)をベースに構築されています。必要十分な機能のみを搭載し、シンプルで扱いやすく、高速に動作するTUIを提供します。

### スタンドアローン

lazydshはDSHのプラグイン**ではありません。**

多くのDSH向けTUIはプラグインとして提供されていますが、これはDSH本体とのバージョン間の互換性で問題になることがあります。

lazydshはDSHのコア部分のみを含む独立したCLIツールです。DSH本体を必要とすることなく、Node上で動作させることができます。

### プロバイダ非依存

lazydshはデフォルトでpiがサポートする全てのプロバイダに対応しています。DeepSeekだけでなく、OpenAIやAnthropic、Google、OpenCodeなどの任意のサブスクリプションを接続して利用することが可能です。

## インストール

インストールにはNode 24.9.0以上が必要です。

```sh
npm install -g lazydsh
```

## 使い方

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

## コマンド

| コマンド      | 引数                                                        | 説明                                                               |
| ------------- | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| `/clear`      | —                                                           | セッションを維持したまま表示を消去                                 |
| `/resume`     | —                                                           | セッションを選択して再開                                           |
| `/cd`         | —                                                           | セッションの作業ディレクトリを選択                                 |
| `/permission` | `[preset]`                                                  | dsh の権限プリセットを表示・選択                                   |
| `/model`      | —                                                           | プロバイダとモデルを選択                                           |
| `/login`      | `[provider]`                                                | OAuth または API キーでプロバイダにログイン                        |
| `/logout`     | `[provider]`                                                | 保存済みのプロバイダ認証情報を削除                                 |
| `/file`       | `<path> \| clear`                                           | 次のメッセージにファイルや画像を添付、または添付を解除             |
| `/dsh`        | `<command> [args]`                                          | TUI コマンド名と重複する場合も含め、dsh のネイティブコマンドを実行 |
| `/effort`     | `[level \| default]`                                        | 現在のモデルの推論 effort を選択                                   |
| `/new`        | —                                                           | 現在のモデルで新しい会話を開始                                     |
| `/rename`     | `[title]`                                                   | 現在のセッションのタイトルを変更                                   |
| `/fork`       | —                                                           | 完了したターンからセッションを分岐                                 |
| `/archive`    | —                                                           | セッションを選んでアーカイブ                                       |
| `/restore`    | —                                                           | アーカイブ済みのセッションを復元                                   |
| `/pin`        | —                                                           | セッションを選んでピン留め                                         |
| `/unpin`      | —                                                           | セッションのピン留めを解除                                         |
| `/ps`         | —                                                           | バックグラウンドジョブと出力を確認                                 |
| `/stop`       | —                                                           | 停止するバックグラウンドジョブを選択                               |
| `/session`    | —                                                           | 現在のセッション ID を表示                                         |
| `/status`     | —                                                           | モデル、セッション、使用量、アカウント上限、設定を表示             |
| `/compact`    | —                                                           | セッション履歴を要約してコンテキストを整理                         |
| `/plan`       | `[off \| message]`                                          | planモードの開始・終了、または計画の指示                           |
| `/goal`       | `[objective \| clear \| edit objective \| pause \| resume]` | 目標の作成・確認・編集・一時停止・再開・削除                       |
| `/feedback`   | `<text>`                                                    | 現在のセッションについて dsh にフィードバックを記録                |
| `/export`     | `[path.zip]`                                                | セッション、子セッション、添付ファイルを ZIP に書き出し            |
| `/quit`       | —                                                           | lazydsh を終了                                                     |

このほか、dsh プラグインがコマンドを登録している場合は、それらも利用できます。

## プロバイダ

対応するプロバイダは次のとおりです。

| プロバイダ名                  | ID                              | 認証方法                      |
| ----------------------------- | ------------------------------- | ----------------------------- |
| DeepSeek                      | `deepseek-official`             | APIキー                       |
| OpenCode Go                   | `opencode-go`                   | APIキー                       |
| OpenCode Zen                  | `opencode`                      | APIキー                       |
| OpenAI Codex                  | `openai-codex`                  | OAuth                         |
| Amazon Bedrock                | `amazon-bedrock`                | AWS認証情報、Bearerトークン   |
| Ant Ling                      | `ant-ling`                      | APIキー                       |
| Anthropic                     | `anthropic`                     | APIキー、OAuth                |
| Azure                         | `azure`                         | APIキー                       |
| Baseten                       | `baseten`                       | APIキー                       |
| Cerebras                      | `cerebras`                      | APIキー                       |
| Cloudflare AI Gateway         | `cloudflare-ai-gateway`         | APIキー                       |
| Cloudflare Workers AI         | `cloudflare-workers-ai`         | APIキー                       |
| DeepSeek                      | `deepseek`                      | APIキー                       |
| Fireworks                     | `fireworks`                     | APIキー                       |
| GitHub Copilot                | `github-copilot`                | OAuth、トークン               |
| Google                        | `google`                        | APIキー                       |
| Google Vertex AI              | `google-vertex`                 | APIキー、Google Cloud認証情報 |
| Groq                          | `groq`                          | APIキー                       |
| Hugging Face                  | `huggingface`                   | APIキー                       |
| Kimi For Coding               | `kimi-coding`                   | APIキー、OAuth                |
| Meta                          | `meta`                          | APIキー、OAuth                |
| MiniMax                       | `minimax`                       | APIキー                       |
| MiniMax CN                    | `minimax-cn`                    | APIキー                       |
| Mistral                       | `mistral`                       | APIキー                       |
| Moonshot AI                   | `moonshotai`                    | APIキー                       |
| Moonshot AI CN                | `moonshotai-cn`                 | APIキー                       |
| NVIDIA                        | `nvidia`                        | APIキー                       |
| OpenAI                        | `openai`                        | APIキー、OAuth                |
| OpenRouter                    | `openrouter`                    | APIキー、OAuth                |
| Qwen Token Plan               | `qwen-token-plan`               | APIキー                       |
| Qwen Token Plan CN            | `qwen-token-plan-cn`            | APIキー                       |
| Qwen Token Plan Individual    | `qwen-token-plan-individual`    | APIキー                       |
| Qwen Token Plan Individual CN | `qwen-token-plan-individual-cn` | APIキー                       |
| Radius                        | `radius`                        | APIキー、OAuth                |
| Together                      | `together`                      | APIキー                       |
| Vercel AI Gateway             | `vercel-ai-gateway`             | APIキー                       |
| xAI                           | `xai`                           | APIキー、OAuth                |
| Xiaomi                        | `xiaomi`                        | APIキー                       |
| Xiaomi Token Plan AMS         | `xiaomi-token-plan-ams`         | APIキー                       |
| Xiaomi Token Plan CN          | `xiaomi-token-plan-cn`          | APIキー                       |
| Xiaomi Token Plan SGP         | `xiaomi-token-plan-sgp`         | APIキー                       |
| Z.AI                          | `zai`                           | APIキー                       |
| Z.AI Coding CN                | `zai-coding-cn`                 | APIキー                       |

## ライセンス

lazydshは[MITライセンス](LICENSE)の下で公開されています。
