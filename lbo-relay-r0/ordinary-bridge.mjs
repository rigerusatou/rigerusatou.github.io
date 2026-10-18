/** S9 ordinary Brave tab adapter. Explicit opt-in via ordinary:<tab id>:<nonce> request ID. */
const ORDINARY_PREFIX = 'ordinary:';
const REQUEST_PATTERN = /^ordinary:([0-9]{1,12}):(repeat-)?([A-Za-z0-9._-]{8,80})$/;
const blocked = (reason) => ({status: 'BLOCKED', reason});

export function parseOrdinaryRequest(requestId) {
  if (typeof requestId !== 'string' || !requestId.startsWith(ORDINARY_PREFIX)) return null;
  const match = REQUEST_PATTERN.exec(requestId);
  if (!match) return {invalid: true};
  const tabId = Number(match[1]);
  if (!Number.isSafeInteger(tabId) || tabId <= 0) return {invalid: true};
  return {tabId, intentionalRepeat: Boolean(match[2])};
}

export function canonicalOrdinaryUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    return parsed.origin + parsed.pathname;
  } catch { return null; }
}

export async function routeOrdinaryTabTask({request_id, target_url, steps, allowWrites, sendDeviceJob, deviceId}) {
  const request = parseOrdinaryRequest(request_id);
  if (!request) return null; // preserve exact existing S9 public browser behavior
  if (request.invalid) return blocked('INVALID_ORDINARY_REQUEST_ID');
  const canonical = canonicalOrdinaryUrl(target_url);
  if (!canonical) return blocked('ORDINARY_TAB_REQUIRES_HTTPS_URL');
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > 8) return blocked('INVALID_STEPS');
  if (steps.some(s => s.action === 'NAVIGATE')) return blocked('ORDINARY_TAB_NAVIGATE_NOT_SUPPORTED');
  if (steps.some(s => s.locator?.kind === 'text')) return blocked('ORDINARY_TAB_TEXT_LOCATOR_NOT_SUPPORTED');
  if (!allowWrites && steps.some(s => s.action === 'TYPE' || s.action === 'CLICK')) return blocked('WRITE_TOOL_REQUIRED');
  try {
    const snapshot = await sendDeviceJob(deviceId, 'NORMAL_TABS_SNAPSHOT', {limit: 100}, 15000);
    if (snapshot.status !== 'PASS') return blocked('ORDINARY_TABS_SNAPSHOT_FAILED');
    const info = snapshot.result;
    if (!info || info.source !== 'LIVE_EXISTING_BRAVE_EXTENSION_SNAPSHOT' ||
        !Number.isFinite(info.age_seconds) || info.age_seconds > 10 || info.truncated || !Array.isArray(info.tabs)) {
      return blocked('ORDINARY_TABS_FRESH_SNAPSHOT_REQUIRED');
    }
    const selected = info.tabs.filter(t => t.id === request.tabId);
    if (selected.length !== 1) return blocked('ORDINARY_TAB_NOT_FOUND');
    if (selected[0].url !== canonical) return blocked('ORDINARY_TAB_URL_MISMATCH');
    const response = await sendDeviceJob(deviceId, 'NORMAL_TAB_ACTION', {
      request_id, tab_id: request.tabId, side_effect_approval: allowWrites,
      intentional_repeat: request.intentionalRepeat, steps
    }, 40000);
    return {
      ...response,
      result: {
        ...((response && typeof response.result === 'object' && response.result !== null) ? response.result : {}),
        route: 'ORDINARY_BRAVE_EXISTING_TAB', tab_id: request.tabId
      }
    };
  } catch { return {status:'FAILED', reason:'ORDINARY_TAB_ROUTE_ERROR'}; }
}
