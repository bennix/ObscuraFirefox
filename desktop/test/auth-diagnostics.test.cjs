const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { AuthDiagnostics, scrub, responseSummary, credentialSummary } = require('../auth-diagnostics.cjs');

test('login diagnostics redact credentials and retain useful OAuth failure facts', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'obscura-auth-log-'));
  try {
    const logger = new AuthDiagnostics(directory);
    logger.record('fixture', { url: 'https://accounts.google.com/gsi/transform?id_token=fixture-token-secret', headers: { Authorization: 'Bearer fixture-secret', Cookie: 'auth_token=fixture-cookie-secret' }, apiKey: 'fixture-api-secret', message: 'user@example.com token=fixture-inline-secret' });
    const listeners = new Map();
    const client = {
      on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name); },
      async send(name) { return name === 'Network.getResponseBody' ? { body: 'prefix\u0000An unexpected error occurred. Please try again.', base64Encoded: false } : { result: { value: { opener: true, rtc: 'undefined' } } }; }
    };
    const detach = logger.attach(client, { id: 'fixture-target', url: 'https://x.com/i/flow/login', type: 'webview' });
    listeners.get('Network.requestWillBeSent')({ requestId: 'request-1', type: 'Fetch', documentURL: 'https://x.com/', request: { url: 'https://jf.x.com/onboarding/web/actions/begin_signup_sso', method: 'POST', headers: { authorization: 'Bearer never-log-this', 'x-csrf-token': 'never-log-csrf' }, postData: 'never-log-request-payload' } });
    listeners.get('Network.requestWillBeSentExtraInfo')({ requestId: 'request-1', headers: { cookie: 'never-log-cookie-header' }, associatedCookies: [{ cookie: { name: 'auth_token', value: 'never-log-cookie-value' }, blockedReasons: ['SameSiteStrict'] }] });
    listeners.get('Network.responseReceived')({ requestId: 'request-1', response: { status: 200, mimeType: 'text/plain', headers: {}, protocol: 'h2' } });
    await listeners.get('Network.loadingFinished')({ requestId: 'request-1', encodedDataLength: 212 });
    listeners.get('Runtime.consoleAPICalled')({ type: 'error', args: [{ value: 'password=raw-password-fixture' }] });
    listeners.get('Runtime.exceptionThrown')({ exceptionDetails: { exception: { description: 'Error: raw-password-fixture', className: 'Error' }, text: 'Uncaught' } });
    detach();
    const state = await logger.flush();
    assert.equal(state.writeError, '');
    const content = await fs.readFile(state.file, 'utf8');
    for (const secret of ['fixture-token-secret', 'fixture-secret', 'fixture-cookie-secret', 'fixture-api-secret', 'fixture-inline-secret', 'user@example.com', 'never-log-this', 'never-log-csrf', 'never-log-request-payload', 'never-log-cookie-header', 'never-log-cookie-value', 'raw-password-fixture']) assert.ok(!content.includes(secret), secret);
    const records = content.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(records.some(item => item.event === 'response.summary' && item.unexpectedError && item.status === 200));
    assert.ok(records.some(item => item.event === 'cookie.request.blocked' && item.name === 'auth_token'));
    assert.equal((await fs.stat(state.file)).mode & 0o777, 0o600);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('diagnostic files rotate and binary error responses are summarized without raw payloads', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'obscura-auth-rotation-'));
  try {
    const logger = new AuthDiagnostics(directory, 500);
    for (let index = 0; index < 15; index++) logger.record('fixture', { message: 'a'.repeat(150), index });
    await logger.flush();
    assert.ok((await fs.readdir(logger.directory)).includes('x-login.jsonl.1'));
    const binary = responseSummary('binary\u0000An unexpected error occurred. Please try again.\u0000sso_login');
    assert.equal(binary.unexpectedError, true);
    assert.ok(binary.strings.includes('An unexpected error occurred. Please try again.'));
    assert.ok(binary.strings.includes('sso_login'));
    assert.equal(scrub('https://x.com/login?credential=private-value'), 'https://x.com/login');
    assert.equal(scrub('https://jf.x.com/onboarding/web/actions/begin_signup_sso?token=private'), 'https://jf.x.com/onboarding/web/actions/begin_signup_sso');
    assert.equal(scrub({ reasons: ['SchemefulSameSiteUnspecifiedTreatedAsLax'] }).reasons[0], 'SchemefulSameSiteUnspecifiedTreatedAsLax');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('Google credential diagnostics expose validation facts without identity or token values', () => {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const token = encode({ alg: 'RS256' }) + '.' + encode({ iss: 'https://accounts.google.com', aud: 'fixture-client-id', exp: Date.now() / 1000 + 60, sub: 'private-subject', email: 'private@example.com', email_verified: true, nonce: 'private-nonce' }) + '.fixture_signature';
  const state = credentialSummary(token);
  assert.equal(state.tokenFound, true);
  assert.equal(state.issuerIsGoogle, true);
  assert.equal(state.expired, false);
  assert.equal(state.emailVerified, true);
  assert.equal(state.signature, 'not-verified');
  for (const secret of [token, 'private-subject', 'private@example.com', 'private-nonce', 'fixture-client-id']) assert.ok(!JSON.stringify(state).includes(secret));
});
