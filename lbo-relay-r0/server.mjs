import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import { WebSocketServer } from 'ws';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';

const VERSION = '0.1.0';
const PORT = Number(process.env.PORT || 3000);
const MCP_PATH_SECRET = process.env.MCP_PATH_SECRET;
const DEVICE_TOKEN = process.env.DEVICE_TOKEN;
const DEFAULT_DEVICE_ID = process.env.DEFAULT_DEVICE_ID || 'default-device';

if (!MCP_PATH_SECRET || MCP_PATH_SECRET.length < 24) {
  throw new Error('MCP_PATH_SECRET must be set and at least 24 characters.');
}
if (!DEVICE_TOKEN || DEVICE_TOKEN.length < 24) {
  throw new Error('DEVICE_TOKEN must be set and at least 24 characters.');
}

const MCP_PATH = `/mcp/${MCP_PATH_SECRET}`;
const DEVICE_PATH = '/device';
const devices = new Map();
const pending = new Map();

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function nowIso() {
  return new Date().toISOString();
}

function resolvePending(requestId, payload) {
  const item = pending.get(requestId);
  if (!item) return;
  pending.delete(requestId);
  clearTimeout(item.timer);
  item.resolve(payload);
}

function rejectDevicePending(deviceId, reason) {
  for (const [id, item] of pending.entries()) {
    if (item.deviceId === deviceId) {
      pending.delete(id);
      clearTimeout(item.timer);
      item.resolve({ status: 'DEVICE_DISCONNECTED', reason, deviceId });
    }
  }
}

async function pingDevice(deviceId) {
  const ws = devices.get(deviceId);
  if (!ws || ws.readyState !== 1) {
    return { status: 'DEVICE_OFFLINE', deviceId };
  }

  const requestId = crypto.randomUUID();
  const resultPromise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve({ status: 'TIMEOUT', deviceId, requestId });
    }, 12000);
    pending.set(requestId, { resolve, timer, deviceId });
  });

  ws.send(JSON.stringify({
    type: 'ping',
    request_id: requestId,
    sent_at: nowIso(),
    relay_version: VERSION
  }));

  return await resultPromise;
}

function buildMcpServer() {
  const mcp = new McpServer({
    name: 'Local Browser Operator Relay',
    version: VERSION
  });

  mcp.registerTool(
    'lbo_device_ping',
    {
      description: 'Ping the connected Local Browser Operator Windows daemon. This diagnostic does not access the browser.',
      inputSchema: z.object({
        device_id: z.string().min(1).optional().describe('Device id. Omit to use the default device.')
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ device_id }) => {
      const deviceId = device_id || DEFAULT_DEVICE_ID;
      const result = await pingDevice(deviceId);

      if (result.status !== 'PONG') {
        return {
          content: [{ type: 'text', text: `LBO_${result.status} | device=${deviceId}` }],
          structuredContent: result,
          isError: false
        };
      }

      return {
        content: [{
          type: 'text',
          text: [
            'LBO_DEVICE_PONG',
            `device=${deviceId}`,
            `platform=${result.platform}`,
            `arch=${result.arch}`,
            `node=${result.node}`,
            `hostname=${result.hostname}`,
            `daemon=${result.daemon_version}`
          ].join(' | ')
        }],
        structuredContent: result
      };
    }
  );

  mcp.registerTool(
    'lbo_relay_status',
    {
      description: 'Return relay status and whether the default local device is connected.',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => ({
      content: [{
        type: 'text',
        text: `LBO_RELAY_OK | version=${VERSION} | default_device_connected=${devices.has(DEFAULT_DEVICE_ID)}`
      }],
      structuredContent: {
        status: 'OK',
        relayVersion: VERSION,
        defaultDeviceId: DEFAULT_DEVICE_ID,
        defaultDeviceConnected: devices.has(DEFAULT_DEVICE_ID),
        connectedDeviceCount: devices.size,
        relayPlatform: process.platform,
        relayHostname: os.hostname()
      }
    })
  );

  return mcp;
}

const mcpHandler = createMcpHandler(buildMcpServer);
const nodeMcpHandler = toNodeHandler(mcpHandler);

const server = http.createServer((req, res) => {
  const base = `http://${req.headers.host || 'localhost'}`;
  const url = new URL(req.url || '/', base);

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      version: VERSION,
      connectedDeviceCount: devices.size
    }));
    return;
  }

  if (url.pathname === MCP_PATH) {
    void nodeMcpHandler(req, res);
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  try {
    const base = `http://${req.headers.host || 'localhost'}`;
    const url = new URL(req.url || '/', base);

    if (url.pathname !== DEVICE_PATH) {
      socket.destroy();
      return;
    }

    const deviceId = url.searchParams.get('device_id') || '';
    const token = url.searchParams.get('token') || '';

    if (!deviceId || !safeEqual(token, DEVICE_TOKEN)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.lboDeviceId = deviceId;
      wss.emit('connection', ws, req);
    });
  } catch {
    socket.destroy();
  }
});

wss.on('connection', (ws) => {
  const deviceId = ws.lboDeviceId;
  const previous = devices.get(deviceId);

  if (previous && previous !== ws) {
    try {
      previous.close(4001, 'replaced');
    } catch {}
  }

  devices.set(deviceId, ws);
  console.log(`[relay] device connected: ${deviceId}`);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg?.type === 'pong' && typeof msg.request_id === 'string') {
      resolvePending(msg.request_id, msg);
    }
  });

  ws.on('close', () => {
    if (devices.get(deviceId) === ws) {
      devices.delete(deviceId);
    }
    rejectDevicePending(deviceId, 'websocket_closed');
    console.log(`[relay] device disconnected: ${deviceId}`);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[relay] LBO Relay ${VERSION} listening on :${PORT}`);
});
