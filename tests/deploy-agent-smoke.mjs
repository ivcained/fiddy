#!/usr/bin/env node
// Smoke test for the deploy-agent: does a job actually RUN?
//
// Why this exists: the agent's gates (lint/typecheck/test on farcaster-web)
// never execute services/deploy-agent/server.mjs, so a job whose first
// statement threw at runtime shipped green. The bug that motivated this file
// was automatic semicolon insertion turning
//   job.state = 'running'
//   (async () => { … })()
// into `'running'(…)()` — `TypeError: "running" is not a function` on every
// provision, while every gate passed.
//
// It is hermetic on purpose: the repo is a temp dir with two stub scripts, so
// nothing here touches AWS, SSH or the network. Run: node tests/deploy-agent-smoke.mjs
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, '..', 'services', 'deploy-agent', 'server.mjs')
const TOKEN = 'smoke-token'
const FID = 191554

let checks = 0
let failures = 0
const ok = (name, pass, extra = '') => {
  checks += 1
  if (pass) console.log(`  ✓ ${name}`)
  else {
    failures += 1
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'fiddy-agent-smoke-'))
  const repo = join(root, 'repo')
  const home = join(root, 'home')
  await mkdir(join(repo, 'bin'), { recursive: true })
  await mkdir(join(repo, 'scripts'), { recursive: true })
  await mkdir(home, { recursive: true })

  // The CLI stand-in: records the facts a real `fiddy provision --aws` would
  // write to $FIDDY_HOME/config, and prints a line a human could read.
  const cli = `#!/usr/bin/env bash
set -euo pipefail
mkdir -p "\${FIDDY_HOME}"
cat >> "\${FIDDY_HOME}/config" <<'FACTS'
FIDDY_PROVIDER=aws
FIDDY_TARGET=ubuntu@203.0.113.7
FIDDY_AWS_INSTANCE_ID=i-0smoke0000000001
FIDDY_AWS_VOLUME_ID=vol-0smoke00000001
FIDDY_AWS_SG_ID=sg-0smoke00000001
FIDDY_AWS_KEY_NAME=fiddy-node
FIDDY_AWS_IP=203.0.113.7
FIDDY_AWS_REGION=us-east-1
FIDDY_SSH_KEY=${join(root, 'fiddy-node.pem')}
FIDDY_NODE_HTTP=http://203.0.113.7:3381
FACTS
echo "stub fiddy: \$*"
`
  const terminal = `#!/usr/bin/env bash
set -euo pipefail
echo "stub terminal install: \$*"
echo 'FIDDY_TERMINAL_JSON {"fid":${FID},"terminalUrl":"https://fiddy.fun/term/deadbeef/","endpointUrl":"https://fiddy.fun/node/deadbeef/","unitState":"active","terminalHttp":"200","nodeApiHttp":"000","sshReachable":true}'
`
  await writeFile(join(repo, 'bin', 'fiddy'), cli)
  await writeFile(join(repo, 'scripts', 'install-node-terminal.sh'), terminal)
  await chmod(join(repo, 'bin', 'fiddy'), 0o755)
  await chmod(join(repo, 'scripts', 'install-node-terminal.sh'), 0o755)

  const port = await freePort()
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      DEPLOY_AGENT_TOKEN: TOKEN,
      FIDDY_REPO: repo,
      HOME: home,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (d) => {
    stderr += d.toString()
  })
  const base = `http://127.0.0.1:${port}`
  const authed = (init = {}) => ({
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  })

  try {
    // --- the server comes up ------------------------------------------------
    let health = null
    for (let i = 0; i < 50 && !health; i += 1) {
      try {
        const r = await fetch(`${base}/health`)
        if (r.ok) health = await r.json()
      } catch {
        await sleep(100)
      }
    }
    ok('the agent answers /health without a token', health?.ok === true, `stderr: ${stderr.slice(-200)}`)

    // --- auth is a wall ----------------------------------------------------
    const noAuth = await fetch(`${base}/status/whatever`)
    ok('an unauthenticated /status is 401', noAuth.status === 401, `got ${noAuth.status}`)
    const noAuthProvision = await fetch(`${base}/provision`, { method: 'POST', body: '{}' })
    ok('an unauthenticated /provision is 401', noAuthProvision.status === 401, `got ${noAuthProvision.status}`)

    // --- a job RUNS (the regression this file guards) ----------------------
    // Wrapped, because the failure this guards against kills the agent mid-
    // request: the socket closes and an unhandled fetch error would bury the
    // diagnosis the checks below produce.
    let started = null
    let startedBody = null
    try {
      started = await fetch(
        `${base}/provision`,
        authed({ method: 'POST', body: JSON.stringify({ kind: 'aws', fid: FID, token: 'a'.repeat(64) }) }),
      )
      startedBody = await started.json().catch(() => null)
    } catch (error) {
      startedBody = { error: String(error?.cause ?? error) }
    }
    ok('POST /provision answers 202 with a jobId', started?.status === 202 && typeof startedBody?.jobId === 'string', `status ${started?.status}, body ${JSON.stringify(startedBody)}`)
    ok('the agent process is still alive after a job starts', child.exitCode === null, `exit ${child.exitCode}; stderr: ${stderr.slice(-300)}`)

    let job = null
    if (typeof startedBody?.jobId === 'string') {
      // The terminal install is chained INSIDE the same job (a 2s tick after the
      // provision reports done), so "done" alone is not the finish line when a
      // terminal was requested: wait for the terminal verdict.
      for (let i = 0; i < 160; i += 1) {
        const r = await fetch(`${base}/status/${startedBody.jobId}`, authed())
        job = await r.json().catch(() => null)
        if (job?.state === 'failed') break
        if (job && job.terminal) break
        await sleep(150)
      }
    }
    ok('the job reaches done', job?.state === 'done', `state ${job?.state}, step ${job?.step}, tail ${(job?.logTail ?? '').slice(-300)}`)
    ok('the provision step really ran', (job?.logTail ?? '').includes('stub fiddy: provision --aws'))
    ok('the node-up step really ran', (job?.logTail ?? '').includes('stub fiddy: node up'))
    ok('the terminal install is chained behind the provision', (job?.logTail ?? '').includes('stub terminal install: --fid'))
    ok('the instance id is read back from facts, not scraped', job?.facts?.instanceId === 'i-0smoke0000000001', JSON.stringify(job?.facts))
    ok('the terminal verdict is parsed', job?.terminal?.terminalUrl === 'https://fiddy.fun/term/deadbeef/', JSON.stringify(job?.terminal))
  } finally {
    child.kill('SIGKILL')
    await rm(root, { recursive: true, force: true })
  }

  console.log(`\n${checks - failures}/${checks} checks passed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})