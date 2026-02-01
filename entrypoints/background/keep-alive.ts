// Keep background script alive during long-running operations
const ALARM_NAME = 'keep-alive';
const ALARM_PERIOD_MINUTES = 0.4; // 24 seconds (< 30s suspension threshold)

let isKeepAliveActive = false;

export async function startKeepAlive(): Promise<void> {
  if (isKeepAliveActive) return;

  isKeepAliveActive = true;
  console.log('[Keep-Alive] Starting keep-alive alarm');

  // Create recurring alarm
  await browser.alarms.create(ALARM_NAME, {
    periodInMinutes: ALARM_PERIOD_MINUTES,
  });
}

export async function stopKeepAlive(): Promise<void> {
  if (!isKeepAliveActive) return;

  isKeepAliveActive = false;
  console.log('[Keep-Alive] Stopping keep-alive alarm');

  await browser.alarms.clear(ALARM_NAME);
}

export function initKeepAliveListener(): void {
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) {
      // This callback being triggered keeps the background script alive
      console.log('[Keep-Alive] Heartbeat at', new Date().toISOString());
    }
  });
}
