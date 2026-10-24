// fiddy deploy-agent — the host that does the heavy lifting so a miniapp can
// ask for a managed node without ever holding AWS credentials.
//
// Runs on the VPS next to the fiddy repo checkout (services/deploy-agent lives
// in it, so the CLI it runs and the CLI a human runs cannot drift apart). AWS
// keys live only in this process's environment file (/etc/fiddy/deploy-agent.env,
// mode 600) — never in a browser, never in the release bundle, never in the
// miniapp.
//
//   POST /deploy    {"sshTarget": "ubuntu@1.2.3.4"}           -> { jobId }
//                   (kept: the bring-your-own-server path)
//   POST /provision {"kind":"aws", "fid":N, "token":"<hex>"}  -> { jobId }
//                   {"kind":"ssh", "sshTarget":"user@host"}   -> { jobId }
//                   kind=aws creates OUR EC2 instance, installs the node on it
//                   and, when a token is given, the per-node terminal.
//   POST /teardown  {"instanceId":"i-…", "region":"us-east-1"} -> { jobId }
//                   terminates the instance and proves the billing stopped.
//   GET  /status/:jobId    -> { state, step, facts, terminal, teardown, logTail }
//   GET  /health           -> { ok: true, active }
//
// Auth: Authorization: Bearer $DEPLOY_AGENT_TOKEN on everything but /health.
// The agent never sees user keys or seed phrases — it only touches compute.
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'

const PORT = process.env.PORT || 3225
const TOKEN = process.env.DEPLOY_AGENT_TOKEN
const REPO = process.env.FIDDY_REPO || new URL('../..', import.meta.url).pathname
// A systemd unit need not set HOME (ours is EnvironmentFile-only), and a job's
// home is derived from it — unset, every job wrote its config and its node key
// to a literal `undefined/.fiddy/jobs/<id>/` relative to the service's cwd.
// A key that only resolves from one cwd is a key you lose; fall back to the
// passwd database rather than trusting the environment to be complete.
const HOME = process.env.HOME || homedir()
const JOBS = new Map()
const MAX_LOG = 64 * 1024
// Two at a time: a provision spends real money on AWS, so a third parallel run
// is a mistake rather than a queue worth building.
const MAX_ACTIVE = Number(process.env.DEPLOY_AGENT_MAX_ACTIVE || 2)
const KEEP_JOBS = 200

if (!TOKEN) {
  console.error('DEPLOY_AGENT_TOKEN is required')
  process.exit(1)
}

function activeCount() {
  let n = 0
  for (const job of JOBS.values()) if (job.state === 'queued' || job.state === 'running') n += 1
  return n
}

function pruneJobs() {
  if (JOBS.size <= KEEP_JOBS) return
  const finished = [...JOBS.values()].filter((j) => j.state !== 'running' && j.state !== 'queued')
  finished.sort((a, b) => a.startedAt - b.startedAt)
  for (const job of finished.slice(0, Math.max(0, JOBS.size - KEEP_JOBS))) JOBS.delete(job.id)
}

// The CLI records what it created in $FIDDY_HOME/config (mode 600, shell-quoted).
// Reading it back is how a job reports facts instead of intentions — the agent
// never scrapes stdout for an instance id.
async function readFacts(home) {
  const facts = {}
  let text = ''
  try {
    text = await readFile(`${home}/config`, 'utf8')
  } catch {
    return facts
  }
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (!m) continue
    let value = m[2].trim()
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1)
    }
    facts[m[1]] = value
  }
  return facts
}

function pick(facts) {
  return {
    target: facts.FIDDY_TARGET || null,
    instanceId: facts.FIDDY_AWS_INSTANCE_ID || null,
    volumeId: facts.FIDDY_AWS_VOLUME_ID || null,
    securityGroupId: facts.FIDDY_AWS_SG_ID || null,
    keyName: facts.FIDDY_AWS_KEY_NAME || null,
    ip: facts.FIDDY_AWS_IP || null,
    provider: facts.FIDDY_PROVIDER || null,
    nodeHttp: facts.FIDDY_NODE_HTTP || null,
    keyPath: facts.FIDDY_SSH_KEY || null,
    region: facts.FIDDY_AWS_REGION || null,
  }
}

function runSteps(job, steps, env) {
  job.state = 'running'
  // `void` is load-bearing, not decoration: without it automatic semicolon
  // insertion reads the next line as a CALL on the string assigned above —
  // `'running'(async () => {…})()` — and every job dies at birth with
  // `TypeError: "running" is not a function`.
  void (async () => {
    for (const step of steps) {
      job.step = step.label
      const code = await new Promise((resolve) => {
        const p = spawn(step.cmd, step.args, { env })
        p.stdout.on('data', (d) => job.append(d))
        p.stderr.on('data', (d) => job.append(d))
        p.on('error', (e) => { job.append(`\nspawn error: ${e.message}\n`); resolve(1) })
        p.on('close', resolve)
      })
      if (code !== 0) {
        job.state = 'failed'
        job.append(`\n✗ ${job.step} exited ${code}\n`)
        return
      }
      job.facts = { ...job.facts, ...pick(await readFacts(env.FIDDY_HOME)) }
    }
    job.state = 'done'
  })().catch((error) => {
    job.state = 'failed'
    job.append(`\n✗ agent error: ${error?.message ?? String(error)}\n`)
  })
}

// A repo script is run through bash, never as a bare executable: the mode bit
// is not something the agent controls (committed 644 once, the terminal install
// died with EACCES *after* the node it belonged to was already running and
// billing). bash does not care about the bit, and the label still names the real
// script so a job's log reads the same as ever.
function repoScript(script, args) {
  return {
    cmd: 'bash',
    args: [`${REPO}/${script}`, ...args],
    label: `${script.split('/').pop()} ${args.join(' ')}`.trim(),
  }
}

function cli(args) {
  return { cmd: `${REPO}/bin/fiddy`, args, label: `fiddy ${args.join(' ')}`.trim() }
}

// kind=aws: create our instance, install the node on it, then hand the miniapp a
// terminal. `fiddy node up` returns once the install is running and the API is
// either answering or honestly reported as still bootstrapping — it must not
// hold the job open for the multi-hour snapshot download.
function startProvision(job, body) {
  const env = { ...process.env, HOME, FIDDY_HOME: `${HOME}/.fiddy/jobs/${job.id}` }
  const steps = []
  if (body.kind === 'aws') {
    // Region/type/size come from the agent's own environment (operator config),
    // never from the caller: the caller does not get to pick our spend.
    for (const key of ['FIDDY_AWS_REGION', 'FIDDY_AWS_INSTANCE_TYPE', 'FIDDY_AWS_VOLUME_GB']) {
      if (process.env[key]) env[key] = process.env[key]
    }
    steps.push(cli(['provision', '--aws']))
  } else {
    steps.push(cli(['provision', '--ssh', body.sshTarget]))
  }
  steps.push(cli(['node', 'up']))
  runSteps(job, steps, env)
}

// The terminal install is a second process because it needs the target and key
// path the provision steps just recorded.
async function startTerminal(job, body) {
  const env = { ...process.env, HOME, FIDDY_HOME: `${HOME}/.fiddy/jobs/${job.id}` }
  const facts = pick(await readFacts(env.FIDDY_HOME))
  job.facts = { ...job.facts, ...facts }
  if (!facts.target || !facts.keyPath) {
    job.state = 'failed'
    job.append('\n✗ terminal requested but the provision recorded no target/key\n')
    return
  }
  runSteps(job, [repoScript('scripts/install-node-terminal.sh', [
    '--fid', String(body.fid), '--token', body.token,
    '--ssh', facts.target, '--key', facts.keyPath, '--json',
  ])], env)
}

function startTeardown(job, body) {
  const region = body.region || process.env.FIDDY_AWS_REGION || 'us-east-1'
  runSteps(job, [repoScript('scripts/aws-teardown.sh', [body.instanceId, '--region', region, '--json'])], { ...process.env, HOME })
}

function jobsPayload(job) {
  // Verdict lines the scripts print last, parsed here so a caller never has to
  // scrape human text.
  const parse = (re) => {
    const m = job.log.match(re)
    if (!m) return null
    try {
      return JSON.parse(m[1])
    } catch {
      return null
    }
  }
  return {
    state: job.state,
    step: job.step,
    facts: job.facts,
    teardown: parse(/FIDDY_TEARDOWN_JSON (\{.*\})/),
    terminal: parse(/FIDDY_TERMINAL_JSON (\{.*\})/),
    logTail: job.log.slice(-4000),
  }
}

function newJob(kind) {
  const id = randomUUID()
  const job = {
    id, kind, state: 'queued', step: null, log: '', facts: {}, startedAt: Date.now(),
    append(d) { this.log = (this.log + d.toString()).slice(-MAX_LOG) },
  }
  JOBS.set(id, job)
  pruneJobs()
  return job
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(obj))
  }
  if (url.pathname === '/health') {
    return send(200, { ok: true, service: 'fiddy-deploy-agent', active: activeCount() })
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorized' })

  const readBody = async () => {
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (body.length > 4096) return null
    }
    try {
      const parsed = JSON.parse(body)
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }

  if (req.method === 'POST' && (url.pathname === '/provision' || url.pathname === '/deploy')) {
    const body = await readBody()
    if (!body) return send(400, { error: 'invalid JSON' })
    // /deploy is the original bring-your-own-server shape: { sshTarget }.
    if (url.pathname === '/deploy') body.kind = body.kind ?? 'ssh'
    if (body.kind !== 'aws' && body.kind !== 'ssh') return send(400, { error: 'kind must be "aws" or "ssh"' })
    if (body.kind === 'ssh' && !/^[\w.-]+@[\w.-]+$/.test(body.sshTarget ?? '')) {
      return send(400, { error: 'sshTarget must look like user@host' })
    }
    const wantsTerminal = body.token !== undefined || body.fid !== undefined
    if (wantsTerminal) {
      if (!/^[0-9a-f]{32,64}$/.test(String(body.token))) return send(400, { error: 'token must be 32-64 hex chars' })
      if (!Number.isInteger(body.fid) || body.fid <= 0) return send(400, { error: 'fid must be a positive integer' })
    }
    if (activeCount() >= MAX_ACTIVE) return send(429, { error: 'too many active jobs' })
    const job = newJob(body.kind === 'aws' ? 'provision-aws' : 'provision-ssh')
    startProvision(job, body)
    if (wantsTerminal) {
      // Chain the terminal install behind the provision inside the same job, so
      // the caller polls one id and cannot see a half-finished terminal.
      const wait = setInterval(async () => {
        if (job.state === 'done') {
          clearInterval(wait)
          job.state = 'running'
          job.step = 'install-node-terminal.sh'
          await startTerminal(job, body)
        } else if (job.state === 'failed') {
          clearInterval(wait)
        }
      }, 2000)
      if (typeof wait.unref === 'function') wait.unref()
    }
    return send(202, { jobId: job.id, statusUrl: `/status/${job.id}` })
  }

  if (req.method === 'POST' && url.pathname === '/teardown') {
    const body = await readBody()
    if (!body) return send(400, { error: 'invalid JSON' })
    if (!/^i-[0-9a-f]{8,17}$/.test(String(body.instanceId ?? ''))) {
      return send(400, { error: 'instanceId must look like i-…' })
    }
    if (activeCount() >= MAX_ACTIVE) return send(429, { error: 'too many active jobs' })
    const job = newJob('teardown')
    startTeardown(job, body)
    return send(202, { jobId: job.id, statusUrl: `/status/${job.id}` })
  }

  const m = url.pathname.match(/^\/status\/([\w-]+)$/)
  if (req.method === 'GET' && m) {
    const job = JOBS.get(m[1])
    if (!job) return send(404, { error: 'unknown job' })
    return send(200, jobsPayload(job))
  }
  send(404, { error: 'not found' })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`fiddy-deploy-agent listening on 127.0.0.1:${PORT}`)
})