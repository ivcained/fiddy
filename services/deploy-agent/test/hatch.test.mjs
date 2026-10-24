// Tests for the hatch client: the UI flow states, HTTP error mapping, polling,
// cancellation, and the end-to-end path against a real deploy agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { startAgent } from '../server.mjs';
import { createHatchClient, describeJob, HatchError } from '../hatch.mjs';

const FAKE_REPO = fileURLToPath(new URL('./fake-repo', import.meta.url));
const TOKEN = 'test-token';

const reply = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
});

function clientWith(handler, options = {}) {
  return createHatchClient({
    baseUrl: 'https://agent.test',
    token: TOKEN,
    fetch: handler,
    pollMs: 1,
    ...options,
  });
}

test('describeJob maps every job state to a UI phase', () => {
  assert.equal(describeJob({ state: 'queued' }).phase, 'pending');
  assert.equal(
    describeJob({ state: 'running', step: 'provision --ssh a@b' }).phase,
    'provisioning',
  );
  assert.equal(
    describeJob({ state: 'running', step: 'node up' }).phase,
    'booting',
  );

  const ready = describeJob({ state: 'done', nodeHttp: 'http://node:3381' });
  assert.equal(ready.phase, 'ready');
  assert.equal(ready.nodeHttp, 'http://node:3381');
  assert.match(ready.detail, /http:\/\/node:3381/);
  assert.equal(describeJob({ state: 'done' }).nodeHttp, null);

  const failed = describeJob({
    state: 'failed',
    logTail: 'line 1\n✗ fiddy node up exited 7\n',
  });
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.detail, '✗ fiddy node up exited 7');
});

test('createHatchClient validates its inputs', () => {
  assert.throws(() => createHatchClient({}), /baseUrl is required/);
  assert.throws(
    () => createHatchClient({ baseUrl: 'x', fetch: 'not-a-function' }),
    /fetch is required/,
  );
});

test('maps agent HTTP failures to error codes', async () => {
  const cases = [
    [400, 'invalid-target'],
    [401, 'unauthorized'],
    [404, 'not-found'],
    [429, 'busy'],
    [500, 'http'],
  ];
  for (const [status, code] of cases) {
    const client = clientWith(async () => reply(status, { error: 'nope' }));
    await assert.rejects(
      () => client.status('job-1'),
      (error) => error instanceof HatchError && error.code === code,
    );
  }
});

test('a dead agent is a network error', async () => {
  const client = clientWith(async () => {
    throw new Error('ECONNREFUSED');
  });
  await assert.rejects(
    () => client.deploy('ubuntu@203.0.113.10'),
    (error) => error.code === 'network' && /ECONNREFUSED/.test(error.message),
  );
});

test('wait polls until done and reports every update', async () => {
  const states = [
    { state: 'queued' },
    { state: 'running', step: 'node up' },
    { state: 'done', nodeHttp: 'http://node:3381' },
  ];
  let index = 0;
  const client = clientWith(async () =>
    reply(200, states[Math.min(index++, 2)]),
  );
  const seen = [];
  const job = await client.wait('job-1', {
    onUpdate: (update) => seen.push(update.state),
  });

  assert.equal(job.state, 'done');
  assert.deepEqual(seen, ['queued', 'running', 'done']);
});

test('wait fails with the last job snapshot when the deploy fails', async () => {
  const client = clientWith(async () =>
    reply(200, { state: 'failed', step: 'node up', logTail: '✗ exited 7\n' }),
  );
  await assert.rejects(
    () => client.wait('job-1'),
    (error) => error.code === 'failed' && error.job.step === 'node up',
  );
});

test('wait gives up after its timeout budget', async () => {
  const client = clientWith(
    async () => reply(200, { state: 'running', step: 'node up' }),
    {
      timeoutMs: 25,
    },
  );
  await assert.rejects(
    () => client.wait('job-1'),
    (error) => error.code === 'timeout' && error.job.state === 'running',
  );
});

test('wait can be cancelled by the UI', async () => {
  const controller = new AbortController();
  const client = clientWith(
    async () => reply(200, { state: 'running', step: 'node up' }),
    {
      pollMs: 5,
    },
  );
  const pending = client.wait('job-1', { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, (error) => error.code === 'cancelled');
});

test('hatch runs end to end against a real agent', async () => {
  const agent = await startAgent({ token: TOKEN, repo: FAKE_REPO, port: 0 });
  try {
    const client = createHatchClient({
      baseUrl: agent.url,
      token: TOKEN,
      pollMs: 20,
    });
    const job = await client.hatch('ubuntu@203.0.113.10');
    assert.equal(job.state, 'done', job.logTail);
    assert.equal(job.nodeHttp, 'http://203.0.113.10:3381');
    assert.ok(job.jobId);

    const jobs = await client.list();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, job.jobId);
  } finally {
    await agent.close();
  }
});

test('a second hatch during a running deploy is reported as busy', async () => {
  const agent = await startAgent({
    token: TOKEN,
    repo: FAKE_REPO,
    port: 0,
    maxRunning: 1,
    env: { FAKE_SLEEP: '0.6' },
  });
  try {
    const client = createHatchClient({
      baseUrl: agent.url,
      token: TOKEN,
      pollMs: 20,
    });
    const { jobId } = await client.deploy('ubuntu@203.0.113.10');
    while ((await client.status(jobId)).state !== 'running') {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    await assert.rejects(
      () => client.deploy('ubuntu@203.0.113.11'),
      (error) => error.code === 'busy' && error.status === 429,
    );

    const job = await client.wait(jobId, { pollMs: 20 });
    assert.equal(job.state, 'done');
  } finally {
    await agent.close();
  }
});

test('a wrong token is rejected before anything runs', async () => {
  const agent = await startAgent({ token: TOKEN, repo: FAKE_REPO, port: 0 });
  try {
    const wrong = createHatchClient({
      baseUrl: agent.url,
      token: 'wrong',
      pollMs: 20,
    });
    await assert.rejects(
      () => wrong.hatch('ubuntu@203.0.113.10'),
      (error) => error.code === 'unauthorized',
    );

    const right = createHatchClient({ baseUrl: agent.url, token: TOKEN });
    assert.equal((await right.list()).length, 0);
  } finally {
    await agent.close();
  }
});
