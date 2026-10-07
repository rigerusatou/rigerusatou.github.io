import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';

const VERSION = '0.2.0';
const PORT = Number(process.env.PORT || 3000);
const MCP_PATH_SECRET = process.env.MCP_PATH_SECRET;
const DEVICE_TOKEN = process.env.DEVICE_TOKEN;
const DEFAULT_DEVICE_ID = process.env.DEFAULT_DEVICE_ID || 'dohuremi-pc';

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

function parseBearer(req) {
  const raw = String(req.headers.authorization || '');
  return raw.startsWith('Bearer ') ? raw.slice(7) : '';
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
      item.resolve({
        status: 'DEVICE_DISCONNECTED',
        reason,
        device_id: deviceId,
        request_id: id
      });
    }
  }
}

async function sendDeviceJob(deviceId, operation, input = {}, timeoutMs = 20000) {
  const ws = devices.get(deviceId);
  if (!ws || ws.readyState !== 1) {
    return { status: 'DEVICE_OFFLINE', device_id: deviceId };
  }

  const requestId = crypto.randomUUID();

  const resultPromise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve({
        status: 'TIMEOUT',
        device_id: deviceId,
        request_id: requestId
      });
    }, timeoutMs);

    pending.set(requestId, {
      resolve,
      timer,
      deviceId
    });
  });

  ws.send(JSON.stringify({
    type: 'job',
    request_id: requestId,
    operation,
    input,
    sent_at: nowIso(),
    relay_version: VERSION
  }));

  return await resultPromise;
}

function buildMcpServer() {
  const mcp = new McpServer(
    {
      name: 'Selfish',
      version: VERSION
    },
    {
      instructions:
        'Development remote bridge for Selfish. Execution occurs on the paired local PC. This build exposes only status and a bounded localhost synthetic fixture task. Arbitrary website access is not enabled.'
    }
  );

  mcp.registerTool(
    'selfish_status',
    {
      title: 'Selfish Status',
      description:
        'Read the current state of the paired local Selfish worker. This checks the local PC through the Selfish relay and does not expose browser credentials or profile data.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => {
      const result = await sendDeviceJob(
        DEFAULT_DEVICE_ID,
        'STATUS',
        {}
      );

      return {
        content: [{
          type: 'text',
          text:
            result.status === 'PASS'
              ? `Selfish state=${result.result?.state ?? 'UNKNOWN'}`
              : `Selfish ${result.status}`
        }],
        structuredContent: result
      };
    }
  );

  mcp.registerTool(
    'selfish_run_fixture_task',
    {
      title: 'Run Selfish Local Fixture Task',
      description:
        'Run one bounded synthetic localhost browser task on the paired PC. This development tool cannot navigate arbitrary websites or perform production side effects.',
      inputSchema: z.object({
        request_id: z.string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9._:-]+$/),
        text: z.string().min(1).max(128)
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ request_id, text }) => {
      const result = await sendDeviceJob(
        DEFAULT_DEVICE_ID,
        'FIXTURE',
        { request_id, text }
      );

      return {
        content: [{
          type: 'text',
          text:
            result.status === 'PASS'
              ? `Selfish fixture ${result.result?.state ?? 'UNKNOWN'}`
              : `Selfish fixture ${result.status}`
        }],
        structuredContent: result
      };
    }
  );

  mcp.registerTool(
    'selfish_relay_status',
    {
      title: 'Selfish Relay Status',
      description:
        'Read whether the Selfish relay currently has a paired local worker connected. This is diagnostic only.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => {
      const connected = devices.has(DEFAULT_DEVICE_ID);
      return {
        content: [{
          type: 'text',
          text: `Selfish relay online; local_worker_connected=${connected}`
        }],
        structuredContent: {
          status: 'PASS',
          relay_version: VERSION,
          local_worker_connected: connected,
          connected_device_count: devices.size
        }
      };
    }
  );

  return mcp;
}

const mcpHandler = createMcpHandler(buildMcpServer);
const nodeMcpHandler = toNodeHandler(mcpHandler);

const server = http.createServer((req, res) => {
  const base = `http://${req.headers.host || 'localhost'}`;
  const url = new URL(req.url || '/', base);

  if (url.pathname === '/healthz') {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    });
    res.end(JSON.stringify({
      ok: true,
      service: 'selfish-remote-relay',
      version: VERSION,
      connected_device_count: devices.size,
      default_device_connected: devices.has(DEFAULT_DEVICE_ID)
    }));
    return;
  }

  if (url.pathname === MCP_PATH) {
    void nodeMcpHandler(req, res);
    return;
  }

  res.writeHead(404, {
    'content-type': 'text/plain; charset=utf-8'
  });
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
    const bearer = parseBearer(req);

    if (!deviceId || !safeEqual(bearer, DEVICE_TOKEN)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.selfishDeviceId = deviceId;
      wss.emit('connection', ws, req);
    });
  } catch {
    socket.destroy();
  }
});

wss.on('connection', (ws) => {
  const deviceId = ws.selfishDeviceId;
  const previous = devices.get(deviceId);

  if (previous && previous !== ws) {
    try { previous.close(4001, 'replaced'); } catch {}
  }

  devices.set(deviceId, ws);
  console.log(`[relay] Selfish device connected: ${deviceId}`);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (
      msg?.type === 'result' &&
      typeof msg.request_id === 'string'
    ) {
      resolvePending(msg.request_id, msg);
    }
  });

  ws.on('close', () => {
    if (devices.get(deviceId) === ws) {
      devices.delete(deviceId);
    }
    rejectDevicePending(deviceId, 'websocket_closed');
    console.log(`[relay] Selfish device disconnected: ${deviceId}`);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[relay] Selfish Relay ${VERSION} listening on :${PORT}`);
});
