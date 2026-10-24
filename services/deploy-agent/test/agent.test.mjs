// Tests for the deploy agent: auth, the deploy lifecycle, limits, CORS and
// cleanup. Each test starts a real server on port 0 against a fake `bin/fiddy`,
// so nothing here needs docker, ssh or the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { startAgent } from '../server.mjs';

const FAKE_REPO = fileURLToPath(new URL('./fake-repo', import.meta.url));
const TOKEN = 'test-token';
const TARGET = 'ubuntu@203.0.113.10';

async function withAgent(options, run) {
  const agent = await startAgent({
    token: TOKEN,
    repo: FAKE_REPO,
    port: 0,
    sweepMs: 60_000,
    ...options,
  });
  try {
    await run(agent);
  } finally {
    await agent.close();
  }
}

function authed(agent, path, init = {}) {
  return fetch(`${agent.url}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...init.headers },
  });
}

function deploy(agent, sshTarget = TARGET) {
  return authed(agent, '/deploy', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sshTarget }),
  });
}

async function waitFor(agent, jobId, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await (await authed(agent, `/status/${jobId}`)).json();
    if (predicate(job)) return job;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting; last=${JSON.stringify(job)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const settled = (job) => job.state !== 'queued' && job.state !== 'running';

test('health is public and reports capacity', async () => {
  await withAgent({}, async (agent) => {
    const response = await fetch(`${agent.url}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      service: 'fiddy-deploy-agent',
      running: 0,
    });
  });
});

test('every route but /health needs the bearer token', async () => {
  await withAgent({}, async (agent) => {
    assert.equal((await fetch(`${agent.url}/jobs`)).status, 401);
    const wrong = await fetch(`${agent.url}/jobs`, {
      headers: { authorization: 'Bearer nope' },
    });
    assert.equal(wrong.status, 401);
    assert.equal((await authed(agent, '/jobs')).status, 200);
  });
});

test('deploy runs provision then node up and reports the node endpoint', async () => {
  await withAgent({}, async (agent) => {
    const response = await deploy(agent);
    assert.equal(response.status, 202);
    const { jobId, statusUrl } = await response.json();
    assert.equal(statusUrl, `/status/${jobId}`);

    const job = await waitFor(agent, jobId, settled);
    assert.equal(job.state, 'done', job.logTail);
    assert.equal(job.nodeHttp, 'http://203.0.113.10:3381');
    assert.match(job.logTail, /provision --ssh ubuntu@203\.0\.113\.10/);
    assert.match(job.logTail, /✓ node done/);

    const { jobs } = await (await authed(agent, '/jobs')).json();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, jobId);
    assert.equal(jobs[0].state, 'done');
  });
});

test('a failing step marks the job failed and keeps the exit code', async () => {
  await withAgent({ env: { FAKE_FAIL_ON: 'node' } }, async (agent) => {
    const { jobId } = await (await deploy(agent)).json();
    const job = await waitFor(agent, jobId, settled);
    assert.equal(job.state, 'failed');
    assert.match(job.logTail, /boom: node failed/);
    assert.match(job.logTail, /fiddy node up exited 7/);
    assert.equal(job.nodeHttp, null);
  });
});

test('rejects bad targets, bad JSON and oversized bodies', async () => {
  await withAgent({}, async (agent) => {
    assert.equal((await deploy(agent, 'no-at-sign')).status, 400);
    assert.equal((await deploy(agent, 'ubuntu@host; rm -rf /')).status, 400);

    const badJson = await authed(agent, '/deploy', {
      method: 'POST',
      body: '{',
    });
    assert.equal(badJson.status, 400);

    const huge = await authed(agent, '/deploy', {
      method: 'POST',
      body: JSON.stringify({ sshTarget: TARGET, pad: 'x'.repeat(5000) }),
    });
    assert.equal(huge.status, 413);
  });
});

test('caps parallel deploys with 429 and a retry hint', async () => {
  await withAgent(
    { maxRunning: 1, env: { FAKE_SLEEP: '0.4' } },
    async (agent) => {
      const { jobId } = await (await deploy(agent)).json();
      await waitFor(agent, jobId, (job) => job.state === 'running');

      const busy = await deploy(agent, 'ubuntu@203.0.113.11');
      assert.equal(busy.status, 429);
      assert.equal(busy.headers.get('retry-after'), '30');
      assert.equal((await busy.json()).error, 'agent busy');

      await waitFor(agent, jobId, (job) => job.state === 'done', 8000);
      const after = await deploy(agent, 'ubuntu@203.0.113.11');
      assert.equal(after.status, 202);
    },
  );
});

test('an unknown job is a 404', async () => {
  await withAgent({}, async (agent) => {
    assert.equal((await authed(agent, '/status/does-not-exist')).status, 404);
  });
});

test('answers CORS preflight for the client origin only', async () => {
  await withAgent({ corsOrigins: ['https://fiddy.fun'] }, async (agent) => {
    const preflight = await fetch(`${agent.url}/deploy`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://fiddy.fun',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization',
      },
    });
    assert.equal(preflight.status, 204);
    const allowOrigin = preflight.headers.get('access-control-allow-origin');
    assert.equal(allowOrigin, 'https://fiddy.fun');
    assert.match(
      preflight.headers.get('access-control-allow-headers'),
      /authorization/,
    );

    const allowed = await authed(agent, '/jobs', {
      headers: { origin: 'https://fiddy.fun' },
    });
    assert.equal(
      allowed.headers.get('access-control-allow-origin'),
      allowOrigin,
    );

    const denied = await authed(agent, '/jobs', {
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
  });
});

test('a hung step is killed at the timeout', async () => {
  await withAgent(
    { stepTimeoutMs: 1000, env: { FAKE_SLEEP: '30' } },
    async (agent) => {
      const { jobId } = await (await deploy(agent)).json();
      const job = await waitFor(agent, jobId, settled, 8000);
      assert.equal(job.state, 'failed');
      assert.match(job.logTail, /timed out after 1s/);
    },
  );
});

test('finished jobs are evicted after their TTL', async () => {
  await withAgent({ jobTtlMs: 50, sweepMs: 20 }, async (agent) => {
    const { jobId } = await (await deploy(agent)).json();
    await waitFor(agent, jobId, (job) => job.state === 'done');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((await authed(agent, `/status/${jobId}`)).status, 404);
  });
});
