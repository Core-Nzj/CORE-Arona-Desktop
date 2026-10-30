
# FRAME MCP Test (Issue #4 / Phase 1)

This experimental plugin is not FRAME itself. It exposes one read-only MCP tool (`ping`) and does not inspect the computer.

## Requirements

- Windows ChatGPT desktop app with local-marketplace support
- Node.js 22.12 or newer installed on PATH; Node.js 24 recommended

## Installation / verification

1. Fetch and check out the `feat/issue-4-mcp-smoke-test` Git branch.
2. In Windows PowerShell, execute `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-frame-mcp-test.ps1` from the repository root. This copies the test plugin into your personal local marketplace and preserves other plugin entries (the previous marketplace file is backed up).\n3. Restart the ChatGPT Windows desktop application.
4. Open Plugins and look for the local source named **FRAME Development** from `.agents/plugins/marketplace.json`. You may need to configure the repository as a local marketplace first. If Chat mode does not expose a local source, document this as a compatibility limitation.
5. Install **FRAME MCP Test**. It starts an independent STDIO process using the bundled `server/index.mjs`. It does *not* reuse the earlier manually registered `frame_test` sample server.
6. Start a **new ordinary Chat**, explicitly not Work or Codex. Mention `@FRAME MCP Test` or request the `ping` tool.
7. Success means the actual tool returned `FRAME_PONG (local Node.js, win32)`. Mere listing/installation is not proof of Chat support.

## Direct Node.js smoke test (PowerShell)

From the repo root, run:

```powershell
@'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"frame-test-client","version":"0.1.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ping","arguments":{}}}
'@ | node .\plugins\frame-mcp-test\server\index.mjs
```

The expected response contains the `ping` tool and `FRAME_PONG`. This checks MCP wire behavior locally, not ChatGPT integration.
