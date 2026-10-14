import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';

const VERSION = '0.8.0';
const DEV_EXEC_TOKEN_SHA256 = 'ade84750c99fcd5dfe8a0edbcf0c60a17981388da1b7ea3f29d348f1cea47a9d';
const DEV_EXEC_EXPIRES_AT = '2026-10-20T06:45:42Z';
const PORT = Number(process.env.PORT || 3000);
const MCP_PATH_SECRET = process.env.MCP_PATH_SECRET;
const DEVICE_TOKEN = process.env.DEVICE_TOKEN;
const S9_OAUTH_SIGNING_SECRET = process.env.S9_OAUTH_SIGNING_SECRET;
const PUBLIC_BASE_URL = 'https://lbo-relay-r0.onrender.com';
const S9_MCP_PATH = '/mcp-chatgpt-s9';
const S9_RESOURCE = `${PUBLIC_BASE_URL}${S9_MCP_PATH}`;
const S9_PROTECTED_RESOURCE_METADATA = `${PUBLIC_BASE_URL}/.well-known/oauth-protected-resource/mcp-chatgpt-s9`;
const S9_SCOPES = ['selfish.read', 'selfish.write', 'offline_access'];

const DEFAULT_DEVICE_ID = process.env.DEFAULT_DEVICE_ID || 'dohuremi-pc';

if (!MCP_PATH_SECRET || MCP_PATH_SECRET.length < 24) {
  throw new Error('MCP_PATH_SECRET must be set and at least 24 characters.');
}
if (!DEVICE_TOKEN || DEVICE_TOKEN.length < 24) {
  throw new Error('DEVICE_TOKEN must be set and at least 24 characters.');
}
if (!S9_OAUTH_SIGNING_SECRET || S9_OAUTH_SIGNING_SECRET.length < 48) {
  throw new Error('S9_OAUTH_SIGNING_SECRET must be set and at least 48 characters.');
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

function authorizeDevExec(req) {
  if (Date.now() >= Date.parse(DEV_EXEC_EXPIRES_AT)) return false;
  const bearer = parseBearer(req);
  if (!bearer) return false;
  const digest = crypto.createHash('sha256').update(bearer).digest('hex');
  return safeEqual(digest, DEV_EXEC_TOKEN_SHA256);
}


const s9AuthCodes = new Map();

function s9Base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function s9SignToken(payload) {
  const body = s9Base64UrlJson(payload);
  const sig = crypto
    .createHmac('sha256', S9_OAUTH_SIGNING_SECRET)
    .update(body)
    .digest('base64url');
  return `${body}.${sig}`;
}

function s9VerifyToken(token, expectedType) {
  try {
    const [body, sig] = String(token || '').split('.');
    if (!body || !sig) return null;
    const expected = crypto
      .createHmac('sha256', S9_OAUTH_SIGNING_SECRET)
      .update(body)
      .digest('base64url');
    if (!safeEqual(sig, expected)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.typ !== expectedType) return null;
    if (payload.aud !== S9_RESOURCE) return null;
    if (!Number.isFinite(payload.exp) || Date.now() >= payload.exp * 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

function s9IssueTokens(clientId, scope) {
  const now = Math.floor(Date.now() / 1000);
  const normalizedScope = S9_SCOPES.filter(x => String(scope || '').split(/\s+/).includes(x));
  for (const required of ['selfish.read', 'selfish.write']) {
    if (!normalizedScope.includes(required)) normalizedScope.push(required);
  }
  if (!normalizedScope.includes('offline_access')) normalizedScope.push('offline_access');
  const scopeText = normalizedScope.join(' ');

  const accessToken = s9SignToken({
    typ: 'access',
    sub: 'selfish-local-owner',
    cid: clientId,
    aud: S9_RESOURCE,
    scope: scopeText,
    iat: now,
    exp: now + 900,
    jti: crypto.randomUUID()
  });

  const refreshToken = s9SignToken({
    typ: 'refresh',
    sub: 'selfish-local-owner',
    cid: clientId,
    aud: S9_RESOURCE,
    scope: scopeText,
    iat: now,
    exp: now + (7 * 24 * 60 * 60),
    jti: crypto.randomUUID()
  });

  return {
    token_type: 'Bearer',
    access_token: accessToken,
    expires_in: 900,
    refresh_token: refreshToken,
    scope: scopeText
  };
}

function s9AllowedRedirectUri(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.hostname !== 'chatgpt.com') return false;
    return (
      u.pathname === '/connector_platform_oauth_redirect' ||
      u.pathname.startsWith('/connector/oauth/')
    );
  } catch {
    return false;
  }
}

function s9ScopeAllowed(scopeText) {
  const requested = String(scopeText || '')
    .split(/\s+/)
    .filter(Boolean);
  return requested.every(x => S9_SCOPES.includes(x));
}

async function readHttpBody(req, maxBytes = 65536) {
  return await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('REQUEST_BODY_TOO_LARGE'));
        try { req.destroy(); } catch {}
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function writeJson(res, status, value, extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders
  });
  res.end(JSON.stringify(value));
}

function writeHtml(res, status, html) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(html);
}

function s9AccessFromRequest(req) {
  const token = parseBearer(req);
  const payload = s9VerifyToken(token, 'access');
  if (!payload) return null;
  const scopes = new Set(String(payload.scope || '').split(/\s+/).filter(Boolean));
  if (!scopes.has('selfish.read') || !scopes.has('selfish.write')) return null;
  return payload;
}

async function handleS9DynamicRegistration(req, res) {
  try {
    const raw = await readHttpBody(req);
    const body = JSON.parse(raw || '{}');
    const redirects = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
    if (redirects.length < 1 || redirects.some(x => !s9AllowedRedirectUri(x))) {
      writeJson(res, 400, { error: 'invalid_redirect_uri' });
      return;
    }
    const clientId = `selfish-s9-${crypto
      .createHash('sha256')
      .update(JSON.stringify(redirects))
      .digest('hex')
      .slice(0, 32)}`;
    writeJson(res, 201, {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirects,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: 'ChatGPT'
    });
  } catch {
    writeJson(res, 400, { error: 'invalid_client_metadata' });
  }
}

async function handleS9Authorize(req, res, url) {
  const q = url.searchParams;
  const responseType = q.get('response_type');
  const clientId = String(q.get('client_id') || '');
  const redirectUri = String(q.get('redirect_uri') || '');
  const stateParam = String(q.get('state') || '');
  const codeChallenge = String(q.get('code_challenge') || '');
  const codeChallengeMethod = String(q.get('code_challenge_method') || '');
  const resource = String(q.get('resource') || '');
  const scope = String(q.get('scope') || 'selfish.read selfish.write offline_access');

  if (
    responseType !== 'code' ||
    !clientId.startsWith('selfish-s9-') ||
    !s9AllowedRedirectUri(redirectUri) ||
    codeChallengeMethod !== 'S256' ||
    codeChallenge.length < 32 ||
    resource !== S9_RESOURCE ||
    !s9ScopeAllowed(scope)
  ) {
    writeHtml(res, 400, '<h1>Selfish authorization request rejected</h1>');
    return;
  }

  const approval = await sendDeviceJob(
    DEFAULT_DEVICE_ID,
    'OAUTH_PAIRING_APPROVAL',
    {},
    95000
  );

  if (approval.status !== 'PASS' || approval.result?.approved !== true) {
    writeHtml(
      res,
      403,
      '<h1>Selfish connection not approved</h1><p>The local PC user did not approve this ChatGPT connection.</p>'
    );
    return;
  }

  const code = crypto.randomBytes(32).toString('base64url');
  s9AuthCodes.set(code, {
    clientId,
    redirectUri,
    codeChallenge,
    resource,
    scope,
    expiresAt: Date.now() + 5 * 60 * 1000
  });

  const target = new URL(redirectUri);
  target.searchParams.set('code', code);
  if (stateParam) target.searchParams.set('state', stateParam);
  target.searchParams.set('iss', PUBLIC_BASE_URL);
  res.writeHead(302, { location: target.toString(), 'cache-control': 'no-store' });
  res.end();
}

async function handleS9Token(req, res) {
  try {
    const raw = await readHttpBody(req);
    const form = new URLSearchParams(raw);
    const grantType = String(form.get('grant_type') || '');
    const clientId = String(form.get('client_id') || '');
    const resource = String(form.get('resource') || '');

    if (resource !== S9_RESOURCE || !clientId.startsWith('selfish-s9-')) {
      writeJson(res, 400, { error: 'invalid_target' });
      return;
    }

    if (grantType === 'authorization_code') {
      const code = String(form.get('code') || '');
      const redirectUri = String(form.get('redirect_uri') || '');
      const verifier = String(form.get('code_verifier') || '');
      const rec = s9AuthCodes.get(code);
      s9AuthCodes.delete(code);

      if (
        !rec ||
        Date.now() >= rec.expiresAt ||
        rec.clientId !== clientId ||
        rec.redirectUri !== redirectUri ||
        rec.resource !== resource ||
        !s9AllowedRedirectUri(redirectUri)
      ) {
        writeJson(res, 400, { error: 'invalid_grant' });
        return;
      }

      const actualChallenge = crypto
        .createHash('sha256')
        .update(verifier)
        .digest('base64url');

      if (!safeEqual(actualChallenge, rec.codeChallenge)) {
        writeJson(res, 400, { error: 'invalid_grant' });
        return;
      }

      writeJson(res, 200, s9IssueTokens(clientId, rec.scope));
      return;
    }

    if (grantType === 'refresh_token') {
      const refresh = s9VerifyToken(String(form.get('refresh_token') || ''), 'refresh');
      if (!refresh || refresh.cid !== clientId) {
        writeJson(res, 400, { error: 'invalid_grant' });
        return;
      }
      writeJson(res, 200, s9IssueTokens(clientId, refresh.scope));
      return;
    }

    writeJson(res, 400, { error: 'unsupported_grant_type' });
  } catch {
    writeJson(res, 400, { error: 'invalid_request' });
  }
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


function buildDevMcpServer() {
  const mcp = new McpServer(
    {
      name: 'Selfish Dev Read-only Bridge',
      version: VERSION
    },
    {
      instructions:
        'Temporary development-only read-only bridge for verifying ChatGPT -> relay -> paired local Selfish connectivity. This endpoint exposes status only and must not be treated as the production plugin endpoint.'
    }
  );

  mcp.registerTool(
    'selfish_relay_status',
    {
      title: 'Selfish Relay Status',
      description:
        'Read whether the Selfish relay currently has the paired local worker connected. Development diagnostic only.',
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

  mcp.registerTool(
    'selfish_status',
    {
      title: 'Selfish Status',
      description:
        'Read the paired local Selfish worker state through the relay. Development diagnostic only. No browser credentials or profile data are returned.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => {
      const result = await sendDeviceJob(DEFAULT_DEVICE_ID, 'STATUS', {});
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

  return mcp;
}


function buildDevExecMcpServer() {
  const mcp = new McpServer(
    {
      name: 'Selfish Dev Bounded Execution Bridge',
      version: VERSION
    },
    {
      instructions:
        'Temporary authenticated development gate. Exposes status plus one bounded synthetic localhost fixture task only. Arbitrary website access and production side effects are disabled.'
    }
  );

  mcp.registerTool(
    'selfish_relay_status',
    {
      title: 'Selfish Relay Status',
      description: 'Read whether the paired local Selfish worker is connected.',
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

  mcp.registerTool(
    'selfish_status',
    {
      title: 'Selfish Status',
      description: 'Read the paired local Selfish worker state through the relay.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => {
      const result = await sendDeviceJob(DEFAULT_DEVICE_ID, 'STATUS', {});
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
      title: 'Run Selfish Bounded Local Fixture Task',
      description:
        'Run one synthetic localhost-only browser fixture task on the paired PC. request_id is caller-supplied and is used by the local control plane for exact dedupe and mismatch blocking.',
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

  return mcp;
}


function buildDevWebMcpServer() {
  const mcp = new McpServer(
    {
      name: 'Selfish Dev Controlled Web Bridge',
      version: VERSION
    },
    {
      instructions:
        'Temporary authenticated S3 development gate. It exposes status plus one bounded Selenium-project test-form task. The local PC control plane enforces the exact target URL and fixed internal selectors. Arbitrary website access remains disabled.'
    }
  );

  mcp.registerTool(
    'selfish_relay_status',
    {
      title: 'Selfish Relay Status',
      description: 'Read whether the paired local Selfish worker is connected.',
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

  mcp.registerTool(
    'selfish_status',
    {
      title: 'Selfish Status',
      description: 'Read the paired local Selfish worker state through the relay.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => {
      const result = await sendDeviceJob(DEFAULT_DEVICE_ID, 'STATUS', {});
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
    'selfish_run_selenium_web_form_test',
    {
      title: 'Run Selfish Controlled Selenium Web Form Test',
      description:
        'Run a bounded real-web test against the Selenium project web-form page. The caller supplies a target_url so the local execution firewall can prove that non-allowlisted origins are rejected. Selectors remain fixed inside the local worker.',
      inputSchema: z.object({
        request_id: z.string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9._:-]+$/),
        target_url: z.string().url().max(512),
        text: z.string().min(1).max(128)
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async ({ request_id, target_url, text }) => {
      const result = await sendDeviceJob(
        DEFAULT_DEVICE_ID,
        'SELENIUM_WEB_FORM',
        { request_id, target_url, text },
        30000
      );

      return {
        content: [{
          type: 'text',
          text:
            result.status === 'PASS'
              ? `Selfish controlled web task ${result.result?.state ?? 'UNKNOWN'}`
              : `Selfish controlled web task ${result.status}`
        }],
        structuredContent: result
      };
    }
  );

  return mcp;
}


function buildDevPrimitiveMcpServer() {
  const roleLocator = z.object({
    kind: z.literal('role'),
    role: z.enum(['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox']),
    name: z.string().min(1).max(128)
  }).strict();

  const labelLocator = z.object({
    kind: z.literal('label'),
    name: z.string().min(1).max(128)
  }).strict();

  const textLocator = z.object({
    kind: z.literal('text'),
    text: z.string().min(1).max(256)
  }).strict();

  const readableLocator = z.union([roleLocator, labelLocator, textLocator]);
  const editableLocator = z.union([roleLocator, labelLocator]);

  const browserStep = z.discriminatedUnion('action', [
    z.object({
      action: z.literal('NAVIGATE')
    }).strict(),
    z.object({
      action: z.literal('READ_TITLE')
    }).strict(),
    z.object({
      action: z.literal('READ_TEXT'),
      locator: readableLocator,
      max_chars: z.number().int().min(1).max(4096)
    }).strict(),
    z.object({
      action: z.literal('TYPE'),
      locator: editableLocator,
      text: z.string().min(1).max(512)
    }).strict(),
    z.object({
      action: z.literal('CLICK'),
      locator: roleLocator
    }).strict()
  ]);

  const mcp = new McpServer(
    {
      name: 'Selfish Dev Safe Browser Primitives',
      version: VERSION
    },
    {
      instructions:
        'Temporary authenticated S4 development bridge. The model may provide a short semantic browser plan, but the paired local Selfish worker remains authoritative for origin policy, semantic-locator validation, side-effect approval, dedupe, hidden-state checks, and fail-closed execution. Arbitrary CSS/XPath/JavaScript/CDP/shell is not exposed.'
    }
  );

  mcp.registerTool(
    'selfish_relay_status',
    {
      title: 'Selfish Relay Status',
      description: 'Read whether the paired local Selfish worker is connected.',
      inputSchema: z.object({}).strict(),
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

  mcp.registerTool(
    'selfish_status',
    {
      title: 'Selfish Status',
      description: 'Read the paired local Selfish worker state through the relay.',
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => {
      const result = await sendDeviceJob(DEFAULT_DEVICE_ID, 'STATUS', {});
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
    'selfish_execute_browser_task',
    {
      title: 'Execute Selfish Safe Browser Task',
      description:
        'Execute a bounded semantic browser task on the paired PC. No arbitrary selectors, JavaScript, CDP, shell, credentials, cookies, or profile export are accepted. The local worker enforces the current S4 origin policy and side-effect approval.',
      inputSchema: z.object({
        request_id: z.string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9._:-]+$/),
        target_url: z.string().url().max(512),
        side_effect_approval: z.boolean(),
        steps: z.array(browserStep).min(1).max(8)
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async ({ request_id, target_url, side_effect_approval, steps }) => {
      const result = await sendDeviceJob(
        DEFAULT_DEVICE_ID,
        'SAFE_BROWSER_TASK',
        {
          request_id,
          target_url,
          side_effect_approval,
          steps
        },
        35000
      );

      return {
        content: [{
          type: 'text',
          text:
            result.status === 'PASS'
              ? `Selfish browser task ${result.result?.state ?? 'UNKNOWN'}`
              : `Selfish browser task ${result.status}: ${result.reason ?? 'unknown'}`
        }],
        structuredContent: result
      };
    }
  );

  return mcp;
}


function buildDevPublicMcpServer() {
  const roleLocator = z.object({
    kind: z.literal('role'),
    role: z.enum(['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox']),
    name: z.string().min(1).max(128)
  }).strict();

  const labelLocator = z.object({
    kind: z.literal('label'),
    name: z.string().min(1).max(128)
  }).strict();

  const textLocator = z.object({
    kind: z.literal('text'),
    text: z.string().min(1).max(256)
  }).strict();

  const readableLocator = z.union([roleLocator, labelLocator, textLocator]);
  const editableLocator = z.union([roleLocator, labelLocator]);

  const browserStep = z.discriminatedUnion('action', [
    z.object({ action: z.literal('NAVIGATE') }).strict(),
    z.object({ action: z.literal('READ_TITLE') }).strict(),
    z.object({
      action: z.literal('READ_TEXT'),
      locator: readableLocator,
      max_chars: z.number().int().min(1).max(4096)
    }).strict(),
    z.object({
      action: z.literal('TYPE'),
      locator: editableLocator,
      text: z.string().min(1).max(512)
    }).strict(),
    z.object({
      action: z.literal('CLICK'),
      locator: roleLocator
    }).strict()
  ]);

  const mcp = new McpServer(
    {
      name: 'Selfish Dev Public HTTPS Browser',
      version: VERSION
    },
    {
      instructions:
        'Temporary authenticated S5 development bridge. Caller-supplied browser targets are accepted only through the paired local Selfish worker, which enforces public-HTTPS DNS/IP policy, redirect/subresource checks, semantic locators, side-effect approval, takeover boundaries, dedupe, and hidden-state requirements. No arbitrary selector/JS/CDP/shell interface is exposed.'
    }
  );

  mcp.registerTool(
    'selfish_relay_status',
    {
      title: 'Selfish Relay Status',
      description: 'Read whether the paired local Selfish worker is connected.',
      inputSchema: z.object({}).strict(),
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
        content: [{ type: 'text', text: `Selfish relay online; local_worker_connected=${connected}` }],
        structuredContent: {
          status: 'PASS',
          relay_version: VERSION,
          local_worker_connected: connected,
          connected_device_count: devices.size
        }
      };
    }
  );

  mcp.registerTool(
    'selfish_status',
    {
      title: 'Selfish Status',
      description: 'Read the paired local Selfish worker state through the relay.',
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => {
      const result = await sendDeviceJob(DEFAULT_DEVICE_ID, 'STATUS', {});
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
    'selfish_execute_public_browser_task',
    {
      title: 'Execute Selfish Public HTTPS Browser Task',
      description:
        'Execute a bounded semantic browser task on a caller-supplied public HTTPS target. The local worker rejects local/private/non-public network destinations and rechecks page network requests. TYPE/CLICK require explicit side-effect approval. Arbitrary CSS/XPath/JavaScript/CDP/shell is not accepted.',
      inputSchema: z.object({
        request_id: z.string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9._:-]+$/),
        target_url: z.string().url().max(512),
        side_effect_approval: z.boolean(),
        steps: z.array(browserStep).min(1).max(8)
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async ({ request_id, target_url, side_effect_approval, steps }) => {
      const result = await sendDeviceJob(
        DEFAULT_DEVICE_ID,
        'PUBLIC_BROWSER_TASK',
        {
          request_id,
          target_url,
          side_effect_approval,
          steps
        },
        40000
      );

      return {
        content: [{
          type: 'text',
          text:
            result.status === 'PASS'
              ? `Selfish public browser task ${result.result?.state ?? 'UNKNOWN'}`
              : `Selfish public browser task ${result.status}: ${result.reason ?? 'unknown'}`
        }],
        structuredContent: result
      };
    }
  );

  return mcp;
}


function buildDevTakeoverMcpServer() {
  const mcp = new McpServer(
    {
      name: 'Selfish Dev Human Takeover Recovery',
      version: VERSION
    },
    {
      instructions:
        'Temporary authenticated S6 development bridge. It tests human takeover on the exact same local browser session. During takeover, automation and preview collection are paused. Resume is explicit and locally revalidated. No credentials are requested or transported.'
    }
  );

  mcp.registerTool(
    'selfish_relay_status',
    {
      title: 'Selfish Relay Status',
      description: 'Read whether the paired local Selfish worker is connected.',
      inputSchema: z.object({}).strict(),
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
        content: [{ type: 'text', text: `Selfish relay online; local_worker_connected=${connected}` }],
        structuredContent: {
          status: 'PASS',
          relay_version: VERSION,
          local_worker_connected: connected,
          connected_device_count: devices.size
        }
      };
    }
  );

  mcp.registerTool(
    'selfish_status',
    {
      title: 'Selfish Status',
      description: 'Read the paired local Selfish worker state and takeover metadata without reading page DOM or secrets.',
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => {
      const result = await sendDeviceJob(DEFAULT_DEVICE_ID, 'STATUS', {});
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
    'selfish_trigger_takeover_test',
    {
      title: 'Trigger Selfish Human Takeover Test',
      description:
        'Trigger the bounded S6 takeover boundary on the Selenium public demo Password field. The supplied probe marker is synthetic and must never be a real password.',
      inputSchema: z.object({
        request_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
        probe_marker: z.string().min(1).max(64).regex(/^[A-Za-z0-9._:-]+$/)
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ request_id, probe_marker }) => {
      const result = await sendDeviceJob(
        DEFAULT_DEVICE_ID,
        'TAKEOVER_TEST_TRIGGER',
        { request_id, probe_marker },
        35000
      );

      return {
        content: [{
          type: 'text',
          text:
            result.status === 'TAKEOVER_REQUIRED'
              ? 'Selfish takeover required; same local browser session is visible and automation is paused.'
              : `Selfish takeover test ${result.status}`
        }],
        structuredContent: result
      };
    }
  );

  mcp.registerTool(
    'selfish_takeover_privacy_probe',
    {
      title: 'Probe Selfish Takeover Privacy Fence',
      description:
        'Read takeover state and verify the local preview endpoint is blocked. This does not read page DOM, image pixels, credentials, or input.',
      inputSchema: z.object({}).strict(),
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
        'TAKEOVER_PRIVACY_PROBE',
        {},
        10000
      );

      return {
        content: [{
          type: 'text',
          text:
            result.status === 'PASS'
              ? `Takeover fence state=${result.result?.state ?? 'UNKNOWN'} preview_blocked=${result.result?.preview_blocked ?? false}`
              : `Takeover privacy probe ${result.status}`
        }],
        structuredContent: result
      };
    }
  );

  mcp.registerTool(
    'selfish_resume_takeover_test',
    {
      title: 'Explicitly Resume Selfish Takeover Test',
      description:
        'Resume the bounded S6 takeover test only after the human has manually checked Default checkbox in the visible Selenium page. The local worker revalidates same page identity, page count, URL, and proof before hiding the same browser again.',
      inputSchema: z.object({
        takeover_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/)
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ takeover_id }) => {
      const result = await sendDeviceJob(
        DEFAULT_DEVICE_ID,
        'TAKEOVER_TEST_RESUME',
        { takeover_id },
        20000
      );

      return {
        content: [{
          type: 'text',
          text:
            result.status === 'PASS'
              ? 'Selfish explicit resume revalidation passed; browser returned to hidden autonomous mode.'
              : `Selfish resume ${result.status}`
        }],
        structuredContent: result
      };
    }
  );

  return mcp;
}


function buildDevContinuityMcpServer() {
  const mcp = new McpServer(
    {
      name: 'Selfish Dev Takeover Continuity',
      version: VERSION
    },
    {
      instructions:
        'Temporary authenticated S7 development bridge. It proves that a durable local browser job can checkpoint before human takeover, preserve the exact same page/session, and resume the same persisted job from its checkpoint after explicit human proof. No credentials are requested or transported.'
    }
  );

  mcp.registerTool(
    'selfish_relay_status',
    {
      title: 'Selfish Relay Status',
      description: 'Read whether the paired local Selfish worker is connected.',
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async () => {
      const connected = devices.has(DEFAULT_DEVICE_ID);
      return {
        content: [{ type: 'text', text: `Selfish relay online; local_worker_connected=${connected}` }],
        structuredContent: {
          status: 'PASS',
          relay_version: VERSION,
          local_worker_connected: connected,
          connected_device_count: devices.size
        }
      };
    }
  );

  mcp.registerTool(
    'selfish_status',
    {
      title: 'Selfish Status',
      description: 'Read local Selfish runtime state without page content.',
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async () => {
      const result = await sendDeviceJob(DEFAULT_DEVICE_ID, 'STATUS', {});
      return {
        content: [{ type: 'text', text: `Selfish state=${result.result?.state ?? result.status}` }],
        structuredContent: result
      };
    }
  );

  mcp.registerTool(
    'selfish_start_continuity_test',
    {
      title: 'Start Selfish Durable Takeover Continuity Test',
      description:
        'Start one bounded Selenium-page continuity task. It performs pre-takeover work, checkpoints, and then requires human takeover. Exact retries reuse the same durable job.',
      inputSchema: z.object({
        request_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
        before_marker: z.string().min(1).max(64).regex(/^[A-Za-z0-9._:-]+$/),
        after_marker: z.string().min(1).max(64).regex(/^[A-Za-z0-9._:-]+$/)
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ request_id, before_marker, after_marker }) => {
      const result = await sendDeviceJob(
        DEFAULT_DEVICE_ID,
        'S7_CONTINUITY_START',
        { request_id, before_marker, after_marker },
        35000
      );
      return {
        content: [{
          type: 'text',
          text:
            result.status === 'TAKEOVER_REQUIRED'
              ? 'Selfish durable task checkpointed; human takeover is required.'
              : `Selfish continuity start ${result.status}`
        }],
        structuredContent: result
      };
    }
  );

  mcp.registerTool(
    'selfish_takeover_privacy_probe',
    {
      title: 'Probe Selfish Takeover Privacy Fence',
      description: 'Read takeover state and preview fence status without reading page DOM or pixels.',
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async () => {
      const result = await sendDeviceJob(DEFAULT_DEVICE_ID, 'TAKEOVER_PRIVACY_PROBE', {}, 10000);
      return { content: [{ type: 'text', text: `Takeover state=${result.result?.state ?? result.status}` }], structuredContent: result };
    }
  );

  mcp.registerTool(
    'selfish_resume_continuity_test',
    {
      title: 'Resume Selfish Durable Takeover Continuity Test',
      description:
        'After the human checks Default checkbox in the visible Selenium page, explicitly resume. The local worker revalidates the same page/session, hides the same browser, and continues the same persisted job from its durable checkpoint.',
      inputSchema: z.object({
        takeover_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/)
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    },
    async ({ takeover_id }) => {
      const result = await sendDeviceJob(
        DEFAULT_DEVICE_ID,
        'S7_CONTINUITY_RESUME',
        { takeover_id },
        40000
      );
      return {
        content: [{
          type: 'text',
          text:
            result.status === 'PASS'
              ? 'Selfish resumed the same durable task from checkpoint.'
              : `Selfish continuity resume ${result.status}`
        }],
        structuredContent: result
      };
    }
  );

  return mcp;
}


const CHATGPT_S8_EXPIRES_AT = '2026-10-21T06:00:00Z';
const CHATGPT_S8_TARGET = 'https://www.selenium.dev/selenium/web/web-form.html';

function buildChatGptS8McpServer() {
  const mcp = new McpServer(
    {
      name: 'Selfish S8 ChatGPT Native Test',
      version: VERSION
    },
    {
      instructions:
        'Temporary bounded S8 endpoint for proving native ChatGPT -> Selfish invocation. It exposes status plus one Selenium-project demo task only. It does not accept arbitrary URLs, selectors, credentials, JavaScript, CDP, shell, cookies, or profile export.'
    }
  );

  mcp.registerTool(
    'selfish_status',
    {
      title: 'Selfish Status',
      description:
        'Read the current state of the paired local Selfish worker. No page content, credentials, cookies, or profile data are returned.',
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => {
      const result = await sendDeviceJob(DEFAULT_DEVICE_ID, 'STATUS', {});
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
    'selfish_run_chatgpt_native_test',
    {
      title: 'Run Selfish ChatGPT Native Browser Test',
      description:
        'Run one bounded browser action sequence on the Selenium project public demo form. This is only for S8 ChatGPT-native invocation testing and cannot access arbitrary sites.',
      inputSchema: z.object({
        request_id: z.string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9._:-]+$/),
        text: z.string().min(1).max(64)
      }).strict(),
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
        'SELENIUM_WEB_FORM',
        {
          request_id,
          target_url: CHATGPT_S8_TARGET,
          text
        },
        30000
      );

      return {
        content: [{
          type: 'text',
          text:
            result.status === 'PASS'
              ? `Selfish native test completed; state=${result.result?.state ?? 'UNKNOWN'}`
              : `Selfish native test ${result.status}: ${result.reason ?? 'unknown'}`
        }],
        structuredContent: result
      };
    }
  );

  return mcp;
}


function buildChatGptS9McpServer() {
  const roleLocator = z.object({
    kind: z.literal('role'),
    role: z.enum(['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox']),
    name: z.string().min(1).max(128)
  }).strict();

  const labelLocator = z.object({
    kind: z.literal('label'),
    name: z.string().min(1).max(128)
  }).strict();

  const textLocator = z.object({
    kind: z.literal('text'),
    text: z.string().min(1).max(256)
  }).strict();

  const readableLocator = z.union([roleLocator, labelLocator, textLocator]);
  const editableLocator = z.union([roleLocator, labelLocator]);

  const readStep = z.discriminatedUnion('action', [
    z.object({ action: z.literal('NAVIGATE') }).strict(),
    z.object({ action: z.literal('READ_TITLE') }).strict(),
    z.object({
      action: z.literal('READ_TEXT'),
      locator: readableLocator,
      max_chars: z.number().int().min(1).max(4096)
    }).strict()
  ]);

  const interactStep = z.discriminatedUnion('action', [
    z.object({ action: z.literal('NAVIGATE') }).strict(),
    z.object({ action: z.literal('READ_TITLE') }).strict(),
    z.object({
      action: z.literal('READ_TEXT'),
      locator: readableLocator,
      max_chars: z.number().int().min(1).max(4096)
    }).strict(),
    z.object({
      action: z.literal('TYPE'),
      locator: editableLocator,
      text: z.string().min(1).max(512)
    }).strict(),
    z.object({
      action: z.literal('CLICK'),
      locator: roleLocator
    }).strict()
  ]);

  const readSecurity = [{ type: 'oauth2', scopes: ['selfish.read'] }];
  const writeSecurity = [{ type: 'oauth2', scopes: ['selfish.write'] }];

  const mcp = new McpServer(
    {
      name: 'Selfish S9 Native Safe Browser',
      version: VERSION
    },
    {
      instructions:
        'Authenticated S9 development bridge for normal ChatGPT conversations. The local Selfish worker executes only public-HTTPS semantic browser primitives and remains authoritative for DNS/IP/redirect policy, dedupe, mismatch blocking, and takeover boundaries. Arbitrary CSS/XPath/JavaScript/CDP/shell and credential/profile export are not exposed.'
    }
  );

  mcp.registerTool(
    'selfish_status',
    {
      title: 'Selfish Status',
      description: 'Read the paired local Selfish worker state.',
      inputSchema: z.object({}).strict(),
      securitySchemes: readSecurity,
      _meta: { securitySchemes: readSecurity },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => {
      const result = await sendDeviceJob(DEFAULT_DEVICE_ID, 'STATUS', {});
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
    'selfish_read_public_https',
    {
      title: 'Read a public HTTPS page with Selfish',
      description:
        'Navigate to a caller-supplied public HTTPS page and perform semantic read operations only. Private/local/metadata destinations and redirect escape are blocked locally.',
      inputSchema: z.object({
        request_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
        target_url: z.string().url().max(512),
        steps: z.array(readStep).min(1).max(8)
      }).strict(),
      securitySchemes: readSecurity,
      _meta: { securitySchemes: readSecurity },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async ({ request_id, target_url, steps }) => {
      const result = await sendDeviceJob(
        DEFAULT_DEVICE_ID,
        'PUBLIC_BROWSER_TASK',
        {
          request_id,
          target_url,
          side_effect_approval: false,
          steps
        },
        40000
      );
      return {
        content: [{
          type: 'text',
          text:
            result.status === 'PASS'
              ? 'Selfish public HTTPS read completed.'
              : `Selfish public HTTPS read ${result.status}: ${result.reason ?? 'unknown'}`
        }],
        structuredContent: result
      };
    }
  );

  mcp.registerTool(
    'selfish_interact_public_https',
    {
      title: 'Interact with a public HTTPS page using Selfish',
      description:
        'Perform a user-approved semantic browser interaction on a caller-supplied public HTTPS page. This may type or click and therefore is a write action. The local worker still blocks private/local destinations, redirect escape, secret fields, MFA/CAPTCHA boundaries, ambiguous semantic targets, and duplicate request mismatches.',
      inputSchema: z.object({
        request_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
        target_url: z.string().url().max(512),
        steps: z.array(interactStep).min(1).max(8)
      }).strict(),
      securitySchemes: writeSecurity,
      _meta: { securitySchemes: writeSecurity },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async ({ request_id, target_url, steps }) => {
      const result = await sendDeviceJob(
        DEFAULT_DEVICE_ID,
        'PUBLIC_BROWSER_TASK',
        {
          request_id,
          target_url,
          side_effect_approval: true,
          steps
        },
        40000
      );
      return {
        content: [{
          type: 'text',
          text:
            result.status === 'PASS'
              ? 'Selfish public HTTPS interaction completed.'
              : `Selfish public HTTPS interaction ${result.status}: ${result.reason ?? 'unknown'}`
        }],
        structuredContent: result
      };
    }
  );

  return mcp;
}

const mcpHandler = createMcpHandler(buildMcpServer);
const nodeMcpHandler = toNodeHandler(mcpHandler);
const devMcpHandler = createMcpHandler(buildDevMcpServer);
const nodeDevMcpHandler = toNodeHandler(devMcpHandler);
const devExecMcpHandler = createMcpHandler(buildDevExecMcpServer);
const nodeDevExecMcpHandler = toNodeHandler(devExecMcpHandler);
const devWebMcpHandler = createMcpHandler(buildDevWebMcpServer);
const nodeDevWebMcpHandler = toNodeHandler(devWebMcpHandler);
const devPrimitiveMcpHandler = createMcpHandler(buildDevPrimitiveMcpServer);
const nodeDevPrimitiveMcpHandler = toNodeHandler(devPrimitiveMcpHandler);
const devPublicMcpHandler = createMcpHandler(buildDevPublicMcpServer);
const nodeDevPublicMcpHandler = toNodeHandler(devPublicMcpHandler);
const devTakeoverMcpHandler = createMcpHandler(buildDevTakeoverMcpServer);
const nodeDevTakeoverMcpHandler = toNodeHandler(devTakeoverMcpHandler);
const devContinuityMcpHandler = createMcpHandler(buildDevContinuityMcpServer);
const nodeDevContinuityMcpHandler = toNodeHandler(devContinuityMcpHandler);
const chatGptS8McpHandler = createMcpHandler(buildChatGptS8McpServer);
const nodeChatGptS8McpHandler = toNodeHandler(chatGptS8McpHandler);

const chatGptS9McpHandler = createMcpHandler(buildChatGptS9McpServer);
const nodeChatGptS9McpHandler = toNodeHandler(chatGptS9McpHandler);

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

  if (url.pathname === '/mcp-dev') {
    void nodeDevMcpHandler(req, res);
    return;
  }

  if (url.pathname === '/mcp-dev-exec') {
    if (!authorizeDevExec(req)) {
      res.writeHead(401, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      });
      res.end(JSON.stringify({ error: 'UNAUTHORIZED_DEV_EXEC' }));
      return;
    }
    void nodeDevExecMcpHandler(req, res);
    return;
  }

  if (url.pathname === '/mcp-dev-web') {
    if (!authorizeDevExec(req)) {
      res.writeHead(401, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      });
      res.end(JSON.stringify({ error: 'UNAUTHORIZED_DEV_WEB' }));
      return;
    }
    void nodeDevWebMcpHandler(req, res);
    return;
  }

  if (url.pathname === '/mcp-dev-primitives') {
    if (!authorizeDevExec(req)) {
      res.writeHead(401, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      });
      res.end(JSON.stringify({ error: 'UNAUTHORIZED_DEV_PRIMITIVES' }));
      return;
    }
    void nodeDevPrimitiveMcpHandler(req, res);
    return;
  }

  if (url.pathname === '/mcp-dev-public') {
    if (!authorizeDevExec(req)) {
      res.writeHead(401, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      });
      res.end(JSON.stringify({ error: 'UNAUTHORIZED_DEV_PUBLIC' }));
      return;
    }
    void nodeDevPublicMcpHandler(req, res);
    return;
  }

  if (url.pathname === '/mcp-dev-takeover') {
    if (!authorizeDevExec(req)) {
      res.writeHead(401, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      });
      res.end(JSON.stringify({ error: 'UNAUTHORIZED_DEV_TAKEOVER' }));
      return;
    }
    void nodeDevTakeoverMcpHandler(req, res);
    return;
  }

  if (url.pathname === '/mcp-dev-continuity') {
    if (!authorizeDevExec(req)) {
      res.writeHead(401, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      });
      res.end(JSON.stringify({ error: 'UNAUTHORIZED_DEV_CONTINUITY' }));
      return;
    }
    void nodeDevContinuityMcpHandler(req, res);
    return;
  }

  if (url.pathname === '/s5-redirect-private') {
    res.writeHead(302, {
      location: 'https://127.0.0.1/',
      'cache-control': 'no-store'
    });
    res.end();
    return;
  }


  if (
    url.pathname === '/.well-known/oauth-protected-resource' ||
    url.pathname === '/.well-known/oauth-protected-resource/mcp-chatgpt-s9'
  ) {
    writeJson(res, 200, {
      resource: S9_RESOURCE,
      authorization_servers: [PUBLIC_BASE_URL],
      scopes_supported: S9_SCOPES,
      bearer_methods_supported: ['header']
    });
    return;
  }

  if (
    url.pathname === '/.well-known/oauth-authorization-server' ||
    url.pathname === '/.well-known/openid-configuration'
  ) {
    writeJson(res, 200, {
      issuer: PUBLIC_BASE_URL,
      authorization_endpoint: `${PUBLIC_BASE_URL}/oauth/authorize`,
      token_endpoint: `${PUBLIC_BASE_URL}/oauth/token`,
      registration_endpoint: `${PUBLIC_BASE_URL}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: S9_SCOPES,
      resource_indicators_supported: true
    });
    return;
  }

  if (url.pathname === '/oauth/register' && req.method === 'POST') {
    void handleS9DynamicRegistration(req, res);
    return;
  }

  if (url.pathname === '/oauth/authorize' && req.method === 'GET') {
    void handleS9Authorize(req, res, url);
    return;
  }

  if (url.pathname === '/oauth/token' && req.method === 'POST') {
    void handleS9Token(req, res);
    return;
  }

  if (url.pathname === S9_MCP_PATH) {
    const access = s9AccessFromRequest(req);
    if (!access) {
      res.writeHead(401, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'www-authenticate':
          `Bearer resource_metadata="${S9_PROTECTED_RESOURCE_METADATA}", error="invalid_token", error_description="Connect Selfish S9 to continue"`
      });
      res.end(JSON.stringify({ error: 'S9_OAUTH_REQUIRED' }));
      return;
    }
    void nodeChatGptS9McpHandler(req, res);
    return;
  }

  if (url.pathname === '/mcp-chatgpt-s8') {
    if (Date.now() >= Date.parse(CHATGPT_S8_EXPIRES_AT)) {
      res.writeHead(410, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
      });
      res.end(JSON.stringify({ error: 'S8_DEV_ENDPOINT_EXPIRED' }));
      return;
    }
    void nodeChatGptS8McpHandler(req, res);
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
