# fiddy deploy-agent

One-click read-node deploy. The agent is a small HTTP service on a host that has
this repo checked out: a user hands it a server they already pay for, and it
runs the same `bin/fiddy provision --ssh …` and `bin/fiddy node up` a human
would, streaming progress back. The client's **hatch node** button and
`hatch.mjs` speak to it; nothing here is a second implementation of the CLI.

## API

| Route | Method | Body / result |
|---|---|---|
| `/health` | GET | `{ ok: true, service, running }` — public, for nginx and uptime checks |
| `/deploy` | POST | `{ "sshTarget": "user@host" }` → `202 { jobId, statusUrl }` |
| `/status/:jobId` | GET | `{ id, state, step, nodeHttp, logTail, createdAt, updatedAt }` |
| `/jobs` | GET | `{ jobs: [...] }`, newest first (the client history list) |

`state` is `queued → running → done | failed`. `step` is the command currently
running (`provision --ssh …`, `node up`). `nodeHttp` is the endpoint the CLI
recorded for that job (`~/.fiddy/jobs/<id>/config`), so the client can point
itself at the node the moment the job finishes.

Everything except `/health` needs `Authorization: Bearer $DEPLOY_AGENT_TOKEN`.
Errors: `400` bad target/JSON, `401` bad token, `404` unknown job, `413` body
over 4 KB, `429` all deploy slots busy (`retry-after: 30`), `500` internal.

## Run it

```bash
export DEPLOY_AGENT_TOKEN="$(openssl rand -hex 32)"
export FIDDY_REPO=/srv/fiddy          # checkout the CLI runs from
export CORS_ORIGIN=https://fiddy.fun  # only if a browser calls it
node services/deploy-agent/server.mjs
```

The agent binds `127.0.0.1:3225` by default; put nginx in front of it (nginx
forwards `Authorization` untouched) and keep the port off the public internet:

```nginx
location /deploy-agent/ {
    proxy_pass http://127.0.0.1:3225/;
    proxy_read_timeout 120s;
}
```

| Env | Default | What it does |
|---|---|---|
| `DEPLOY_AGENT_TOKEN` | — (required) | bearer token every route but `/health` checks |
| `FIDDY_REPO` | repo root | where `bin/fiddy` is executed from |
| `PORT` / `HOST` | `3225` / `127.0.0.1` | listen address |
| `CORS_ORIGIN` | empty | comma list of browser origins allowed to call it |
| `MAX_RUNNING` | `2` | parallel deploys; extra requests get `429` |
| `MAX_JOBS` | `64` | retained jobs |
| `JOB_TTL_MS` | `3600000` | how long a finished job stays readable |
| `STEP_TIMEOUT_MS` | `1800000` | per-step kill switch (a hung `ssh` cannot wedge a job) |
| `SWEEP_MS` | `60000` | cleanup interval |

Each job gets its own `FIDDY_HOME` (`~/.fiddy/jobs/<jobId>`), so two users never
share a target or a node URL.

## Client side

`hatch.mjs` is dependency-free (browser or Node 20+) and owns the four states a
UI has to render, so the buttons stay dumb:

```js
import { createHatchClient, describeJob, HatchError } from './hatch.mjs';

const hatch = createHatchClient({ baseUrl: 'https://deploy.fiddy.fun', token });

try {
  const job = await hatch.hatch('ubuntu@1.2.3.4', {
    onUpdate: (j) => render(describeJob(j)), // pending → provisioning → booting → ready
  });
  console.log(job.nodeHttp); // http://1.2.3.4:3381 — hand this to the client
} catch (error) {
  // error.code: unauthorized | invalid-target | busy | not-found | network |
  //             http | failed | timeout | cancelled
  render(describeJob(error.job ?? { state: 'failed' }));
}
```

`describeJob()` returns `{ phase, label, detail, nodeHttp? }` with `phase` one
of `pending`, `provisioning`, `booting`, `ready`, `failed` — the copy for each
is in one place instead of scattered through the button component. Pass
`signal` (an `AbortSignal`) to cancel a wait from a "stop" button.

**Token reality check.** The agent token is one shared secret: if the public web
client ships it, every visitor has it. For a public launch, mint short-lived
tokens per session (or put the agent behind the same auth as the client) and
keep `MAX_RUNNING` small — the agent holds SSH access to boxes users pay for.

## Tests

```bash
node --test services/deploy-agent/test/*.test.mjs
```

Twenty-one tests, no dependencies and no network: they start the real server on
port 0 against `test/fake-repo/bin/fiddy` and cover the happy path, a failing
step, the step timeout, the concurrency cap, TTL eviction, target validation,
CORS preflight, and the client's error mapping, polling, cancellation and
end-to-end hatch.
