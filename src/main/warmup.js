function validateWarmupUrl(value) {
  try {
    const url = new URL(String(value).trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch { return null; }
}

async function createCdpSession(port, { fetchImpl = fetch, WebSocketImpl = WebSocket, timeoutMs = 10000 } = {}) {
  let targets;
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(Math.min(timeoutMs, 2000)) });
      if (!response.ok) throw new Error(`CDP target discovery failed (${response.status})`);
      targets = await response.json();
      break;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  if (!targets) throw lastError || new Error('CDP target discovery timeout');
  const target = targets.find(item => item.type === 'page') || targets[0];
  if (!target?.webSocketDebuggerUrl) throw new Error('No debuggable tab');

  const socket = new WebSocketImpl(target.webSocketDebuggerUrl);
  let nextId = 0;
  let closed = false;
  const pending = new Map();
  const loaded = new Set();
  const frameNavigations = new Map();
  const loadWaiters = new Set();

  function rejectAll(error) {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
    for (const waiter of loadWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    loadWaiters.clear();
  }

  const onMessage = event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.id && pending.has(message.id)) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error.message || 'CDP command failed'));
      else request.resolve(message.result || {});
      return;
    }
    const params = message.params || {};
    if (message.method === 'Page.lifecycleEvent' && params.name === 'load') {
      loaded.add(params.loaderId);
      resolveLoadWaiters(params.loaderId, params.frameId);
    } else if (message.method === 'Page.navigatedWithinDocument') {
      frameNavigations.set(params.frameId, params.url);
      resolveLoadWaiters(null, params.frameId, params.url);
    }
  };
  const onError = () => { closed = true; rejectAll(new Error('CDP WebSocket error')); };
  const onClose = () => { closed = true; rejectAll(new Error('CDP WebSocket closed')); };
  function resolveLoadWaiters(loaderId, frameId, url) {
    for (const waiter of [...loadWaiters]) {
      if (waiter.loaderId ? waiter.loaderId === loaderId : waiter.frameId === frameId && (!waiter.url || waiter.url === url)) {
        loadWaiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve();
      }
    }
  }

  let openTimer;
  let onSocketOpen;
  let onInitialError;
  let onInitialClose;
  const openPromise = new Promise((resolve, reject) => {
    openTimer = setTimeout(() => reject(new Error('CDP WebSocket timeout')), timeoutMs);
    onSocketOpen = () => { clearTimeout(openTimer); socket.removeEventListener('error', onInitialError); socket.removeEventListener('close', onInitialClose); resolve(); };
    onInitialError = () => { clearTimeout(openTimer); socket.removeEventListener('open', onSocketOpen); socket.removeEventListener('close', onInitialClose); reject(new Error('CDP WebSocket error')); };
    onInitialClose = () => { clearTimeout(openTimer); socket.removeEventListener('open', onSocketOpen); socket.removeEventListener('error', onInitialError); reject(new Error('CDP WebSocket closed')); };
    socket.addEventListener('open', onSocketOpen, { once: true });
    socket.addEventListener('error', onInitialError, { once: true });
    socket.addEventListener('close', onInitialClose, { once: true });
  });
  socket.addEventListener('message', onMessage);
  socket.addEventListener('error', onError);
  socket.addEventListener('close', onClose);

  async function send(method, params = {}) {
    if (closed) throw new Error('CDP WebSocket closed');
    await openPromise;
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('CDP timeout'));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  function waitForLoad(navigation) {
    if (navigation.loaderId && loaded.has(navigation.loaderId)) return Promise.resolve();
    if (!navigation.loaderId && frameNavigations.get(navigation.frameId) === navigation.url) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = { loaderId: navigation.loaderId, frameId: navigation.frameId, url: navigation.url, resolve, reject };
      waiter.timer = setTimeout(() => {
        loadWaiters.delete(waiter);
        reject(new Error('Page load timeout'));
      }, timeoutMs);
      loadWaiters.add(waiter);
    });
  }

  try {
    await openPromise;
    await send('Page.enable');
    await send('Page.setLifecycleEventsEnabled', { enabled: true });
  } catch (error) {
    closed = true;
    clearTimeout(openTimer);
    rejectAll(error);
    socket.removeEventListener('message', onMessage);
    socket.removeEventListener('error', onError);
    socket.removeEventListener('close', onClose);
    socket.removeEventListener('open', onSocketOpen);
    socket.removeEventListener('error', onInitialError);
    socket.removeEventListener('close', onInitialClose);
    try { socket.close(); } catch {}
    throw error;
  }

  return {
    async navigate(url) {
      const navigation = await send('Page.navigate', { url });
      if (navigation.errorText) throw new Error(navigation.errorText);
      await waitForLoad({ ...navigation, url });
    },
    close() {
      closed = true;
      rejectAll(new Error('CDP session closed'));
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('error', onError);
      socket.removeEventListener('close', onClose);
      try { socket.close(); } catch {}
    }
  };
}

async function runWarmupUrls(urls, { request = fetch, cdpPort = null, createSession = createCdpSession, continueOnError = true } = {}) {
  const results = [];
  let session = null;
  try {
    for (const raw of Array.isArray(urls) ? urls : []) {
      const url = validateWarmupUrl(raw);
      if (!url) {
        results.push({ input: raw, url: null, ok: false, error: 'Invalid URL' });
        if (!continueOnError) break;
        continue;
      }
      try {
        if (cdpPort) {
          session ||= await createSession(cdpPort);
          await session.navigate(url);
          results.push({ input: raw, url, ok: true });
        } else {
          const response = await request(url);
          results.push({ input: raw, url, ok: !!response.ok, status: response.status });
          if (!response.ok && !continueOnError) break;
        }
      } catch (error) {
        results.push({ input: raw, url, ok: false, error: error.message });
        if (!continueOnError) break;
      }
    }
  } finally {
    session?.close();
  }
  return results;
}

module.exports = { validateWarmupUrl, runWarmupUrls, createCdpSession };
