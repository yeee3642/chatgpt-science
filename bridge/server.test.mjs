/**
 * Tests for the loopback gateway's access controls.
 *
 * The application sends its live Claude OAuth bearer token to whatever base URL it is
 * given, so this gateway receives a real credential on every request. It must refuse
 * callers that are not the launched application, and must never echo the credential
 * back or hand it to the translation layer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startGateway } from './server.mjs';

const SECRET = 'a'.repeat(64);

/** Minimal stand-in for the translation layer; records what it was handed. */
function stubAdapter() {
  const seen = [];
  return {
    seen,
    async models() { return { data: [{ id: 'gpt-test', display_name: 'GPT Test' }] }; },
    async countTokens(body) { seen.push({ kind: 'count', body }); return { input_tokens: 7 }; },
    async messages(body, options = {}) {
      seen.push({ kind: 'messages', body });
      if (body.stream) {
        options.onEvent?.({ type: 'message_start' });
        options.onEvent?.({ type: 'message_stop' });
        return undefined;
      }
      return { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }] };
    },
    async close() {},
  };
}

async function withGateway(run, { adapter = stubAdapter(), secret = SECRET } = {}) {
  const gateway = await startGateway({ port: 0, secret, adapter });
  try {
    await gateway.startup;
    return await run(gateway, adapter);
  } finally {
    await gateway.close();
  }
}

const body = { model: 'claude-opus-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] };
const post = (gateway, pathname, init = {}) => fetch(`${gateway.origin}${pathname}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...init.headers },
  body: init.body ?? JSON.stringify(body),
});

test('rejects a request with no launch token', async () => {
  await withGateway(async gateway => {
    const response = await post(gateway, '/v1/messages');
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.type, 'authentication_error');
  });
});

test('rejects a wrong launch token', async () => {
  await withGateway(async gateway => {
    const response = await post(gateway, `/${'b'.repeat(64)}/v1/messages`);
    assert.equal(response.status, 403);
  });
});

test('does not reach the translation layer when the token is wrong', async () => {
  await withGateway(async (gateway, adapter) => {
    await post(gateway, `/${'b'.repeat(64)}/v1/messages`);
    assert.deepEqual(adapter.seen, [], 'an unauthenticated request must not be translated');
  });
});

test('accepts the launch token and returns a message', async () => {
  await withGateway(async gateway => {
    const response = await post(gateway, `/${SECRET}/v1/messages`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).content[0].text, 'ok');
  });
});

test('refuses a non-loopback Host header', async () => {
  // fetch() refuses to set Host, so this goes out over a raw request to prove the
  // guard rather than asserting against a header the client silently replaced.
  await withGateway(async gateway => {
    const { port } = new URL(gateway.origin);
    const status = await new Promise((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: `/${SECRET}/v1/messages`,
        headers: { host: 'example.com', 'content-type': 'application/json' },
      }, response => { response.resume(); resolve(response.statusCode); });
      request.once('error', reject);
      request.end(JSON.stringify(body));
    });
    assert.equal(status, 403, 'a forged Host must not be served; it indicates a request that did not come from the launched application');
  });
});

test('refuses a request carrying a browser Origin', async () => {
  await withGateway(async gateway => {
    const response = await post(gateway, `/${SECRET}/v1/messages`, { headers: { origin: 'https://example.com' } });
    assert.equal(response.status, 403);
  });
});

test('health is readable without the token and reports readiness', async () => {
  await withGateway(async gateway => {
    const response = await fetch(`${gateway.origin}/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
  });
});

test('health does not leak the launch token', async () => {
  await withGateway(async gateway => {
    const text = await fetch(`${gateway.origin}/health`).then(r => r.text());
    assert.ok(!text.includes(SECRET), 'the launch token must never appear in a response body');
  });
});

test('rejects a non-JSON content type', async () => {
  await withGateway(async gateway => {
    const response = await post(gateway, `/${SECRET}/v1/messages`, { headers: { 'content-type': 'text/plain' } });
    assert.equal(response.status, 415);
  });
});

test('rejects malformed JSON', async () => {
  await withGateway(async gateway => {
    const response = await post(gateway, `/${SECRET}/v1/messages`, { body: '{not json' });
    assert.equal(response.status, 400);
  });
});

test('rejects an unimplemented endpoint rather than guessing', async () => {
  await withGateway(async gateway => {
    const response = await post(gateway, `/${SECRET}/v1/messages/batches`);
    assert.equal(response.status, 404);
  });
});

test('serves the model list the application reads at startup', async () => {
  await withGateway(async gateway => {
    const response = await fetch(`${gateway.origin}/${SECRET}/v1/models`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data[0].id, 'gpt-test');
    assert.ok('display_name' in payload.data[0], 'the application reads display_name from this list');
  });
});

test('counts tokens through the translation layer', async () => {
  await withGateway(async gateway => {
    const response = await post(gateway, `/${SECRET}/v1/messages/count_tokens`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).input_tokens, 7);
  });
});

test('streams server-sent events when the request asks for them', async () => {
  await withGateway(async gateway => {
    const response = await post(gateway, `/${SECRET}/v1/messages`, { body: JSON.stringify({ ...body, stream: true }) });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const text = await response.text();
    assert.match(text, /event: message_start/);
    assert.match(text, /event: message_stop/);
  });
});

test('the Claude credential is never passed to the translation layer', async () => {
  await withGateway(async (gateway, adapter) => {
    const token = 'sk-ant-oat01-test-credential-must-not-propagate';
    await post(gateway, `/${SECRET}/v1/messages`, { headers: { authorization: `Bearer ${token}` } });
    const handed = JSON.stringify(adapter.seen);
    assert.ok(!handed.includes(token), 'the incoming Claude token must not be forwarded into translation');
  });
});

test('requires a per-launch 256-bit token', async () => {
  await assert.rejects(() => startGateway({ port: 0, secret: 'short', adapter: stubAdapter() }), /256-bit/);
  await assert.rejects(() => startGateway({ port: 0, adapter: stubAdapter() }), /256-bit/);
});

test('binds loopback only', async () => {
  await withGateway(async gateway => {
    assert.match(gateway.origin, /^http:\/\/127\.0\.0\.1:\d+$/, 'the gateway must not be reachable off-host');
  });
});
