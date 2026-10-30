# Sealed drafts

Fiddy keeps two local-first draft collections behind the existing provider seam:

- `node`: the `/v2/draft-caststorms` and `/v2/draft-casts` answers.
- `recovery`: the composer's scoped auto-recovery drafts.

Both are encrypted in browser storage with AES-GCM. The plaintext remains only in memory. The existing synchronous route answers and local recovery behavior do not wait for encryption or a network request. Browsers without IndexedDB keep the previous local-only behavior.

The ciphertext-only mirror was inspired by `backmeupplz/quilcast` (MIT), commit `db57d4bdcb8a713e9344cd19f25158f746fe2720`. Fiddy uses a different key-enrollment and conflict design.

## Opt-in sync

Sync is offered only on `fiddy.fun`. Self-hosted installs make no sync request and show `Drafts stay on this device.` The server receives only opaque ids, `updatedAt`, `writerId`, and `v1.<iv>.<ciphertext>` boxes. Draft plaintext and key material never enter a sync request, a feed/provider request, or server logs.

Turning sync on creates a recovery code. The browser imports it again as a non-extractable key and does not retain the code. Entering the code on another device enrolls that device. Retired keys remain available so older boxes can still be opened. A box no available key can open stays in storage and is reported as `locked with another key`; it is never silently discarded.

`updatedAt` and `writerId` order every record. Newer timestamps win, and the smaller writer id breaks a tie. Deletions are tombstones in the same order, so an offline device cannot resurrect or overwrite a newer draft. The control plane applies the same order transactionally. Successful-post cleanup writes a tombstone through the same local path.

## Privacy and threat model

### Fixed-message wallet signatures

Fiddy deliberately does not derive a draft key from a custody signature. Reusing an authentication signature would conflate two permissions, exclude app-key-only accounts, and produce unstable keys for some smart-contract wallets. Enrollment instead generates an independent AES key and shows a separate recovery-code explanation. It costs nothing and sends no signature.

### Key loss and server compromise

Losing every copy of the recovery code and every enrolled browser means the ciphertext cannot be recovered. Fiddy has no backdoor. A server compromise exposes ciphertext, ids, timestamps, and writer ids, but not draft plaintext or keys. The server can delete, replay, withhold, or reorder boxes; AES-GCM authentication and FID/id-associated data prevent undetected modification or cross-account swapping, but not rollback to an older valid box.

### Smart-contract and social accounts

No custody signature or deterministic contract-wallet behavior is assumed. SIWF, app-key-only, social, EOA, and smart-contract accounts all use the same recovery-code enrollment. A Farcaster owner session is still required for per-FID server authorization. If that session cannot be established, sync stays off and local drafts continue.

### Device revocation and account removal

Turning sync off stops future requests from that browser; it does not claim to delete ciphertext already stored. `DELETE /api/fiddy/drafts` removes all active boxes and tombstones for the authorized FID and is the account-removal operation. Revoking a device's local key requires deleting its browser data. Other devices keep their keys. There is no remote per-device key registry to revoke, and the threat model does not pretend otherwise.

### Local storage and retention

The server holds at most 100 active records and 200 tombstones per FID. It uses private SQLite storage, strict body/box validation, per-FID authorization, rate limits, and atomic writes. Local tombstones are bounded to 200. Existing local size/count limits and the 14-day composer-recovery expiry remain in force. Server ciphertext has no time-based expiry: it remains until overwritten, removed by account deletion, or covered by a future retention policy.

## Verification boundaries

Unit tests cover encryption, wrong keys, tampering, malformed data, account isolation, offline writes, conflict order, remote merge, locked boxes, and no plaintext in outbound requests. The browser probe covers recovery, enrollment, locked state, account switching, and both responsive widths. No probe mints a live signer or writes production draft data.
