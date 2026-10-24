// fiddy deploy-agent — one-click read-node deploy as a service.
//
// Runs on a host that has the fiddy repo checked out (e.g. the LC gateway VPS).
// Clients POST a target; the agent runs the same `bin/fiddy` scripts a human
// would, so the service and the tutorial can never drift apart. The browser
// client (`hatch.mjs`) and `curl` talk to the same contract.
//
//   POST /deploy       {"sshTarget": "ubuntu@1.2.3.4"}  -> 202 { jobId, statusUrl }
//   GET  /status/:id     -> { state, step, nodeHttp, logTail, ... }
//   GET  /jobs           -> { jobs: [...] }  (newest first)
//   GET  /health         -> { ok: true, running }
//
// Auth: Authorization: Bearer $DEPLOY_AGENT_TOKEN. The agent never sees user
// keys or seed phrases — it only ever touches infra the user furnishes.
//
// Env: PORT (3225), HOST (127.0.0.1), DEPLOY_AGENT_TOKEN (required), FIDDY_REPO,
//      CORS_ORIGIN (comma list of client origins; empty = no CORS headers),
//      MAX_RUNNING (parallel deploys, 2), MAX_JOBS (retained jobs, 64),
//      JOB_TTL_MS (finished-job retention, 1 h), STEP_TIMEOUT_MS (30 min),
//      SWEEP_MS (cleanup interval, 60 s).
//
// Tests: node --test services/deploy-agent/test/ (no dependencies, fake fiddy).
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAX_LOG = 64 * 1024;
const MAX_BODY = 4096;
const TARGET_RE = /^[\w.-]+@[\w.-]+$/;

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function normalizeOptions(options) {
  return {
    port: options.port ?? envInt('PORT', 3225),
    host: options.host ?? process.env.HOST ?? '127.0.0.1',
    token: options.token ?? process.env.DEPLOY_AGENT_TOKEN,
    repo:
      options.repo ??
      process.env.FIDDY_REPO ??
      fileURLToPath(new URL('../..', import.meta.url)),
    corsOrigins:
      options.corsOrigins ??
      (process.env.CORS_ORIGIN ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    maxRunning: options.maxRunning ?? envInt('MAX_RUNNING', 2),
    maxJobs: options.maxJobs ?? envInt('MAX_JOBS', 64),
    jobTtlMs: options.jobTtlMs ?? envInt('JOB_TTL_MS', 60 * 60_000),
    stepTimeoutMs:
      options.stepTimeoutMs ?? envInt('STEP_TIMEOUT_MS', 30 * 60_000),
    sweepMs: options.sweepMs ?? envInt('SWEEP_MS', 60_000),
    env: options.env ?? {},
  };
}

/**
 * Start the deploy agent. Returns `{ server, port, url, close }` once it is
 * listening; port 0 picks a free port (the tests rely on that).
 */
export async function startAgent(options = {}) {
  const config = normalizeOptions(options);
  if (!config.token) throw new Error('DEPLOY_AGENT_TOKEN is required');

  const jobs = new Map();
  const runningCount = () =>
    [...jobs.values()].filter((job) => job.state === 'running').length;
  const touch = (job) => {
    job.updatedAt = Date.now();
  };
  const append = (job, chunk) => {
    job.log = (job.log + chunk.toString()).slice(-MAX_LOG);
    touch(job);
  };
  const publicJob = (job) => ({
    id: job.id,
    sshTarget: job.sshTarget,
    state: job.state,
    step: job.step,
    nodeHttp: job.nodeHttp,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  });

  // --- job execution ------------------------------------------------------

  function runStep(job, cmd, args, env) {
    return new Promise((resolve) => {
      const child = spawn(join(config.repo, 'bin', 'fiddy'), [cmd, ...args], {
        env,
        detached: true, // own process group, so a timeout kills ssh + children
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      job.child = child;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }, config.stepTimeoutMs);

      child.stdout.on('data', (d) => append(job, d));
      child.stderr.on('data', (d) => append(job, d));
      child.on('error', (e) => append(job, `\nspawn error: ${e.message}\n`));
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        job.child = null;
        resolve({ code, signal, timedOut });
      });
    });
  }

  async function runJob(job) {
    job.state = 'running';
    touch(job);
    const home = process.env.HOME || homedir();
    const env = {
      ...process.env,
      ...config.env,
      FIDDY_HOME: join(home, '.fiddy', 'jobs', job.id),
    };
    await mkdir(env.FIDDY_HOME, { recursive: true }).catch(() => {});
    append(job, `▸ deploy ${job.sshTarget}\n`);

    const steps = [
      ['provision', ['--ssh', job.sshTarget]],
      ['node', ['up']],
    ];
    for (const [cmd, args] of steps) {
      job.step = `${cmd} ${args.join(' ')}`;
      touch(job);
      const result = await runStep(job, cmd, args, env);
      if (!result.timedOut && result.code === 0) continue;
      append(
        job,
        result.timedOut
          ? `\n✗ fiddy ${job.step} timed out after ${Math.round(config.stepTimeoutMs / 1000)}s\n`
          : `\n✗ fiddy ${job.step} exited ${result.code}${result.signal ? ` (${result.signal})` : ''}\n`,
      );
      job.state = 'failed';
      touch(job);
      return;
    }

    // Read back the node endpoint the CLI recorded for this job.
    try {
      const cfg = await readFile(join(env.FIDDY_HOME, 'config'), 'utf8');
      const m = cfg.match(/^FIDDY_NODE_HTTP=(.+)$/m);
      if (m) job.nodeHttp = m[1].replace(/^["']|["']$/g, '');
    } catch {
      /* config read is best-effort */
    }
    job.state = 'done';
    touch(job);
  }

  // Drop finished jobs past their TTL, then trim the oldest when over quota.
  // Running jobs are never dropped.
  function sweep() {
    const now = Date.now();
    for (const [id, job] of jobs) {
      if (job.state !== 'running' && now - job.updatedAt > config.jobTtlMs) {
        jobs.delete(id);
      }
    }
    if (jobs.size <= config.maxJobs) return;
    const finished = [...jobs.values()]
      .filter((job) => job.state !== 'running')
      .sort((a, b) => a.updatedAt - b.updatedAt);
    for (const job of finished) {
      if (jobs.size <= config.maxJobs) break;
      jobs.delete(job.id);
    }
  }

  // --- HTTP ---------------------------------------------------------------

  function corsHeaders(req) {
    const origin = req.headers.origin;
    if (!origin || config.corsOrigins.length === 0) return {};
    const wildcard = config.corsOrigins.includes('*');
    if (!wildcard && !config.corsOrigins.includes(origin)) return {};
    return {
      'access-control-allow-origin': wildcard ? '*' : origin,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-max-age': '600',
      vary: 'origin',
    };
  }

  function authorized(req) {
    const header = req.headers.authorization || '';
    const prefix = 'Bearer ';
    if (!header.startsWith(prefix)) return false;
    const got = Buffer.from(header.slice(prefix.length));
    const want = Buffer.from(config.token);
    return got.length === want.length && timingSafeEqual(got, want);
  }

  async function readBody(req) {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_BODY) return { tooLarge: true, body: '' };
    }
    return { tooLarge: false, body };
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const cors = corsHeaders(req);
    const send = (code, obj, extra = {}) => {
      res.writeHead(code, {
        'content-type': 'application/json',
        ...cors,
        ...extra,
      });
      res.end(JSON.stringify(obj));
    };

    try {
      if (url.pathname === '/health') {
        return send(200, {
          ok: true,
          service: 'fiddy-deploy-agent',
          running: runningCount(),
        });
      }

      // A CORS preflight carries no credentials and must not require the token.
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        return res.end();
      }

      if (!authorized(req)) return send(401, { error: 'unauthorized' });

      if (req.method === 'POST' && url.pathname === '/deploy') {
        const { tooLarge, body } = await readBody(req);
        if (tooLarge) return send(413, { error: 'body too large' });

        let sshTarget;
        try {
          sshTarget = JSON.parse(body || '{}').sshTarget;
        } catch {
          return send(400, { error: 'invalid JSON' });
        }
        if (typeof sshTarget !== 'string' || !TARGET_RE.test(sshTarget)) {
          return send(400, { error: 'sshTarget must look like user@host' });
        }
        if (runningCount() >= config.maxRunning) {
          return send(
            429,
            { error: 'agent busy', maxRunning: config.maxRunning },
            { 'retry-after': '30' },
          );
        }

        const now = Date.now();
        const job = {
          id: randomUUID(),
          sshTarget,
          state: 'queued',
          step: null,
          nodeHttp: null,
          log: '',
          child: null,
          createdAt: now,
          updatedAt: now,
        };
        jobs.set(job.id, job);
        runJob(job);
        return send(202, { jobId: job.id, statusUrl: `/status/${job.id}` });
      }

      if (req.method === 'GET' && url.pathname === '/jobs') {
        const list = [...jobs.values()]
          .sort((a, b) => b.createdAt - a.createdAt)
          .map(publicJob);
        return send(200, { jobs: list });
      }

      const match = url.pathname.match(/^\/status\/([\w-]+)$/);
      if (req.method === 'GET' && match) {
        const job = jobs.get(match[1]);
        if (!job) return send(404, { error: 'unknown job' });
        return send(200, { ...publicJob(job), logTail: job.log.slice(-4000) });
      }

      return send(404, { error: 'not found' });
    } catch (error) {
      return send(500, {
        error: 'internal error',
        detail: error?.message ?? String(error),
      });
    }
  });

  const sweeper = setInterval(sweep, config.sweepMs);
  sweeper.unref?.();

  const close = () =>
    new Promise((resolve) => {
      clearInterval(sweeper);
      for (const job of jobs.values()) {
        if (!job.child) continue;
        try {
          process.kill(-job.child.pid, 'SIGKILL');
        } catch {
          job.child.kill('SIGKILL');
        }
      }
      server.close(() => resolve());
      server.closeAllConnections?.();
    });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });

  const { port } = server.address();
  return { server, port, url: `http://${config.host}:${port}`, close };
}

const isMain =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  startAgent()
    .then(({ url, close }) => {
      console.log(`fiddy-deploy-agent listening on ${url}`);
      const stop = () => close().then(() => process.exit(0));
      process.on('SIGTERM', stop);
      process.on('SIGINT', stop);
    })
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
