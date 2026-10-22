import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const source = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const a = source.indexOf('const S9_RESULT_TEXT_MAX');
const b = source.indexOf('function s9ScopeAllowed(');
assert.ok(a >= 0 && b > a, 'helper anchor missing');
const env = {};
createContext(env);
runInContext(source.slice(a, b) + '\nglobalThis.block=s9ResultTextBlock;', env);

test('page text reaches the text content block', () => {
  const r = { status: 'PASS', result: { step_results: [{ action: 'READ_TITLE', value: 'Example Domain' }] } };
  const blk = env.block(r);
  assert.equal(blk.type, 'text');
  assert.deepEqual(JSON.parse(blk.text), r);
});
test('oversized results are truncated with a marker', () => {
  const blk = env.block({ v: 'x'.repeat(70000) });
  assert.ok(blk.text.length < 60200);
  assert.match(blk.text, /TRUNCATED/);
});
test('every S9 tool reply carries the result text block', () => {
  const s9 = source.slice(source.indexOf('Authenticated S9 development bridge'), source.indexOf('const mcpHandler = createMcpHandler(buildMcpServer);'));
  assert.equal((s9.match(/s9ResultTextBlock\(result\)/g) || []).length, 4);
});
