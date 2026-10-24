// fiddy hatch — the client side of the deploy agent, plus the flow states the
// client UI renders.
//
// The web client's "hatch node" button, a script and `curl` all speak the same
// contract; this module keeps the pending / success / failure states in one
// place so the UI never re-implements them. No dependencies: it runs in the
// browser (global fetch) and in Node 20+.
//
//   const hatch = createHatchClient({ baseUrl, token });
//   const job = await hatch.hatch('ubuntu@1.2.3.4', {
//     onUpdate: (j) => render(describeJob(j)),
//   });
//   job.nodeHttp // -> "http://1.2.3.4:3381"
//
// Errors are HatchError with a `code`: unauthorized | invalid-target | busy |
// not-found | network | http | failed | timeout | cancelled. `failed` and
// `timeout` carry the last job snapshot in `error.job`.
//
// Tests: node --test services/deploy-agent/test/

export class HatchError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'HatchError';
    this.code = code;
    Object.assign(this, details);
  }
}

const STATUS_CODES = {
  400: 'invalid-target',
  401: 'unauthorized',
  403: 'unauthorized',
  404: 'not-found',
  413: 'invalid-target',
  429: 'busy',
};

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new HatchError('hatch cancelled', 'cancelled'));
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Map a deploy-agent job to the four states a UI has to render:
 * pending -> provisioning -> booting -> ready, or failed.
 */
export function describeJob(job) {
  const state = job?.state ?? 'unknown';
  const step = job?.step ?? '';

  if (state === 'done') {
    return {
      phase: 'ready',
      label: 'Node ready',
      detail: job.nodeHttp ? `Reading from ${job.nodeHttp}` : 'Node is up',
      nodeHttp: job.nodeHttp ?? null,
    };
  }
  if (state === 'failed') {
    const last = String(job?.logTail ?? '')
      .trim()
      .split('\n')
      .pop();
    return { phase: 'failed', label: 'Deploy failed', detail: last ?? '' };
  }
  if (state === 'running') {
    const booting = /^node\b/.test(step);
    return {
      phase: booting ? 'booting' : 'provisioning',
      label: booting ? 'Installing and syncing the node' : 'Furnishing compute',
      detail: step,
    };
  }
  if (state === 'queued') {
    return { phase: 'pending', label: 'Queued', detail: '' };
  }
  return { phase: 'unknown', label: state, detail: step };
}

/**
 * Create a deploy-agent client.
 *
 * @param {object} options
 * @param {string} options.baseUrl  agent origin, e.g. https://deploy.fiddy.fun
 * @param {string} options.token    DEPLOY_AGENT_TOKEN of that agent
 * @param {Function} [options.fetch] fetch implementation (defaults to global)
 * @param {number} [options.pollMs]  status poll interval (2000)
 * @param {number} [options.timeoutMs] overall hatch timeout (30 min)
 */
export function createHatchClient({
  baseUrl,
  token,
  fetch: fetchImpl,
  pollMs = 2000,
  timeoutMs = 30 * 60_000,
} = {}) {
  if (!baseUrl) throw new TypeError('baseUrl is required');
  const root = String(baseUrl).replace(/\/+$/, '');
  const doFetch = fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new TypeError(
      'fetch is required (Node 18+ and every browser have one)',
    );
  }

  async function call(method, path, body) {
    const headers = { authorization: `Bearer ${token ?? ''}` };
    if (body) headers['content-type'] = 'application/json';

    let response;
    try {
      response = await doFetch(`${root}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (cause) {
      throw new HatchError(
        `deploy agent unreachable: ${cause?.message ?? cause}`,
        'network',
        { cause },
      );
    }

    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (response.ok) return data;

    const code = STATUS_CODES[response.status] ?? 'http';
    throw new HatchError(
      data.error ?? `deploy agent answered ${response.status}`,
      code,
      {
        status: response.status,
        data,
      },
    );
  }

  const deploy = (sshTarget) => call('POST', '/deploy', { sshTarget });
  const status = (jobId) => call('GET', `/status/${encodeURIComponent(jobId)}`);
  const list = async () => (await call('GET', '/jobs')).jobs ?? [];

  async function wait(jobId, options = {}) {
    const interval = options.pollMs ?? pollMs;
    const budget = options.timeoutMs ?? timeoutMs;
    const deadline = Date.now() + budget;

    for (;;) {
      if (options.signal?.aborted) {
        throw new HatchError('hatch cancelled', 'cancelled');
      }
      const job = await status(jobId);
      options.onUpdate?.(job);
      if (job.state === 'done') return job;
      if (job.state === 'failed') {
        throw new HatchError(
          `deploy failed${job.step ? ` during ${job.step}` : ''}`,
          'failed',
          { job },
        );
      }
      if (Date.now() > deadline) {
        throw new HatchError(
          `deploy did not finish within ${Math.round(budget / 1000)}s`,
          'timeout',
          { job },
        );
      }
      await sleep(interval, options.signal);
    }
  }

  async function hatch(sshTarget, options = {}) {
    const { jobId } = await deploy(sshTarget);
    if (!jobId) throw new HatchError('deploy agent returned no jobId', 'http');
    const job = await wait(jobId, options);
    return { jobId, ...job };
  }

  return { deploy, status, list, wait, hatch };
}
