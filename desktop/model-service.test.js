const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { modelUrl, credentialForRequest, fetchAvailableModels } = require('./model-service');

async function serverFor(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('connection test requests the configured model endpoint with only its fake credential', async t => {
  let observed;
  const base = await serverFor(t, (req, res) => {
    observed = { path: req.url, auth: req.headers.authorization };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'model-a', name: 'Model A' }, { id: 'model-a' }, { id: 'model-b', name: 'fake-secret' }, { id: 'fake-secret' }] }));
  });
  const result = await fetchAvailableModels(`${base}/v1`, 'fake-secret');
  assert.deepEqual(observed, { path: '/v1/models', auth: 'Bearer fake-secret' });
  assert.deepEqual(result.models, [{ id: 'model-a', label: 'Model A' }, { id: 'model-b', label: 'model-b' }]);
});

test('refuses redirects without forwarding credentials', async t => {
  let forwarded = false;
  const destination = await serverFor(t, (_req, res) => { forwarded = true; res.end(); });
  const base = await serverFor(t, (_req, res) => { res.writeHead(302, { location: destination }); res.end(); });
  await assert.rejects(fetchAvailableModels(base, 'fake-secret'), /重定向/);
  assert.equal(forwarded, false);
});

test('handles authentication, malformed responses, size and timeout without returning server data', async t => {
  const unauthorized = await serverFor(t, (_req, res) => { res.writeHead(401); res.end('do not display this'); });
  await assert.rejects(fetchAvailableModels(unauthorized, 'fake-secret'), /密钥无效或无访问权限/);
  const invalid = await serverFor(t, (_req, res) => { res.end('not-json'); });
  await assert.rejects(fetchAvailableModels(invalid, ''), /有效 JSON/);
  const big = await serverFor(t, (_req, res) => { res.end('x'.repeat(100)); });
  await assert.rejects(fetchAvailableModels(big, '', { maxBytes: 10 }), /过大/);
  const slow = await serverFor(t, (_req, _res) => {});
  await assert.rejects(fetchAvailableModels(slow, '', { timeoutMs: 50 }), /超时/);
});

test('closes a never-ending error response promptly', async t => {
  let markClosed;
  const closed = new Promise(resolve => { markClosed = resolve; });
  const base = await serverFor(t, (req, res) => {
    req.socket.once('close', markClosed);
    res.writeHead(401); res.write('unauthorized');
  });
  await assert.rejects(fetchAvailableModels(base, 'fake-secret', { timeoutMs: 2000 }), /无访问权限/);
  await Promise.race([closed, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('error response remained open')), 1000))]);
});

test('saved credentials are never reused for changed service addresses', () => {
  const profiles = { get: () => ({ provider: 'openai_compatible', baseUrl: 'https://example.test/v1', key: 'fake-secret' }) };
  const input = { provider: 'openai_compatible', baseUrl: 'https://example.test/v1', key: '', profileId: 'saved' };
  assert.equal(credentialForRequest(input, profiles), 'fake-secret');
  assert.throws(() => credentialForRequest({ ...input, baseUrl: 'https://other.test/v1' }, profiles), /重新输入密钥/);
  assert.equal(credentialForRequest({ ...input, baseUrl: 'https://other.test/v1', key: 'new-secret' }, profiles), 'new-secret');
  assert.throws(() => modelUrl('http://other.test/v1'));
  assert.throws(() => modelUrl('https://name:secret@example.test/v1'));
  assert.throws(() => fetchAvailableModels('https://example.test/fake-secret', 'fake-secret'), /不能包含密钥/);
});
