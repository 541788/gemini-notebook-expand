/**
 * 内容脚本：给侧边栏的每个笔记本加一个展开按钮，并把笔记本内的会话
 * 以嵌套列表的形式渲染在它下面。
 *
 * 会话数据有两种：
 *  - 页面自己请求到的，可能只有当前这一条（聊天页就是这样）；
 *  - 后台打开笔记本页拿到的，是该笔记本的完整列表。
 * 数据里带 complete 标记，残缺的数据不会覆盖已经拿到的完整列表。
 */
(() => {
  const CHANNEL = 'gnex';
  const EVENT_NAME = 'gnex:notebook-chats';
  const NAVIGATE_EVENT = 'gnex:navigate-chat';
  const NOTEBOOK_PATH = /\/notebook\/([^/?#]+)/;
  const SYNC_DELAY_MS = 250;
  const EXPANDED_KEY = 'expandedNotebooks';

  const expanded = new Set();
  const containers = new Map(); // 笔记本 id -> 列表容器
  const mounted = new Map(); // 笔记本 id -> { item, button }
  const states = new Map(); // 笔记本 id -> { chats: Map<id, chat>, complete: boolean }

  let syncTimer = null;
  let isTempTab = true; // 在问过后台之前，先不动侧边栏

  /* ---------------- 小工具 ---------------- */

  /**
   * Gemini 页面启用了 Trusted Types，innerHTML 会被直接拒绝，
   * 所以这里用 DOM API 拼图标。
   */
  const createChevron = () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', 'M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z');
    svg.appendChild(path);

    return svg;
  };

  const hint = (text) => {
    const span = document.createElement('span');
    span.className = 'gnex-hint';
    span.textContent = text;
    return span;
  };

  /**
   * 当前账号前缀，例如 /u/1。
   * Gemini 把账号放在 <base href> 和页面路径里，两处都看一下。
   * 侧边栏的笔记本链接本身是 /notebook/<id>，不带账号前缀，直接访问它会跳到
   * 另一个 Google 账号去，所以不能拿它来判断前缀。
   */
  const accountPrefix = () => {
    const base = document.querySelector('base');
    const basePath = base
      ? new URL(base.getAttribute('href') || '', location.href).pathname
      : '';
    const fromBase = /^\/(u\/\d+)(?=\/|$)/.exec(basePath);
    if (fromBase) return fromBase[0];
    const fromPath = /^\/(u\/\d+)(?=\/|$)/.exec(location.pathname);
    return fromPath ? fromPath[0] : '';
  };

  /**
   * 会话地址必须是绝对路径（/u/1/app/<id>）。页面上有 <base href=".../u/1/">，
   * 相对路径会被拼成 /u/1/u/1/app/<id>，点进去就是 404。
   */
  const chatHref = (id) => `${accountPrefix()}/app/${id}`;

  const notebookUrl = (id) => `${location.origin}${accountPrefix()}/notebook/${id}`;

  /**
   * 普通左键点击交给主世界更新历史记录并通知 Gemini 的 Angular 路由。
   * 修改键点击和中键点击继续走浏览器原生行为，以便在新标签页打开。
   */
  function navigateToChat(event, id) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    window.dispatchEvent(
      new CustomEvent(NAVIGATE_EVENT, {
        detail: JSON.stringify({ channel: CHANNEL, href: chatHref(id) }),
      }),
    );
  }

  /* ---------------- 展开状态持久化 ---------------- */

  function saveExpanded() {
    chrome.storage.session
      .set({ [EXPANDED_KEY]: [...expanded] })
      .catch(() => {});
  }

  function restoreExpanded() {
    chrome.storage.session
      .get(EXPANDED_KEY)
      .then((stored) => {
        const list = stored[EXPANDED_KEY];
        if (!Array.isArray(list)) return;
        list.forEach((notebookId) => {
          expanded.add(notebookId);
          openNotebook(notebookId);
        });
      })
      .catch(() => {});
  }

  /* ---------------- 数据 ---------------- */

  function getState(notebookId) {
    let state = states.get(notebookId);
    if (!state) {
      state = { chats: new Map(), complete: false, settled: false };
      states.set(notebookId, state);
    }
    return state;
  }

  /**
   * 以笔记本自己的查询结果为准：它标记为完整时覆盖旧数据；
   * 残缺的数据只做合并，也不会覆盖已经拿到的完整列表。
   */
  function applyChats(notebookId, chats, complete, settled) {
    if (!notebookId) return;

    const state = getState(notebookId);
    if (state.complete && !complete) return;

    if (complete) {
      state.chats = new Map();
      state.complete = true;
    }
    if (settled) state.settled = true;

    for (const chat of chats || []) {
      if (chat && chat.id) state.chats.set(chat.id, chat);
    }

    renderChats(notebookId);
  }

  function orderedChats(state) {
    const list = [...state.chats.values()];
    if (!list.every((chat) => typeof chat.time === 'number')) return list;
    return list.sort((a, b) => b.time - a.time);
  }

  function updateActiveChat() {
    for (const link of document.querySelectorAll('.gnex-chat')) {
      const active = new URL(link.href, location.href).pathname === location.pathname;
      link.classList.toggle('gnex-chat-active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
  }

  /* ---------------- 渲染 ---------------- */

  function renderChats(notebookId) {
    const container = containers.get(notebookId);
    if (!container) return;

    const state = getState(notebookId);
    const chats = orderedChats(state);

    container.textContent = '';

    for (const chat of chats) {
      const link = document.createElement('a');
      link.className = 'gnex-chat';
      link.href = chatHref(chat.id);
      link.title = chat.title;
      link.textContent = chat.title;
      link.addEventListener('click', (event) => navigateToChat(event, chat.id));
      container.appendChild(link);
    }

    updateActiveChat();

    if (!state.complete && !state.settled) {
      container.appendChild(hint(chats.length ? '正在载入完整对话…' : '正在载入对话…'));
    } else if (!chats.length) {
      container.appendChild(hint('这个笔记本里还没有对话'));
    }
  }

  function requestChats(notebookId) {
    chrome.runtime
      .sendMessage({
        channel: CHANNEL,
        type: 'REQUEST_NOTEBOOK',
        notebookId,
        url: notebookUrl(notebookId),
      })
      .then((response) => {
        if (!response) return;
        applyChats(notebookId, response.chats, response.complete, response.settled);
      })
      .catch(() => {});
  }

  function openNotebook(notebookId) {
    expanded.add(notebookId);
    saveExpanded();

    const container = containers.get(notebookId);
    if (container) {
      container.hidden = false;
      renderChats(notebookId);
    }

    const entry = mounted.get(notebookId);
    if (entry) entry.button.setAttribute('aria-expanded', 'true');

    requestChats(notebookId);
  }

  function closeNotebook(notebookId) {
    expanded.delete(notebookId);
    saveExpanded();

    const container = containers.get(notebookId);
    if (container) {
      container.hidden = true;
      container.textContent = '';
    }

    const entry = mounted.get(notebookId);
    if (entry) entry.button.setAttribute('aria-expanded', 'false');
  }

  function toggleNotebook(notebookId) {
    if (expanded.has(notebookId)) closeNotebook(notebookId);
    else openNotebook(notebookId);
  }

  /* ---------------- 侧边栏挂载 ---------------- */

  function mount(item, link, notebookId) {
    item.classList.add('gnex-item');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'gnex-toggle';
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-label', '展开笔记本对话');
    button.title = '展开/收起笔记本对话';
    button.appendChild(createChevron());

    const stop = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    button.addEventListener('pointerdown', stop);
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleNotebook(notebookId);
    });

    const iconBox = item.querySelector('.leading-icon-container');
    if (iconBox) {
      iconBox.classList.add('gnex-icon-box');
      iconBox.appendChild(button);
    } else {
      link.prepend(button);
    }

    const container = document.createElement('div');
    container.className = 'gnex-chats';
    container.hidden = true;
    item.appendChild(container);

    containers.set(notebookId, container);
    mounted.set(notebookId, { item, button });

    if (expanded.has(notebookId)) openNotebook(notebookId);
  }

  function syncSidebar() {
    if (isTempTab) return;
    updateActiveChat();

    const items = document.querySelectorAll('project-sidenav-list-item');

    for (const item of items) {
      const link = item.querySelector('a[href*="/notebook/"]');
      if (!link) continue;

      const match = NOTEBOOK_PATH.exec(link.getAttribute('href') || '');
      if (!match) continue;
      const notebookId = match[1];

      const known = mounted.get(notebookId);
      if (known && known.item === item) continue;

      // 侧边栏被 Gemini 重新渲染过，换个元素重新挂一次。
      if (known) {
        containers.delete(notebookId);
      }
      mount(item, link, notebookId);
    }
  }

  function scheduleSync() {
    if (syncTimer) return;
    syncTimer = setTimeout(() => {
      syncTimer = null;
      syncSidebar();
    }, SYNC_DELAY_MS);
  }

  /* ---------------- 消息 ---------------- */

  window.addEventListener('popstate', updateActiveChat);

  // 页面主世界的拦截器拿到会话列表（CustomEvent 跨世界传递）。
  window.addEventListener(EVENT_NAME, (event) => {
    let data;
    try {
      data = JSON.parse(event.detail);
    } catch (error) {
      return;
    }
    if (!data || data.channel !== CHANNEL || !data.notebookId) return;

    applyChats(data.notebookId, data.chats, data.complete, data.settled);
    chrome.runtime
      .sendMessage({
        channel: CHANNEL,
        type: 'NOTEBOOK_CHATS',
        notebookId: data.notebookId,
        chats: data.chats,
        complete: data.complete,
        settled: data.settled,
      })
      .catch(() => {});
  });

  // 后台工作线程广播过来的会话列表。
  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== 'GNEX_NOTEBOOK_CHATS') return;
    applyChats(message.notebookId, message.chats, message.complete, message.settled);
  });

  /* ---------------- 启动 ---------------- */

  const observer = new MutationObserver(scheduleSync);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // 后台为了取数据开的标签页不需要侧边栏，也不要再发请求，避免来回开标签页。
  chrome.runtime
    .sendMessage({ channel: CHANNEL, type: 'IS_TEMP_TAB' })
    .then((response) => {
      isTempTab = !!(response && response.temp);
      if (isTempTab) return;
      restoreExpanded();
      syncSidebar();
    })
    .catch(() => {
      isTempTab = false;
      restoreExpanded();
      syncSidebar();
    });
})();
