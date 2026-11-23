/**
 * 运行在页面主世界（MAIN world），因此能看到 Gemini 自己的网络请求。
 *
 * 只读取 Gemini 本来就会请求的「会话列表」接口（rpcids=MaZiqc）：
 * 在笔记本页面上，这个接口返回的正是该笔记本下的会话列表，每条会话的父级
 * 字段形如 notebooks/<uuid>。这里把结果转成纯数据，交给内容脚本渲染。
 * 会话导航也在这里执行，通过历史记录和 popstate 触发 Gemini 自己的路由。
 *
 * 不读取请求头、不读取请求体、不发送任何数据到外部。
 */
(() => {
  if (window.__gnexInterceptorInstalled) return;
  window.__gnexInterceptorInstalled = true;
  // 方便确认当前页面跑的是哪一版代码
  window.__gnexVersion = 5;

  const CHANNEL = 'gnex';
  const EVENT_NAME = 'gnex:notebook-chats';
  const NAVIGATE_EVENT = 'gnex:navigate-chat';
  const CHAT_LIST_RPC = 'rpcids=MaZiqc';

  window.addEventListener(NAVIGATE_EVENT, (event) => {
    let data;
    try {
      data = JSON.parse(event.detail);
    } catch (error) {
      return;
    }
    if (!data || data.channel !== CHANNEL || typeof data.href !== 'string') return;

    const target = new URL(data.href, location.origin);
    if (
      target.origin !== location.origin ||
      !/^\/(?:u\/\d+\/)?app\/[A-Za-z0-9_-]+$/.test(target.pathname)
    ) {
      return;
    }

    // Angular 用 navigationId 区分每次导航。快速切换时重复使用原 state
    // 会产生多个相同编号的导航，因此每次都在当前编号上递增。
    const currentState = history.state && typeof history.state === 'object' ? history.state : {};
    const state = {
      ...currentState,
      navigationId: (Number(currentState.navigationId) || 0) + 1,
    };
    history.pushState(state, '', target.pathname);
    window.dispatchEvent(new PopStateEvent('popstate', { state }));
  });

  /**
 * Gemini 的 batchexecute 响应是「长度行 + JSON」交替的流式格式，
 * 开头可能带 XSSI 前缀 ")]}'"。
   */
  function parseChunks(text) {
    const raw = text.startsWith(")]}'") ? text.slice(4) : text;
    const chunks = [];
    let buffer = '';

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (/^\d+$/.test(trimmed)) {
        if (buffer.trim()) {
          try {
            chunks.push(JSON.parse(buffer));
          } catch (error) {
            /* 不是合法 JSON 就跳过这一段 */
          }
        }
        buffer = '';
      } else {
        buffer += line + '\n';
      }
    }

    if (buffer.trim()) {
      try {
        chunks.push(JSON.parse(buffer));
      } catch (error) {
        /* 忽略末尾不完整的一段 */
      }
    }

    return chunks;
  }

  /** 从响应体里取出会话列表。 */
  function extractChats(text) {
    const chats = [];

    for (const chunk of parseChunks(text)) {
      const frame = chunk && chunk[0];
      if (!Array.isArray(frame) || frame[0] !== 'wrb.fr' || typeof frame[2] !== 'string') {
        continue;
      }

      let payload;
      try {
        payload = JSON.parse(frame[2]);
      } catch (error) {
        continue;
      }

      const list = payload && payload[2];
      if (!Array.isArray(list)) continue;

      for (const item of list) {
        if (!Array.isArray(item) || typeof item[0] !== 'string') continue;

        const time = Array.isArray(item[5]) ? item[5][0] : null;
        const parent = typeof item[7] === 'string' ? item[7] : null;

        chats.push({
          id: item[0].replace(/^c_/, ''),
          title: typeof item[1] === 'string' && item[1] ? item[1] : '无标题对话',
          time: typeof time === 'number' ? time : null,
          notebookId: parent && parent.startsWith('notebooks/') ? parent.slice('notebooks/'.length) : null,
        });
      }
    }

    return chats;
  }

  /**
   * 请求路径形如 /u/1/notebook/<uuid>，即这条列表属于哪个笔记本。
   * found 用来区分「请求里没带 source-path」和「source-path 不是笔记本页」：
   * 前者还可以看当前页面，后者说明这条请求是聊天页发出的，只会返回当前这一条。
   */
  function notebookScopeFromUrl(url) {
    const raw = /source-path=([^&]+)/.exec(url);
    if (!raw) return { found: false, id: null };
    const match = /\/notebook\/([^/?#]+)/.exec(decodeURIComponent(raw[1]));
    return { found: true, id: match ? match[1] : null };
  }

  /** 当前页面本身是不是某个笔记本页。 */
  function notebookScopeFromPage() {
    const match = /\/notebook\/([^/?#]+)/.exec(location.pathname);
    return match ? match[1] : null;
  }

  function publish(notebookId, chats, complete) {
    if (!notebookId) return;
    // 用 CustomEvent 跨世界传递（主世界 -> 隔离世界），detail 传字符串更稳妥。
    window.dispatchEvent(
      new CustomEvent(EVENT_NAME, {
        detail: JSON.stringify({
          channel: CHANNEL,
          notebookId,
          chats,
          complete: !!complete,
        }),
      }),
    );
  }

  // 原始的 fetch，保留下来给「换大分页上限重问」用，避免被自己包过的那个再处理一遍。
  const originalFetch = window.fetch;

  /**
   * 从请求体里读出这次请求问的是什么：
   *  - limit：一次要几条（Gemini 笔记本页固定给 10 条）
   *  - notebook：这次是不是专门为某个笔记本拉的
   *
   * 请求体形如：
   *   f.req=[[["<rpc>","[10,null,[null,null,1,\"notebooks/<id>\",1]]",null,"generic"]]]&at=<令牌>
   */
  function parseRequest(body) {
    const result = { limit: null, notebookId: null, payload: null, encoded: false };
    if (!body) return result;

    const start = body.indexOf('f.req=');
    if (start < 0) return result;

    const rest = body.slice(start + 6);
    const end = rest.indexOf('&');
    const raw = end >= 0 ? rest.slice(0, end) : rest;

    let payload = null;
    let encoded = false;
    // 先按原样解析：Gemini 发的 f.req 通常就是普通 JSON，
    // 先 decode 会把「本来就没编码」误判成「编码过」。
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      try {
        payload = JSON.parse(decodeURIComponent(raw));
        encoded = true;
      } catch (error2) {
        return result;
      }
    }

    result.payload = payload;
    result.encoded = encoded;

    // 里面那串参数，例如 "[10,null,[null,null,1,\"notebooks/<id>\",1]]"
    const specs = [];
    const collect = (value) => {
      if (typeof value === 'string') {
        specs.push(value);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach(collect);
        return;
      }
      if (value && typeof value === 'object') {
        Object.values(value).forEach(collect);
      }
    };
    collect(payload);

    for (const spec of specs) {
      let parsed;
      try {
        parsed = JSON.parse(spec);
      } catch (error) {
        continue;
      }

      const numbers = [];
      const notebooks = [];
      const read = (value) => {
        if (typeof value === 'number') {
          numbers.push(value);
          return;
        }
        if (typeof value === 'string' && value.indexOf('notebooks/') === 0) {
          notebooks.push(value.slice('notebooks/'.length));
          return;
        }
        if (Array.isArray(value)) value.forEach(read);
      };
      read(parsed);

      if (numbers.length && result.limit === null) result.limit = numbers[0];
      if (notebooks.length && !result.notebookId) result.notebookId = notebooks[0];
    }

    return result;
  }

  /**
   * 把请求体里的分页上限换大后重发一次。令牌沿用刚才这次请求的，
   * 所以必须在页面刚发过请求的短时间内用。
   */
  function replayWithLargerLimit(url, reqBody, request, headers) {
    try {
      const payload = request.payload;
      if (!payload || !Array.isArray(payload[0]) || !Array.isArray(payload[0][0])) return;

      const entry = payload[0][0];
      if (typeof entry[1] !== 'string') return;
      const spec = JSON.parse(entry[1]);
      if (!Array.isArray(spec)) return;

      const oldSpec = entry[1];
      spec[0] = 200;
      const newSpec = JSON.stringify(spec);

      const start = reqBody.indexOf('f.req=');
      if (start < 0) return;
      const rest = reqBody.slice(start + 6);
      const end = rest.indexOf('&');
      const tail = end >= 0 ? rest.slice(end) : '';

      // 在原请求体里把参数串换掉，外层结构和编码方式都不动，
      // 重新拼一遍的话服务端解析不出来。
      const oldLiteral = JSON.stringify(oldSpec);
      const newLiteral = JSON.stringify(newSpec);

      let target = rest.slice(0, end >= 0 ? end : rest.length);
      let reencode = false;
      if (target.indexOf(oldLiteral) < 0) {
        // 整个 f.req 被编码过的情况
        try {
          const decoded = decodeURIComponent(target);
          if (decoded.indexOf(oldLiteral) >= 0) {
            target = decoded;
            reencode = true;
          }
        } catch (error) {
          /* 换不了就算了，用原来的结果 */
        }
      }

      const at = target.indexOf(oldLiteral);
      if (at < 0) return;
      const replaced = target.slice(0, at) + newLiteral + target.slice(at + oldLiteral.length);
      const body =
        reqBody.slice(0, start + 6) + (reencode ? encodeURIComponent(replaced) : replaced) + tail;

      // 用原始的 fetch，避免被自己包过的那个再处理一遍。
      originalFetch.call(window, url, {
        method: 'POST',
        body,
        credentials: 'include',
        headers: headers || {},
      })
        .then((response) =>
          response.clone ? response.clone().text() : response.text(),
        )
        .then((text) => handle(url, text, body, headers, false))
        .catch(() => {});
    } catch (error) {
      /* 重问失败就用原来的结果 */
    }
  }

  /** 取请求体。请求一旦发出去就取不到了，所以要在 fetch 之前克隆一份。 */
  function requestBody(input, init) {
    try {
      if (init && init.body != null) {
        return Promise.resolve(typeof init.body === 'string' ? init.body : String(init.body));
      }
      if (typeof Request !== 'undefined' && input instanceof Request) {
        return input.clone().text().catch(() => '');
      }
    } catch (error) {
      /* 取不到就算了 */
    }
    return Promise.resolve('');
  }

  /** 取请求头，重发请求时照抄一份。 */
  function requestHeaders(input, init) {
    const headers = {};
    try {
      const source =
        (init && init.headers) ||
        (typeof Request !== 'undefined' && input instanceof Request ? input.headers : null);
      if (!source) return headers;
      if (typeof source.forEach === 'function') {
        source.forEach((value, key) => {
          headers[key] = value;
        });
      } else {
        Object.assign(headers, source);
      }
    } catch (error) {
      /* 取不到就算了 */
    }
    return headers;
  }

  function handle(url, text, reqBody, reqHeaders, allowReplay) {
    if (!url.includes(CHAT_LIST_RPC)) return;

    // 只有从笔记本页发出的请求才是该笔记本的完整列表；聊天页发出的请求
    // 只会返回当前这一条，属于残缺数据，不能当成完整列表缓存下来。
    const scopeInfo = notebookScopeFromUrl(url);
    const scope = scopeInfo.id || (scopeInfo.found ? null : notebookScopeFromPage());

    const chats = extractChats(text);
    const request = parseRequest(reqBody);

    // 按父级字段分组：只有父级指向某个笔记本的会话才算那个笔记本的。
    // 没有父级的会话属于账号本身，不归任何笔记本，不能塞进某个笔记本里。
    const byNotebook = new Map();
    for (const chat of chats) {
      if (!chat.notebookId) continue;
      if (!byNotebook.has(chat.notebookId)) byNotebook.set(chat.notebookId, []);
      byNotebook.get(chat.notebookId).push(chat);
    }

    for (const [notebookId, list] of byNotebook) {
      // 这次请求就是问这个笔记本的，而且条数没顶到分页上限，才算完整列表。
      const askedForThis = request.notebookId === notebookId;
      const truncated = request.limit != null && list.length >= request.limit;
      let complete = askedForThis && !truncated;

      // 请求体读不出来时退回「整份响应都只属于这一个笔记本」这个判断。
      if (!request.notebookId && !request.limit) {
        complete = scope === notebookId && byNotebook.size === 1 && chats.length === list.length;
      }

      publish(notebookId, list, complete);

      // 条数正好顶到分页上限，说明后面可能还有，用更大的上限再问一次。
      if (askedForThis && truncated && allowReplay) {
        replayWithLargerLimit(url, reqBody, request, reqHeaders);
      }
    }

    // 笔记本页返回空列表：这个笔记本确实还没有对话。
    if (!chats.length && request.notebookId && request.notebookId === scope) {
      publish(scope, [], true);
    }
  }

  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const headers = requestHeaders(input, init);
    // 必须在请求发出之前取请求体，发出去之后就取不到了。
    const bodyPromise = url.includes(CHAT_LIST_RPC) ? requestBody(input, init) : null;
    const response = originalFetch.apply(this, arguments);

    if (bodyPromise) {
      response.then(
        (resolved) => {
          resolved
            .clone()
            .text()
            .then((text) => bodyPromise.then((body) => handle(url, text, body, headers, true)))
            .catch(() => {});
        },
        () => {},
      );
    }

    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__gnexUrl = String(url);
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    if (this.__gnexUrl && this.__gnexUrl.includes(CHAT_LIST_RPC)) {
      const reqBody = arguments[0] && typeof arguments[0] === 'string' ? arguments[0] : '';
      this.addEventListener('load', () => {
        try {
          handle(this.__gnexUrl, this.responseText, reqBody, null, true);
        } catch (error) {
          /* 忽略解析失败 */
        }
      });
    }
    return originalSend.apply(this, arguments);
  };
})();
