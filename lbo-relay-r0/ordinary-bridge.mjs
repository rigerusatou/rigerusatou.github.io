/** S9 ordinary Brave tab adapter. Explicit opt-in via ordinary:<tab id>:<nonce> request ID. */
const ORDINARY_PREFIX = 'ordinary:';
const REQUEST_PATTERN = /^ordinary:([0-9]{1,12}):(repeat-)?([A-Za-z0-9._-]{8,80})$/;
const blocked = (reason, extras = {}) => ({status: 'BLOCKED', reason, ...extras});
const RECOVERY = 'BOUNDED_READ_ONLY_RESILIENCE_V1';
const pauseDefault = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const SNAPSHOT_ATTEMPTS = 2;
const READ_ATTEMPTS = 2;
const TRANSIENT_EXTENSION_REASONS = /^(TAB_SNAPSHOT_REFRESH_TIMEOUT|TAB_SNAPSHOT_REFRESH_SEND_FAILED|EXTENSION_TAB_QUERY_FAILED|EXTENSION_DISCONNECTED|EXTENSION_TIMEOUT|EXTENSION_SEND_FAILED|EXISTING_BRAVE_EXTENSION_OFFLINE|INJECTION_FAILED|PAGE_NOT_READY|TAB_NOT_READY|PAGE_LOADING|TRANSIENT_DOCUMENT_ERROR)(?:[:\s]|$)/;

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

function transientSnapshotStatus(value) {
  return ['DEVICE_OFFLINE', 'DEVICE_DISCONNECTED', 'TIMEOUT'].includes(value?.status) ||
    ((value?.status === 'FAILED' || value?.status === 'BLOCKED') &&
      TRANSIENT_EXTENSION_REASONS.test(String(value.reason || value.result?.reason || ''))) ||
    (value?.status === 'PASS' &&
      (value.result?.source !== 'LIVE_EXISTING_BRAVE_EXTENSION_SNAPSHOT' ||
       !Number.isFinite(value.result?.age_seconds) || value.result.age_seconds > 10));
}

function actionableResponse(response, tabId) {
  return {
    ...response,
    result: {
      ...((response && typeof response.result === 'object' && response.result !== null) ? response.result : {}),
      route: 'ORDINARY_BRAVE_EXISTING_TAB', tab_id: tabId
    }
  };
}

function canRetryRead(response) {
  if (!response || response.status === 'PASS' || response.status === 'BLOCKED') return false;
  if (['DEVICE_OFFLINE', 'DEVICE_DISCONNECTED', 'TIMEOUT'].includes(response.status)) return true;
  if (response.status !== 'FAILED') return false;
  const reason = String(response.reason || response.result?.reason || '');
  return TRANSIENT_EXTENSION_REASONS.test(reason);
}

function uncertainWriteResult(response, requestId, tabId) {
  // A failed multi-step write may have partially executed even if the bridge
  // reported an explicit failure. Never imply a safe automatic replay.
  if (response?.status === 'PASS' || response?.status === 'BLOCKED') return actionableResponse(response, tabId);
  return actionableResponse({
    status: 'UNCERTAIN',
    reason: 'WRITE_OUTCOME_UNKNOWN_NO_AUTO_RETRY',
    original_status: response?.status || 'UNKNOWN',
    original_reason: String(response?.reason || response?.result?.reason || '').slice(0, 160),
    request_id: requestId,
    retry_safe: false,
    operator_action: 'INSPECT_EXISTING_TAB_BEFORE_ANY_NEW_WRITE'
  }, tabId);
}

/**
 * Snapshot retries are safe because no tab action has been dispatched.
 * A read-only action may be retried once after URL and tab-ID revalidation.
 * TYPE or CLICK steps are never retried after dispatch, even on lost acknowledgments.
 */
export async function routeOrdinaryTabTask({
  request_id, target_url, steps, allowWrites, sendDeviceJob, deviceId,
  pause = pauseDefault
}) {
  const request = parseOrdinaryRequest(request_id);
  if (!request) return null; // preserve exact existing S9 public browser behavior
  if (request.invalid) return blocked('INVALID_ORDINARY_REQUEST_ID');
  const canonical = canonicalOrdinaryUrl(target_url);
  if (!canonical) return blocked('ORDINARY_TAB_REQUIRES_HTTPS_URL');
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > 8) return blocked('INVALID_STEPS');
  if (steps.some(s => s.action === 'NAVIGATE')) return blocked('ORDINARY_TAB_NAVIGATE_NOT_SUPPORTED');
  if (steps.some(s => s.locator?.kind === 'text')) return blocked('ORDINARY_TAB_TEXT_LOCATOR_NOT_SUPPORTED');
  const hasWrite = steps.some(s => s.action === 'TYPE' || s.action === 'CLICK');
  if (!allowWrites && hasWrite) return blocked('WRITE_TOOL_REQUIRED');
  const readOnly = !hasWrite;
  const safeJob = async (operation, input, timeoutMs) => {
    try { return await sendDeviceJob(deviceId, operation, input, timeoutMs); }
    catch { return {status: 'DEVICE_DISCONNECTED', reason: 'DEVICE_JOB_ERROR'}; }
  };

  const checkedSnapshot = async () => {
    let last = 'ORDINARY_TABS_SNAPSHOT_FAILED';
    for (let attempt = 1; attempt <= SNAPSHOT_ATTEMPTS; attempt++) {
      const snapshot = await safeJob('NORMAL_TABS_SNAPSHOT', {limit: 100}, 8000);
      if (snapshot?.status === 'PASS') {
        const info = snapshot.result;
        if (info?.source === 'LIVE_EXISTING_BRAVE_EXTENSION_SNAPSHOT' &&
            Number.isFinite(info.age_seconds) && info.age_seconds <= 10 &&
            !info.truncated && Array.isArray(info.tabs)) {
          const selected = info.tabs.filter(t => t.id === request.tabId);
          if (selected.length !== 1) return blocked('ORDINARY_TAB_NOT_FOUND');
          if (selected[0].url !== canonical) return blocked('ORDINARY_TAB_URL_MISMATCH');
          return {status: 'PASS'};
        }
        last = 'ORDINARY_TABS_FRESH_SNAPSHOT_REQUIRED';
      } else {
        last = 'ORDINARY_TABS_SNAPSHOT_FAILED';
      }
      if (attempt === SNAPSHOT_ATTEMPTS || !transientSnapshotStatus(snapshot)) break;
      await pause(250);
    }
    return blocked(last, {recovery_hint: 'CHECK_EXTENSION_CONNECTION_AND_TAB_STATE'});
  };

  const maxActionAttempts = readOnly ? READ_ATTEMPTS : 1;
  for (let actionAttempt = 1; actionAttempt <= maxActionAttempts; actionAttempt++) {
    const preflight = await checkedSnapshot();
    if (preflight.status !== 'PASS') return preflight;
    // The Windows worker caches per-request results for 30 seconds, including
    // failures. Read-only retries need a distinct internal ID to actually rerun.
    // Never change a write request ID after dispatch.
    const localRequestId = actionAttempt === 1 ? request_id : `${request_id}.read_retry_${actionAttempt}`;
    const response = await safeJob('NORMAL_TAB_ACTION', {
      request_id: localRequestId, tab_id: request.tabId, side_effect_approval: allowWrites,
      intentional_repeat: request.intentionalRepeat, steps
    }, 40000);
    if (response?.status === 'PASS') {
      return {...actionableResponse(response, request.tabId), recovery: RECOVERY,
        read_attempts: actionAttempt};
    }
    if (!readOnly) return uncertainWriteResult(response, request_id, request.tabId);
    if (!canRetryRead(response) || actionAttempt === maxActionAttempts) {
      return {...actionableResponse(response, request.tabId), recovery: RECOVERY,
        read_attempts: actionAttempt,
        ...(String(response?.reason || '').startsWith('INJECTION_FAILED')
          ? {recovery_hint: 'RELOAD_EXISTING_TAB_IF_EXTENSION_INJECTION_IS_STALE'} : {})};
    }
    await pause(450);
  }
  return {status: 'FAILED', reason: 'ORDINARY_TAB_UNEXPECTED_RECOVERY_STATE'};
}
