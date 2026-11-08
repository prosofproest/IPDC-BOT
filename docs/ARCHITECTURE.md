# Architecture

```
src/
  index.js              wiring, intents, startup sequence, shutdown
  config/               env validation (fails fast), exact welcome copy, role-ID defaults
  storage/              Firestore store (production) / memory store (tests) - same interface
  core/
    structure.js        PURE: config state -> desired channels/roles + permission overwrites
    reconcile.js        idempotent reconciliation, registry, lock, targeted permission repair
    guildAdapter.js     thin discord.js wrapper (fakeable)
    auth.js             authorization matrix (spec section 14)
    roles.js            role changes with protected-role guard + verification
    messages.js         persistent long-lived messages, edited in place
    queue.js            durable retry queue (welcome-channel deletion, role retries, report retries)
    managed.js          explicit admin rename/delete/orphan discovery (never run at startup)
    audit.js, state.js, router.js, managed.js
  features/             onboarding, requests (approvals), admin, pm, support, github UI, panels
  github/               client, activity collector, monitoring/dashboards, heatmap renderer, PDF reports
  services/             ai (Gemini->Groq), mailer, health
  scheduler.js          node-cron 21:00 Asia/Kolkata + missed-run catch-up
  webhook.js            /health and signed GitHub webhook
```

## Key invariants
- **Identity is the saved object ID**, stored in the Firestore `registry` collection under stable keys (`pm:<id>:category`, `pm:<id>:team:<teamId>:text`, `resource:<teamId>:forum`, `msg:<key>`). Names are labels.
- **Reconciliation**: reuse -> adopt by (type, parent, name) -> create missing only. Permission repair sets only the required bits and never removes other bits or overwrites. A Firestore lease lock plus an in-process coalescing guard prevent overlap.
- **No destructive action without an admin click**: PM/team removal and orphan cleanup require a confirmation step and are audited.
- **Authorization is enforced in handlers** (`Auth.can`) and again by Discord overwrites. `IPDC GRID` and `ADMIN` role IDs are on a protected list: `RoleService` throws before any API call.
- **Durable timers**: the 10-minute welcome-channel deletion is a persisted queue job, so it survives restarts.
- **Dashboards**: each is one persisted message; refreshes edit it (content-hash skip when unchanged). If a stored message vanishes, a tagged bot message is searched for before creating a new one.
- **Secrets**: environment only; the logger redacts every configured secret, private-key blocks, Discord and GitHub token shapes.

## Firestore collections
`registry`, `config`, `pms`, `teams`, `members`, `githubLinks`, `requests`, `tickets`, `transcripts`, `challenges`, `audit`, `queue`, `welcomeChannels`, `stats`, `jobs`, `alerts`, `reportStatus`, `aiSummaries`, `counters`, `locks`.
