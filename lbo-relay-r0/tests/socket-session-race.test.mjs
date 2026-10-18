import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

function harness() {
  const source = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
  const begin = source.indexOf('function resolvePending(');
  const end = source.indexOf('function buildMcpServer(', begin);
  const conn = source.indexOf("wss.on('connection', (ws) => {");
  const listen = source.indexOf('\nserver.listen(PORT', conn);
  assert(begin >= 0 && end > begin && conn >= 0 && listen > conn, 'source anchors missing');
  let counter = 0;
  const state = {
    pending: new Map(),
    devices: new Map(),
    wss: new EventEmitter(),
    crypto: {randomUUID: () => 'req-' + (++counter)},
    VERSION: 'test',
    nowIso: () => '2026-10-18T00:00:00Z',
    console: {log: () => {}},
    setTimeout, clearTimeout,
  };
  createContext(state);
  runInContext(
    source.slice(begin, end) + '\n' + source.slice(conn, listen) +
      '\nglobalThis.sendJob = sendDeviceJob;',
    state,
  );
  return state;
}

class MockSocket extends EventEmitter {
  constructor(deviceId = 'd') {
    super();
    this.selfishDeviceId = deviceId;
    this.readyState = 1;
    this.sent = [];
  }
  send(text) { this.sent.push(JSON.parse(text)); }
  close() { this.readyState = 3; this.emit('close'); }
  deliver(requestId, value) {
    this.emit('message', Buffer.from(JSON.stringify({
      type: 'result', request_id: requestId, status: value,
    })));
  }
}
function connect(state, socket) { state.wss.emit('connection', socket); }

test('replaced socket does not cancel new connection pending request', async () => {
  const state = harness();
  const oldSocket = new MockSocket();
  const newSocket = new MockSocket();
  connect(state, oldSocket);
  const oldJob = state.sendJob('d', 'CLICK', {}, 1500);
  const oldId = oldSocket.sent[0].request_id;
  connect(state, newSocket);
  const oldResult = await oldJob;
  assert.equal(oldResult.status, 'DEVICE_DISCONNECTED');
  assert.equal(oldResult.reason, 'websocket_replaced');
  const newJob = state.sendJob('d', 'READ_TITLE', {}, 1500);
  const newId = newSocket.sent[0].request_id;
  oldSocket.emit('close');
  assert.equal(state.pending.has(newId), true);
  assert.equal(state.pending.has(oldId), false);
  newSocket.deliver(newId, 'PASS');
  assert.equal((await newJob).status, 'PASS');
  assert.equal(state.pending.size, 0);
});

test('stale socket cannot return a result for another socket', async () => {
  const state = harness();
  const oldSocket = new MockSocket();
  const newSocket = new MockSocket();
  connect(state, oldSocket);
  connect(state, newSocket);
  const job = state.sendJob('d', 'READ_TITLE', {}, 1500);
  const id = newSocket.sent[0].request_id;
  oldSocket.deliver(id, 'FAKE');
  assert.equal(state.pending.has(id), true);
  newSocket.deliver(id, 'PASS');
  assert.equal((await job).status, 'PASS');
});

test('closing active socket resolves only its outstanding requests', async () => {
  const state = harness();
  const socket = new MockSocket();
  connect(state, socket);
  const one = state.sendJob('d', 'CLICK', {}, 1500);
  const two = state.sendJob('d', 'READ_TITLE', {}, 1500);
  socket.close();
  assert.equal((await one).status, 'DEVICE_DISCONNECTED');
  assert.equal((await two).status, 'DEVICE_DISCONNECTED');
  assert.equal(state.pending.size, 0);
  assert.equal(state.devices.has('d'), false);
});

test('in-flight write is not resent when a socket is replaced', async () => {
  const state = harness();
  const oldSocket = new MockSocket();
  const newSocket = new MockSocket();
  connect(state, oldSocket);
  const job = state.sendJob('d', 'CLICK', {action:'SUBMIT'}, 1500);
  assert.equal(oldSocket.sent.length, 1);
  connect(state, newSocket);
  assert.equal((await job).reason, 'websocket_replaced');
  assert.equal(newSocket.sent.length, 0);
});

test('pending operations for separate devices remain isolated', async () => {
  const state = harness();
  const socketA = new MockSocket('one');
  const socketB = new MockSocket('two');
  connect(state, socketA);
  connect(state, socketB);
  const jobA = state.sendJob('one', 'READ_TITLE', {}, 1500);
  const jobB = state.sendJob('two', 'READ_TITLE', {}, 1500);
  socketA.close();
  assert.equal((await jobA).status, 'DEVICE_DISCONNECTED');
  socketB.deliver(socketB.sent[0].request_id, 'PASS');
  assert.equal((await jobB).status, 'PASS');
});
