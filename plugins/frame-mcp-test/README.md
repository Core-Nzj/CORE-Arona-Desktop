# FRAME MCP Test — Issue #4 / Phase 1

FRAME本体から独立した、依存パッケージ不要の検証用プラグインです。
`ping` ツールだけを公開し、`FRAME_PONG (local Node.js, win32) at <UTC時刻>` を返します。
PC操作・ファイル読み取り・外部通信・OpenAI APIキーは不要です。
既存の `frame_test` サンプルサーバーとは別プロセスです。同名のサーバーがある場合は、ツールの提供元が **FRAME MCP Test** であることを確認してください。

## 判定範囲

- ローカルのSTDIO通信と、ChatGPTの通常Chatから呼べることは別々に判定します。
- 通常Chatでのインストール・実際のツール呼び出しは未検証です。
- Work/Codexへの切り替えを前提にしません。通常Chatにローカルプラグインの導線がなければ、その環境では未対応／未確認として止めてください。
- FRAME本体の接続・制御はPhase 1の対象外です。

## Windowsで取得・ローカル検証

GitとNode.js 22.12以上がPATH上に必要です。npm installやFRAMEの起動は不要です。
以下は任意の作業フォルダから実行できます。保存先がすでにある場合はcloneを繰り返さず、対象フォルダ・ブランチを確認してください。

```powershell
$testRoot = Join-Path $HOME 'FRAME-Issue4-Test'
git clone --branch feat/issue-4-mcp-smoke-test --single-branch https://github.com/Core-Nzj/CORE-Arona-Desktop.git "$testRoot"
if ($LASTEXITCODE -ne 0) { throw 'Clone failed; stop here.' }
node --test "$testRoot\plugins\frame-mcp-test\server\smoke.test.mjs"
if ($LASTEXITCODE -ne 0) { throw 'Smoke test failed; stop here.' }
```

3件のテスト成功で、初期化・ツール一覧・ping応答・不正入力後の復帰を確認できます。
これはChatGPTとの接続成功を意味しません。

## 個人用ローカルMarketplaceへの準備

同じPowerShellで実行します（既存の取得先を使う場合は `$testRoot` をその絶対パスに設定）。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$testRoot\scripts\install-frame-mcp-test.ps1"
if ($LASTEXITCODE -ne 0) { throw 'Marketplace preparation failed; stop here.' }
```

このコマンドは現在ユーザーの以下の場所だけに検証用ファイルを配置します。

- `~/.codex/plugins/frame-mcp-test/`: プラグインの配布元コピー
- `~/.agents/plugins/marketplace.json`: 個人用カタログ（他のエントリーは保持）
- 既存カタログは一意な `.bak` ファイルにバックアップ

`.codex` はホストが利用する保存先名であり、Codexで開発する手順ではありません。
スクリプトはアプリへのインストールや通常Chat対応を保証しません。`-ProfileRoot` は隔離テスト用で、通常は指定不要です。

1. ChatGPT Windowsアプリを完全に終了して再起動します。
2. 通常Chatのプラグイン画面で、個人用ソース内の **FRAME MCP Test** を探します。新規カタログなら表示名は **FRAME Local Plugins** です。
3. 表示された場合だけインストールし、新しい通常Chatで **FRAME MCP Test** を選びます。
4. 「このプラグインのpingツールを実行し、結果をそのまま表示して」と依頼します。
5. 実際のツール実行結果に `FRAME_PONG (local Node.js, win32)` と時刻があることを確認します。文章として同じ文字列が返るだけでは成功にしません。

個人用ソースやプラグインが表示されなければ、アプリのバージョン・利用モード・表示された画面を記録してください。Work/Codexでの成功を通常Chatの成功に置き換えないでください。
更新時は準備スクリプトを再実行した後、アプリ側で再インストールしてください。アプリは配布元と別のキャッシュを使うため、配布元の更新だけでは反映されない場合があります。
撤去時はアプリでアンインストールし、個人用カタログの `frame-mcp-test` エントリーと上記配布元フォルダだけを削除します。他のエントリーは残してください。

## ファイル構成・公式仕様

`plugin.json` はルートmanifest、`mcp.json` は `${PLUGIN_ROOT}/server/index.mjs` をNode.jsでSTDIO起動します。外部依存はありません。ローカルMCPを含むためDesktop-onlyに該当します。

2026-10-31に確認した公式資料:

- [Package your plugin](https://developers.openai.com/plugins/build/plugins): manifest・ローカルMarketplace・キャッシュの仕様。導入可能な画面は環境依存で、説明にはWork/Codexが含まれます。
- [Submit desktop-only plugins](https://developers.openai.com/plugins/deploy/desktop-only): ローカルMCPの起動形式。これだけでは通常Chatでの利用を証明しません。
- [MCP protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions): 従来のinitialize方式と2026-07-28のdiscovery方式。本サーバーは両方式の最小ping検証を実装しています。

公式Directoryへの公開やアカウント登録は、この手順では実行しません。
