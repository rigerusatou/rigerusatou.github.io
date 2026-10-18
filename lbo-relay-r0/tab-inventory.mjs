import crypto from 'node:crypto';
import {canonicalOrdinaryUrl} from './ordinary-bridge.mjs';

// S9-compatible, read-only tab listing through the existing READ_TEXT tool.
// The sentinel URL is never loaded in a browser. The user must have a paired worker.
export const TAB_INVENTORY_URL = 'https://lbo-relay-r0.onrender.com/';
const NAME_RE = /^SELFISH_TAB_LIST_CHUNK_([0-9]{3})$/;
const ID_RE = /^tabs:[A-Za-z0-9._-]{8,80}$/;
const MAX_CHUNK_CHARS = 1900;
const MAX_ENTRIES_PER_CHUNK = 8;
const MAX_TABS = 100;
const blocked = (reason) => ({status: 'BLOCKED', reason});
const clean = (value, limit) => String(value ?? '').replace(/[\x00-\x1f\x7f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);

export async function routeTabInventoryRead({request_id, target_url, steps, sendDeviceJob, deviceId}) {
  if (typeof request_id !== 'string' || !request_id.startsWith('tabs:')) return null;
  if (!ID_RE.test(request_id)) return blocked('INVALID_TAB_INVENTORY_REQUEST_ID');
  if (target_url !== TAB_INVENTORY_URL) return blocked('TAB_INVENTORY_REQUIRES_FIXED_URL');
  if (!Array.isArray(steps) || steps.length !== 1) return blocked('TAB_INVENTORY_READ_ONLY_STEP_REQUIRED');
  const step = steps[0];
  if (step?.action !== 'READ_TEXT' || step.locator?.kind !== 'role' || step.locator?.role !== 'link' || step.max_chars !== 2048)
    return blocked('TAB_INVENTORY_READ_ONLY_STEP_REQUIRED');
  const match = NAME_RE.exec(step.locator.name || '');
  if (!match) return blocked('INVALID_TAB_INVENTORY_LOCATOR');
  const index = Number(match[1]);

  let response;
  try {response = await sendDeviceJob(deviceId, 'NORMAL_TABS_SNAPSHOT', {limit: MAX_TABS}, 15000);}
  catch {return {status: 'DEVICE_DISCONNECTED', reason: 'TAB_INVENTORY_SNAPSHOT_JOB_FAILED'};}
  if (response?.status !== 'PASS') return response || blocked('TAB_INVENTORY_SNAPSHOT_FAILED');
  const data = response.result;
  if (data?.source !== 'LIVE_EXISTING_BRAVE_EXTENSION_SNAPSHOT' ||
      !Number.isFinite(data?.age_seconds) || data.age_seconds > 10 ||
      !Array.isArray(data.tabs) || data.truncated || data.tabs.length > MAX_TABS)
    return blocked('TAB_INVENTORY_REQUIRES_FRESH_COMPLETE_SNAPSHOT');

  const tabs = data.tabs.flatMap(t => {
    if (!Number.isSafeInteger(t?.id) || t.id <= 0 || typeof t?.url !== 'string') return [];
    const url = canonicalOrdinaryUrl(t.url);
    if (!url || url.length > 512) return []; // keep target_url valid for S9 calls
    return [{tab_id: t.id, title: clean(t.title, 96), url, active: t.active === true}];
  });
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(tabs)).digest('hex').slice(0, 16);
  // Variable-size pages keep each tab line intact while respecting the existing 2048-char cap.
  const pages = [];
  let lines = [];
  let size = 0;
  for (const tab of tabs) {
    const line = `${tab.tab_id} | ${tab.active ? 'ACTIVE' : 'TAB'} | ${tab.title} | ${tab.url}`;
    if (lines.length && (size + 1 + line.length > MAX_CHUNK_CHARS || lines.length >= MAX_ENTRIES_PER_CHUNK)) {
      pages.push(lines.join('\n'));
      lines = []; size = 0;
    }
    size += line.length + (lines.length ? 1 : 0);
    lines.push(line);
  }
  if (lines.length) pages.push(lines.join('\n'));
  const value = pages[index] || '';
  const next = index + 1 < pages.length ? index + 1 : null;
  return {
    status: 'PASS',
    result: {
      request_id, state: 'COMPLETED', route: 'EXISTING_BRAVE_TAB_INVENTORY',
      read_only: true, source: data.source, age_seconds: data.age_seconds,
      received_at: data.received_at, snapshot_fingerprint: fingerprint,
      eligible_tabs: tabs.length, all_tabs_count: data.count,
      step_results: [{index: 0, action: 'READ_TEXT', pass: true,
        value, source: 'EXISTING_BRAVE_TAB_LIST', chunk_index: index,
        next_chunk: next, truncated: next !== null}]
    }
  };
}
