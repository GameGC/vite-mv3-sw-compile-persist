import Browser from 'webextension-polyfill';
import { r2Exists, r2Put } from '@utils/R2StorageService.ts';
import { SendPushNotificationData } from '@utils/ApiInteraction.ts';
import JobFilter from '@utils/filters/JobFilter.ts';
import { loadPlatforms } from '@shared/platforms';
import BgPlatform from '@shared/BgPlatform.ts';
import { extractSalary, formatSalary } from '@utils/filters/salaryExtractor.ts';
import { kvPut } from '@utils/KVStorageService.ts';

let queue: BgPlatform[] = [];
let isProcessing = false;
let processTimeout: ReturnType<typeof setTimeout> | null = null;
const MAX_PROCESS_TIME_MS = 5 * 60 * 1000; // 5 minutes max per scrape

Browser.runtime.onInstalled.addListener(async () => {
  await setupContextMenu();
  await openTabs();
});

Browser.runtime.onStartup.addListener(async () => {
  await openTabs();
});

async function openTabs(): Promise<void> {
  await Browser.alarms.clearAll();
  queue = [];
  isProcessing = false;

  let first: boolean = true;
  let tabs: Record<string, number> = {};

  for (let platform of await loadPlatforms()) {
    if (!platform.turnedOn) continue;

    if (first) {
      isProcessing = true;
      tabs[platform.tabKey] = await refreshTab(platform, first);
      first = false;
    } else queue.push(platform);

    await Browser.alarms.create(`refresh-${platform.id}`, {
      periodInMinutes: platform.refreshRate,
    });
  }

  await Browser.storage.local.set(tabs);
  await Browser.alarms.create('clear-cache-alarm', {
    periodInMinutes: 720,
  });
}

Browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name.startsWith('refresh-')) {
    const platformId = alarm.name.replace('refresh-', '');
    let platforms = await loadPlatforms();
    if (platforms.length === 0) {
      platforms = await loadPlatforms();
    }
    const platform = platforms.find((p) => p.id === platformId);
    if (platform && platform.turnedOn) {
      if (!queue.find((p) => p.id === platform.id)) {
        queue.push(platform);
        processQueue();
      }
    }
  } else if (alarm.name === 'clear-cache-alarm') {
    autoClearCacheAndHistory();
  }
});

async function processQueue(): Promise<void> {
  if (isProcessing || queue.length === 0) return;

  isProcessing = true;
  const platform = queue.shift()!;
  let tabs: Record<string, number> = {};
  try {
    tabs[platform.tabKey] = await refreshTab(platform, true);
    processTimeout = setTimeout(() => {
      unlockQueue();
    }, MAX_PROCESS_TIME_MS);
    await Browser.storage.local.set(tabs);
  } catch (error) {
    unlockQueue();
  }
}

function unlockQueue(): void {
  if (processTimeout) {
    clearTimeout(processTimeout);
    processTimeout = null;
  }
  isProcessing = false;
  setTimeout(() => {
    processQueue();
  }, 5000);
}

async function refreshTab(platform: BgPlatform, active: boolean): Promise<number> {
  const tabId = (await Browser.storage.local.get(platform.tabKey))[platform.tabKey] as number;
  try {
    await Browser.tabs.get(tabId);
    if (platform.refreshType === "soft") {
      await Browser.tabs.update(tabId, { url: platform.url, active: active });
    } else {
      await Browser.tabs.remove(tabId);
      await new Promise(r => setTimeout(r, 300));
      const tab = await Browser.tabs.create({ url: platform.url, active: active });
      await Browser.storage.local.set({ [platform.tabKey]: tab.id });
      return tab.id!;
    }
    return tabId;
  } catch (e) {
    const tab = await Browser.tabs.create({ url: platform.url, active });
    await Browser.storage.local.set({ [platform.tabKey]: tab.id });
    return tab.id!;
  }
}

Browser.runtime.onMessage.addListener((msg: unknown) => {
  const message = msg as { type: string; jobs?: unknown; url?: string; site: any };

  if (message.type === 'SAVE_JOBS') {
    return (async () => {
      await saveJobsToR2(message.jobs ?? []);
    })();
  }

  if (message.type === 'SCRAPE_DONE') {
    isProcessing = false;
    unlockQueue();
    return;
  }

  if (message.type === 'CHALLENGE_DETECTED') {
    Browser.notifications.create({
      type: 'basic',
      iconUrl: 'icon.png',
      title: '⚠️ Action Required',
      message: 'CAPTCHA or 2FA detected — please check the active tab.',
    });
  }
});

// Helper stubs for extension functions
async function setupContextMenu(): Promise<void> {}
function autoClearCacheAndHistory(): void {}
async function saveJobsToR2(_jobs: any): Promise<void> {}
