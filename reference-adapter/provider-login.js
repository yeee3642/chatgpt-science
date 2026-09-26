/* Independent provider binding for the preserved scientific-workbench UI. */
(() => {
  'use strict';
  let active = null;
  let state = Object.freeze({ phase: 'idle', message: '', authUrl: null });
  const listeners = new Set();
  const update = next => { state = Object.freeze({ ...state, ...next }); for (const listener of listeners) listener(state); };
  const base = () => {
    const configured = globalThis.__OPERON__?.baseUrl || '';
    if (!configured) return '';
    if (!configured.startsWith('/') || configured.startsWith('//') || /[\\?#\x00-\x20]/.test(configured)) throw new Error('The workbench API must use a local path on this server.');
    return configured.replace(/\/$/, '');
  };
  const csrf = () => {
    const match = document.cookie.match(/(?:^|;\s*)operon_csrf=([^;]*)/);
    return match ? decodeURIComponent(match[1]) : '';
  };
  async function request(route, { method = 'GET', body, signal } = {}) {
    const headers = { Accept: 'application/json' };
    const localToken = globalThis.__OPERON__?.token;
    if (localToken) headers.Authorization = `Bearer ${localToken}`;
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      const token = csrf();
      if (token) { headers['X-CSRF-Token'] = token; headers['x-operon-csrf'] = token; }
    }
    const timeout = AbortSignal.timeout(15000);
    const response = await fetch(`${base()}/api${route}`, {
      method, headers, credentials: 'same-origin', redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || result.detail || `Account service returned HTTP ${response.status}.`);
    return result;
  }
  function authenticated(account) {
    return account?.account?.type === 'chatgpt' && (account.authenticated === true || account.loggedIn === true);
  }
  function workspaceUrl(redirect = '/') {
    let route = typeof redirect === 'string' ? redirect : '/';
    if (!route.startsWith('/') || route.startsWith('//') || /[\\\x00-\x1f]/.test(route) || route.startsWith('/login')) route = '/';
    return base() ? `${base()}/#${route}` : route;
  }
  function safeAuthUrl(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !['auth.openai.com', 'chatgpt.com', 'openai.com'].includes(url.hostname)) throw new Error('The account service did not provide an official OpenAI sign-in URL.');
    return url.href;
  }
  async function check({ redirect = '/', navigate = true } = {}) {
    try {
      const account = await request('/account');
      if (authenticated(account)) {
        update({ phase: 'authenticated', message: 'ChatGPT account connected.', authUrl: null });
        if (navigate) window.location.assign(workspaceUrl(redirect));
        return true;
      }
      if (account?.status === 'unavailable' || account?.error) throw new Error(account.error || 'The local Codex account service is unavailable. Install or reconnect Codex, then retry.');
      if (!active) update({ phase: 'idle', message: 'Sign in with your ChatGPT account to continue.', authUrl: null });
      return false;
    } catch (error) {
      if (!active) update({ phase: 'error', message: error.message, authUrl: null });
      throw error;
    }
  }
  function delay(milliseconds, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new DOMException('Sign-in cancelled.', 'AbortError')); return; }
      const abort = () => { clearTimeout(timer); reject(new DOMException('Sign-in cancelled.', 'AbortError')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  function login({ redirect = '/' } = {}) {
    if (active) return active.promise;
    const operation = { controller: new AbortController(), loginId: null, popup: null, promise: null };
    // Called by an explicit UI action; allocate its window before the asynchronous account request.
    try { operation.popup = window.open('about:blank', 'chatgpt-science-auth'); if (operation.popup) operation.popup.opener = null; } catch {}
    active = operation;
    update({ phase: 'starting', message: 'Opening official OpenAI sign-in…', authUrl: null });
    operation.promise = (async () => {
      try {
        const result = await request('/account/login', { method: 'POST', body: {}, signal: operation.controller.signal });
        if (result.type !== 'chatgpt' || !result.loginId || !result.authUrl) throw new Error('The account service did not start a ChatGPT browser login.');
        operation.loginId = result.loginId;
        const authUrl = safeAuthUrl(result.authUrl);
        if (operation.popup && !operation.popup.closed) operation.popup.location = authUrl;
        else { try { window.open(authUrl, '_blank', 'noopener,noreferrer'); } catch {} }
        update({ phase: 'waiting', message: 'Complete sign-in in your browser. This window checks your real ChatGPT account.', authUrl });
        const deadline = Date.now() + 180000;
        let failures = 0;
        while (Date.now() < deadline) {
          await delay(1500, operation.controller.signal);
          let account;
          try { account = await request('/account', { signal: operation.controller.signal }); failures = 0; }
          catch (error) { if (operation.controller.signal.aborted || ++failures >= 3) throw error; continue; }
          if (authenticated(account)) {
            update({ phase: 'authenticated', message: 'ChatGPT account connected.', authUrl: null });
            window.location.assign(workspaceUrl(redirect));
            return { authenticated: true, provider: 'chatgpt' };
          }
          if (account.login?.status === 'failed') throw new Error(account.login.error || 'OpenAI sign-in failed. Try again.');
          if (account.login?.status === 'cancelled') throw new Error('Sign-in was cancelled.');
          if (account.status === 'unavailable' || account.error) throw new Error(account.error || 'The local Codex account service is unavailable.');
        }
        throw new Error('Sign-in has not completed after three minutes. Finish it in your browser, then select Check sign-in status.');
      } catch (error) {
        if (operation.popup && !operation.loginId) { try { operation.popup.close(); } catch {} }
        update({ phase: operation.controller.signal.aborted ? 'idle' : 'error', message: operation.controller.signal.aborted ? 'Sign-in cancelled.' : error.message });
        throw error;
      } finally { if (active === operation) active = null; }
    })();
    return operation.promise;
  }
  async function cancel() {
    const operation = active;
    if (!operation) return;
    operation.controller.abort();
    try {
      if (operation.loginId) await request('/account/login/cancel', { method: 'POST', body: { loginId: operation.loginId } });
      update({ phase: 'idle', message: operation.loginId ? 'Sign-in cancelled.' : 'Stopped waiting locally. A sign-in request may still be pending; check sign-in status before retrying.', authUrl: null });
    } catch (error) { update({ phase: 'error', message: `Stopped waiting locally. ${error.message}`, authUrl: null }); throw error; }
  }
  async function disconnect() {
    await request('/account/disconnect', { method: 'POST', body: {} });
    update({ phase: 'idle', message: 'ChatGPT disconnected from this workbench.', authUrl: null });
    window.location.assign(`${base()}/#/login`);
    return { disconnected: true, sharedAccountSignedOut: false };
  }
  async function reconnect({ redirect = '/' } = {}) {
    try {
      const account = await request('/account/reconnect', { method: 'POST', body: {} });
      if (!authenticated(account)) throw new Error(account.error || 'No signed-in ChatGPT account is available. Use Sign in with ChatGPT.');
      update({ phase: 'authenticated', message: 'ChatGPT account connected.', authUrl: null });
      window.location.assign(workspaceUrl(redirect));
    } catch (error) { update({ phase: 'error', message: error.message, authUrl: null }); throw error; }
  }
  const provider = Object.freeze({
    login, check, cancel, disconnect, reconnect, workspaceUrl, snapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    exchange() { return Promise.reject(new Error('ChatGPT sign-in completes in the official OpenAI browser flow. No Claude authorization code is accepted.')); },
  });
  Object.defineProperty(globalThis, '__CHATGPT_PROVIDER__', { value: provider, writable: false, configurable: false });
  // Other preserved account controls may contain a legacy local login link. Keep it local and bind it to the same real provider flow.
  document.addEventListener('click', event => {
    const anchor = event.target?.closest?.('a[href]');
    if (!anchor) return;
    const url = new URL(anchor.href, window.location.href);
    if (url.origin === window.location.origin && /\/api\/auth\/login$/.test(url.pathname)) {
      event.preventDefault(); event.stopImmediatePropagation();
      login({ redirect: url.searchParams.get('redirect') || '/' }).catch(() => {});
    }
  }, true);
})();
