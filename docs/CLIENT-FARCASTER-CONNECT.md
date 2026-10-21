# Connecting a Farcaster account: one tap, no fee, no phrase

Status: **implemented on branch `t_662333ce-neynar-connect`** (client) with its
server half on `t_662333ce-connect-api` (control plane, `legitmate-farcaster`).
This file is the design record: what a person sees, where every credential
lives, what was measured against the real network, how this coexists with making
a *new* account rather than connecting an existing one, and what is still open.

Everything marked MEASURED was read off a real API response, a real EIP-712
signature, or the committed source on 2026-10-21. Anything not measured says so.

---

## 1. What the person does

1. Presses **Connect** on `/connect-farcaster` (or the door in the sign-in
   modal: "Already on Farcaster? Let Fiddy post for you").
2. Sees a code to scan / a link to open, and one sentence about what they are
   allowing.
3. Opens the link in their Farcaster app and approves Fiddy there.
4. The screen notices the approval **by itself** (it polls) and says what is now
   true: "Fiddy can post for you — turn it off anytime."
5. From then on, Fiddy posts, replies, likes, recasts and follows as them, with
   the key they granted. Turning it off happens either on that same screen
   ("Turn it off") or in the app's own settings.

No fee is charged to them at any point, and no recovery phrase is ever entered,
stored or asked for. Their account, its custody key and its phrase never move.

## 2. Where the credentials live

| thing | where | why there |
| --- | --- | --- |
| Neynar API key | server (`NEYNAR_API_KEY` in the control plane's env) | it is a paid credential; it must never ship in a bundle |
| Fiddy's app-account signing key | server (`FIDDY_CONNECT_APP_KEY`) | it signs the protocol's signer request |
| the signer's own identifier | server, keyed by an opaque handle | Neynar's own guidance: it is a secret, held by the backend |
| the person's *handle* | browser, in an **HttpOnly** cookie | scripts cannot read it; the client never sees the signer id |
| the person's account, key, phrase | their Farcaster app, untouched | the point of the whole design |

The browser therefore holds **no credential at all** — and the client's own copy
of this flow (`src/snapchain/accounts/managedConnect.ts`) reads a status object
and nothing else.

## 3. What was measured against the real network (2026-10-21)

`scripts/verify-fiddy-connect.mjs` in the control-plane repo drives the real
module against `api.neynar.com` with the owner's key:

- `POST /v2/farcaster/signer` → **200**, `{signer_uuid, public_key, status:
  "generated"}`. **No approval link at this state** (the field is `null`).
- `POST /v2/farcaster/signer/signed_key` **requires** an EIP-712 `signature` from
  the requesting app FID's custody key: asking without one answers
  `400 {"code":"RequiredField","message":"signature is required"}`. Neynar's
  sponsorship flag does **not** replace it. This is why the server refuses to
  half-connect anybody when the app account is not configured
  (`CONNECT_NOT_SET_UP`, 501) instead of falling back to something cheaper.
- With the app account's key, the EIP-712 `SignedKeyRequest`
  (`Farcaster SignedKeyRequestValidator`, v1, chainId 10,
  `0x00000000fc700472606ed4fa22623acf62c60553`) and
  `sponsor: {sponsored_by_neynar: true}`, registration answers a real approval
  link of the form
  `https://client.farcaster.xyz/deeplinks/signed-key-request?token=0x…` and the
  signer moves to `pending_approval`.
- `GET /v2/farcaster/signer?signer_uuid=…` answers the state, and `fid` once
  approved — which is exactly what the client polls.
- **Not measured:** the moment of approval itself. That is a person tapping in
  their own Farcaster app; the run leaves the link ready and says so. The
  client's polling path is asserted against a stubbed service instead.

Cost, stated plainly: registering a *sponsored* request is what costs the owner
money (Neynar bills the API key's account in credits for the sponsorship). The
verification run did this once, on purpose, and reuses a waiting signer rather
than creating a second one — the module's own reuse rule, and the reason the
"start" endpoint hands back an existing link instead of minting a new signer.

**Which account is Fiddy's "app" account.** Signing the request needs a
registered FID whose custody key we hold. The owner's only such account is
`@fiddy-one` (FID 3356372, deployed for the agent work). It is configured, not
hard-coded, as `FIDDY_CONNECT_APP_FID` + `FIDDY_CONNECT_APP_KEY`, so a dedicated
app account can replace it by changing two environment values — no code change.
The approval screen names whoever that is ("sponsored by @fiddy-one" today).

## 4. Coexisting with making a *new* account

There are two honest ways to end up with an account Fiddy can post from, and
they are different products:

- **connect an account you already have** — this branch. One tap, no fee, no
  phrase; the trade is that Fiddy holds a posting key the person granted and can
  revoke.
- **make a new account here** — the account-creation work landing separately
  (`docs/CLIENT-ACCOUNT-CREATION.md`, branch `t_bb61fcf8-quilcast-adopt`). That
  path registers a brand-new FID, which costs a registration fee the person
  pays, and the device holds the account's own recovery phrase.

They meet in exactly one place: the sign-in surface
(`src/components/modals/LoginModal.tsx`), where each is **its own block** — the
Farcaster sign-in handshake, the connect door, and (when it lands) the create
door. No block is presented as the only way in, and the connect door's own page
lives at `routes.fiddyConnect` (`/connect-farcaster`) so it can be linked,
reloaded and re-entered without touching the modal again. Nothing in this branch
renames, moves or deletes a create-account file, so the two landings do not
depend on each other's merge order.

## 5. The seam the plugin's first-run setup shares

The plugin's one-click setup (card `t_e79c416a`) needs the same thing this
branch builds — a signer for a Farcaster account, obtained with no passphrase and
no fee. There is **one implementation**, on the control plane, and both clients
call it:

```
POST   /api/fiddy/connect         start (or re-hand) the request → {approvalUrl, state}
GET    /api/fiddy/connect         what the connection is now → {state, fid, username}
DELETE /api/fiddy/connect         turn it off at the network → {state}
POST   /api/fiddy/connect/write   one write, made with the granted key
```

- A **browser** gets an HttpOnly cookie and never sees the signer identifier; it
  writes through `/write`.
- A **machine** (an operator's own setup, no `Origin` header) gets an opaque
  `handle` back once, and may read its own `signerUuid` from `GET` to store in
  its own secret store — which is exactly what the plugin's
  `FIDDY_FARCASTER_SIGNER_UUID` setting wants. The plugin then writes with
  Neynar directly, using the key it already has.

Creating a signer is the only operation that spends money, so it is rate-limited
per caller (8 per 10 minutes) and capped per day (`FIDDY_CONNECT_DAILY_CEILING`,
default 40).

## 6. What the write path does when a key was granted

`~/snapchain/nodeApi/nodeWrites.ts` carries every write in the app. It now has a
second carrier: if a granted posting key exists **for the signed-in FID**, the
write is handed to the service that holds it instead of being signed here.

- The read-back discipline is untouched: after the service says the network took
  it, the client still asks the *node* whether the account's own state shows it,
  and answers "accepted, but a node is not showing it yet" rather than "posted"
  when it does not. A provider's `200` is not evidence, here or anywhere else.
- A connection belongs to one account: it is used only when the connected `fid`
  is the signed-in `fid`, so one person's key is never used to write as another.
- When the service cannot be reached, `available()` answers **no** and the write
  falls back to this device's own key — so an unreachable service downgrades to
  the old path instead of failing the write.

## 7. What is still open

1. **The approval tap** — one person, in their own Farcaster app. The link is
   produced by the server on demand; nothing here can (or should) stand in.
2. **Deploying the server half.** The control plane (fiddy-auth on the VPS) needs
   `NEYNAR_API_KEY`, `FIDDY_CONNECT_APP_FID`, `FIDDY_CONNECT_APP_KEY` in
   `/etc/fiddy-auth/app.env`, an nginx location for `/api/fiddy/connect` (the
   vhost lists each `/api/fiddy/*` path explicitly), and the release deployed.
3. **A dedicated app account.** `@fiddy-one` works and is configured; a
   purpose-built app account (its own FID, its own key, its own name on the
   approval screen) is a nicer long-term answer and costs only two env values.
4. **The other write verbs for a granted key** are implemented (cast, reaction,
   follow/unfollow) but only the client's own screens exercise them; a live
   end-to-end write needs an approved signer, which is (1).