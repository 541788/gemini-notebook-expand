/**
 * 后台服务工作线程：
 *  - 缓存「笔记本 -> 会话列表」，并记下这份列表是否完整
 *  - 需要时开一个后台标签页，让 Gemini 自己把该笔记本的会话列表取回来
 *  - 把结果广播给所有打开着的 Gemini 标签页
 *
 * 完整与否很重要：聊天页只会返回当前这一条会话，笔记本页才返回整个笔记本。
 * 残缺的数据只做合并，不会覆盖已经拿到的完整列表。
 */
const CHANNEL = 'gnex';
const CACHE_PREFIX = 'nb:';
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 完整列表的缓存时长
const FETCH_TIMEOUT_MS = 45 * 1000;
const TEMP_TABS_KEY = 'tempTabs';

const cacheKey = (notebookId) => CACHE_PREFIX + notebookId;

/* ---------------- 缓存 ---------------- */

async function readEntry(notebookId) {
  const key = cacheKey(notebookId);
  const stored = await chrome.storage.local.get(key);
  const entry = stored[key];
  if (!entry || !Array.isArray(entry.chats)) return null;
  return entry;
}

function mergeChats(previous, incoming) {
  const map = new Map();
  for (const chat of previous || []) {
    if (chat && chat.id) map.set(chat.id, chat);
  }
  for (const chat of incoming || []) {
    if (chat && chat.id) map.set(chat.id, chat);
  }
  return [...map.values()];
}

function sortChats(chats) {
  const list = [...chats];
  if (!list.every((chat) => typeof chat.time === 'number')) return list;
  return list.sort((a, b) => b.time - a.time);
}

async function writeEntry(notebookId, chats, complete) {
  const key = cacheKey(notebookId);
  const stored = await chrome.storage.local.get(key);
  const previous = stored[key];
  const previousChats = previous && Array.isArray(previous.chats) ? previous.chats : [];

  // 以笔记本自己的查询结果为准：完整列表覆盖；残缺数据只在还没拿到完整列表时合并。
  // 已经确认过完整列表之后，残缺数据直接丢掉，避免把已经不在笔记本里的旧会话又塞回来。
  let merged;
  if (complete) {
    merged = sortChats(chats);
  } else if (previous && previous.complete) {
    merged = previousChats;
  } else {
    merged = sortChats(mergeChats(previousChats, chats));
  }

  await chrome.storage.local.set({
    [key]: {
      chats: merged,
      complete: complete || !!(previous && previous.complete),
      ts: Date.now(),
    },
  });

  return merged;
}

/* ---------------- 后台标签页 ---------------- */

/**
 * 临时标签页记在 storage.session 里：服务工作线程被回收重启之后，
 * 仍然知道哪个标签页是临时开的、对应哪个笔记本。
 */
async function readTempTabs() {
  const stored = await chrome.storage.session.get(TEMP_TABS_KEY);
  const map = stored[TEMP_TABS_KEY];
  return map && typeof map === 'object' ? map : {};
}

async function writeTempTabs(map) {
  await chrome.storage.session.set({ [TEMP_TABS_KEY]: map });
}

async function rememberTempTab(tabId, notebookId) {
  const map = await readTempTabs();
  map[String(tabId)] = { notebookId, ts: Date.now() };
  await writeTempTabs(map);
}

async function forgetTempTab(tabId) {
  const map = await readTempTabs();
  delete map[String(tabId)];
  await writeTempTabs(map);
}

async function tempTabFor(notebookId) {
  const map = await readTempTabs();
  for (const [tabId, info] of Object.entries(map)) {
    if (info && info.notebookId === notebookId) return Number(tabId);
  }
  return null;
}

async function isTempTab(tabId) {
  const map = await readTempTabs();
  return Object.prototype.hasOwnProperty.call(map, String(tabId));
}

async function closeTempTab(tabId) {
  await forgetTempTab(tabId);
  await chrome.tabs.remove(tabId).catch(() => {});
}

/** 清掉超时没取到数据的临时标签页。 */
async function sweepTempTabs() {
  const map = await readTempTabs();
  const now = Date.now();

  for (const [tabId, info] of Object.entries(map)) {
    if (info && now - (info.ts || 0) < FETCH_TIMEOUT_MS * 2) continue;
    await chrome.tabs.remove(Number(tabId)).catch(() => {});
    await forgetTempTab(tabId);
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  forgetTempTab(tabId).catch(() => {});
});

sweepTempTabs().catch(() => {});

/* ---------------- 广播 ---------------- */

async function broadcast(notebookId, chats, complete, settled) {
  const tabs = await chrome.tabs.query({ url: 'https://gemini.google.com/*' });
  await Promise.all(
    tabs.map((tab) =>
      chrome.tabs
        .sendMessage(tab.id, {
          type: 'GNEX_NOTEBOOK_CHATS',
          notebookId,
          chats,
          complete,
          settled,
        })
        .catch(() => {}),
    ),
  );
}

async function ensureFetch(notebookId, url, sender) {
  // 已经在取这个笔记本了，别重复开标签页。
  if (await tempTabFor(notebookId)) return;

  let tab;
  try {
    const createOptions = { url, active: false };
    if (sender.tab && typeof sender.tab.windowId === 'number') {
      createOptions.windowId = sender.tab.windowId;
    }
    tab = await chrome.tabs.create(createOptions);
  } catch (error) {
    return;
  }

  await rememberTempTab(tab.id, notebookId);

  setTimeout(() => {
    // 超时了就把已经拿到的部分交出去，让页面别一直转圈。
    (async () => {
      const entry = await readEntry(notebookId);
      await broadcast(
        notebookId,
        entry ? entry.chats : [],
        !!(entry && entry.complete),
        true,
      );
      await closeTempTab(tab.id);
    })();
  }, FETCH_TIMEOUT_MS);
}

/* ---------------- 消息 ---------------- */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.channel !== CHANNEL) return;

  // 后台自己开的标签页不需要侧边栏，也不要再去请求，避免来回开标签页。
  if (message.type === 'IS_TEMP_TAB') {
    (async () => {
      const tabId = sender.tab && sender.tab.id;
      sendResponse({ temp: tabId != null && (await isTempTab(tabId)) });
    })();
    return true; // 异步回复
  }

  if (message.type === 'NOTEBOOK_CHATS') {
    (async () => {
      const { notebookId, chats, complete, settled } = message;
      if (!notebookId || !Array.isArray(chats)) return;
      if (!chats.length && !complete) return;

      await writeEntry(notebookId, chats, !!complete);

      const entry = await readEntry(notebookId);
      await broadcast(
        notebookId,
        entry ? entry.chats : chats,
        !!(entry && entry.complete),
        !!settled,
      );

      // 只有拿到完整列表了，后台标签页的任务才算完成。
      const senderTabId = sender.tab && sender.tab.id;
      if (complete && senderTabId != null && (await isTempTab(senderTabId))) {
        await closeTempTab(senderTabId);
      }
    })();
    return true; // 异步回复
  }

  if (message.type === 'REQUEST_NOTEBOOK') {
    (async () => {
      const { notebookId, url } = message;
      const entry = await readEntry(notebookId);
      const fresh = entry && Date.now() - (entry.ts || 0) < CACHE_TTL_MS;
      const complete = !!(entry && entry.complete);

      if (complete && fresh) {
        sendResponse({ chats: entry.chats, complete: true });
        return;
      }

      // 先把已经知道的部分回给页面，同时后台去取完整列表。
      sendResponse({ chats: entry ? entry.chats : [], complete });

      await ensureFetch(notebookId, url, sender);
    })();
    return true; // 异步回复
  }
});
