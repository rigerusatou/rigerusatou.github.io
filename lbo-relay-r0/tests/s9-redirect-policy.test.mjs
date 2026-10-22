import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const source = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const a = source.indexOf("const S9_CLAUDE_REDIRECT_URI");
const b = source.indexOf('function s9ScopeAllowed(');
assert.ok(a >= 0 && b > a, 'redirect policy anchor missing');
const env = { URL };
createContext(env);
runInContext(source.slice(a, b) + '\nglobalThis.allow=s9AllowedRedirectUri;globalThis.label=s9ClientLabel;', env);

test('Claude hosted callback is accepted', () => {
  assert.equal(env.allow('https://claude.ai/api/mcp/auth_callback'), true);
  assert.equal(env.label('https://claude.ai/api/mcp/auth_callback'), 'Claude');
});
test('existing ChatGPT callbacks still accepted', () => {
  assert.equal(env.allow('https://chatgpt.com/connector_platform_oauth_redirect'), true);
  assert.equal(env.allow('https://chatgpt.com/connector/oauth/abc'), true);
});
test('lookalike or widened Claude callbacks are rejected', () => {
  for (const u of [
    'http://claude.ai/api/mcp/auth_callback',
    'https://claude.ai/api/mcp/auth_callback/x',
    'https://claude.ai/api/mcp/auth_callback?x=1',
    'https://claude.ai:8443/api/mcp/auth_callback',
    'https://evil@claude.ai/api/mcp/auth_callback',
    'https://claude.ai.evil.com/api/mcp/auth_callback',
    'https://evil.claude.ai/api/mcp/auth_callback',
    'https://claude.ai/other',
    'http://localhost:3118/callback',
    'not a url'
  ]) assert.equal(env.allow(u), false, u);
});
