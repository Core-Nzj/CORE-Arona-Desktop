/**
 * FRAME Issue #4: minimal, read-only, dependency-free MCP test.
 * STDOUT is reserved for newline-delimited JSON-RPC.
 */
import { createInterface } from 'node:readline';

const SERVER_INFO = { name: 'frame-mcp-test', version: '0.1.0' };
const LEGACY_VERSION = '2025-11-25';
const MODERN_VERSION = '2026-07-28';
const TOOL = {
  name: 'ping',
  description: 'Read-only local connection check. Returns FRAME_PONG and this computer clock time. No PC information, files, or remote services are accessed.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
};

let legacyInitialized = false;
function send(payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...payload }) + '\n');
}
function fail(id, code, message, data) {
  send({ id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}
function reply(id, result, modern) {
  send({
    id,
    result: modern ? {
      ...result,
      resultType: 'complete',
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO }
    } : result
  });
}
function handle(request) {
  if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    if (request?.id !== undefined) fail(request.id, -32600, 'Invalid Request');
    return;
  }
  if (request.id === undefined) return; // Notification; no response.
  const id = request.id;
  const requested = request.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
  const modern = requested === MODERN_VERSION;

  if (requested && !modern) {
    fail(id, -32022, 'Unsupported protocol version', {
      supported: [MODERN_VERSION, LEGACY_VERSION], requested
    });
    return;
  }
  if (request.method === 'server/discover') {
    reply(id, {
      supportedVersions: [MODERN_VERSION],
      capabilities: { tools: {} },
      ttlMs: 0,
      cacheScope: 'private'
    }, true);
    return;
  }
  if (request.method === 'initialize') {
    const offered = request.params?.protocolVersion;
    const negotiated = typeof offered === 'string' && offered <= LEGACY_VERSION
      ? offered : LEGACY_VERSION;
    legacyInitialized = true;
    reply(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO
    }, false);
    return;
  }
  if (!modern && !legacyInitialized) {
    fail(id, -32000, 'Server not initialized');
    return;
  }
  switch (request.method) {
    case 'ping': // Legacy protocol ping, distinct from the ping tool.
      reply(id, {}, modern);
      return;
    case 'tools/list':
      reply(id, { tools: [TOOL] }, modern);
      return;
    case 'tools/call':
      if (request.params?.name !== 'ping') {
        fail(id, -32602, 'Unknown tool');
        return;
      }
      const args = request.params?.arguments;
      if (args !== undefined && (
        args === null || typeof args !== 'object' || Array.isArray(args) ||
        Object.keys(args).length !== 0
      )) {
        fail(id, -32602, 'ping accepts no arguments');
        return;
      }
      reply(id, {
        content: [{ type: 'text', text:
          'FRAME_PONG (local Node.js, ' + process.platform + ') at ' +
          new Date().toISOString()
        }],
        isError: false
      }, modern);
      return;
    default:
      fail(id, -32601, 'Method not found');
  }
}

createInterface({ input: process.stdin, crlfDelay: Infinity })
  .on('line', line => {
    try { handle(JSON.parse(line)); }
    catch { fail(null, -32700, 'Parse error'); }
  });
