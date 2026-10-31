# FRAME ローカルプラグイン（第一段階）

このページは、[ADR-0002](adr/0002-frame-core-plugin-architecture.md)の試作実装について説明します。

## 対象範囲

- FRAMEの右クリック操作パネルに「拡張」タブを追加。
- ユーザーデータの `plugins/` 配下で、対応する `plugin.json` を持つプラグインを検出。
- 利用者が「利用を許可する」を選んだものだけ実行。プラグインのスクリプトSHA-256が変われば再許可が必要。
- 第一段階で対応するのは `frame.windows-list.v1`（ウィンドウ名・PIDの一覧）のみ。
- ウィンドウ一覧の表示はFRAME操作パネル内だけ。画像キャプチャ、カメラ、マイク、ChatGPT送信、MCP連携は**未実装**。
- FRAMEの音声読み上げ・MMD表示・モーションは既存のまま。

## インストール手順（研究所向け）

1. FRAMEの「拡張」タブで「フォルダを開く」を押す。
2. 開いたディレクトリに、別途提供される研究所用プラグインをフォルダごと配置する。GitHubの公開リポジトリには研究所専用視覚スクリプトを同梱しない。
3. 「再読み込み」を押し、プラグインの説明を確認して「利用を許可する」を押す。
4. 「窓一覧を取得」を押す。通常の可視ウィンドウのタイトルとPIDが操作パネルに表示される。
5. 停止するときは「無効化する」。再起動後は許可状態を復元するが、スクリプト変更時は再許可が必要。

Windows PowerShellが必要です。Windows以外の環境ではプラグインの読み込みはできますが、窓一覧取得は無効になります。

## プラグインの構造（研究用v1）

```text
%APPDATA%/(FRAMEのElectron userData)/plugins/
└── frame.vision.windows/
    ├── plugin.json
    └── list-windows.ps1
```

`plugin.json` の必須形式:

```json
{
  "id": "frame.vision.windows",
  "name": "視覚 / ウィンドウ一覧",
  "apiVersion": 1,
  "type": "frame.windows-list.v1",
  "entry": "list-windows.ps1",
  "permissions": ["window-titles"]
}
```

安全性のため、現行ホストはこのプロトコルと `list-windows.ps1` のみを受け付けます。任意のJSモジュールをElectronメインプロセスへ `require` する構造ではありません。ファイル名・パス・一覧の出力形式を検証し、10秒の処理タイムアウト・256KiBの出力上限を設けます。

ただし、**許可したPowerShellスクリプトはログイン中のWindowsユーザー権限で動作します**。これはOSレベルのサンドボックスではありません。信頼できないプラグインを導入しないでください。将来の一般配布向けには署名、実行権限分離、アクセス制御等の設計が必要です。

ユーザーが見たウィンドウ名やPIDはメモリにのみ保持し、許可状態だけを `frame-plugin-permissions.json` に保存します。ChatGPTや外部サーバーへ送信しません。

## 次の開発段階

- 実際のWindows端末で表示の可用性と負荷を確認。
- `capture_window`、`capture_display`、`capture_camera` は個別の権限設計後に実装。
- ChatGPTからの呼び出しはFRAMEのプラグインAPIとは独立した接続アダプターとして扱う。
- Coreと視覚機能を物理的に分離し、公開版に視覚プラグインの実装を入れない方針を維持する。
