# Acceptance map

`[T]` = covered by an automated test in `tests/` (run `npm test`). `[M]` = manual check on first deploy (needs live credentials).

## Spec section 16 - onboarding
1. Private temporary welcome channel, unrelated members cannot view - [M] (overwrites built in `onboarding.js`; member-visibility logic mirrors tested reconciler permissions)
2. Exact welcome copy, title, footer, button - [T] `welcome embed uses the exact owner-specified copy`
3. Logo unaltered - [T] byte-identical hash test; embed references `attachment://`
4. CoC verbatim - [T] verbatim load and chunking tests (text must be supplied by owner)
5. Accept opens application, decline grants nothing - [M]
6. Channel deleted after 10 minutes, failures retried/logged - [T] queue retry/restart test; [M] end-to-end
7. Restart does not duplicate structure/messages - [T] reconcile idempotency tests; message edit-in-place logic [M]
8. Readable on desktop/mobile - [M]

## Section 11 - reconciliation
Reuse, adopt, create-missing-only, targeted repair, no deletion, lock, stale-ID re-adoption, renamed channel reuse - all [T].

## Section 14/15 - authorization & roles
Matrix [T]; GRID/ADMIN never assignable [T]; PM-only initial approval, Admin-only PM approval/transfer, current-PM team change [T]; role failure queued for retry [T].

## Section 19-21 - stack & deployment
- Node 22, ESM, discord.js v14, scripts `start/dev/check` - [T] `npm run verify`; lockfile committed (`npm ci`)
- `.env.example` complete; secrets ignored by `.gitignore` - verified by file scan
- Gemini->Groq immediate failover, timeout, both-fail handling - [T] (forced Gemini failure); live keys [M]
- Scheduler 21:00 Asia/Kolkata + catch-up - [T] slot calc; live firing [M]
- Webhook signature verification - [T]
- PDF + heatmap generation - [T]; SMTP delivery [M]; GitHub App read-only scope [M]
- Redeploy on Bot-Hosting.net creates no duplicates - [M] (look for `created=0` in the startup summary)

## Manual deploy checklist
- [ ] `npm ci` succeeds, `npm start` boots, log shows `IPDC bot ready`
- [ ] Bot role is above IPDC/PM/team roles and below IPDC GRID / ADMIN
- [ ] Server Members + Message Content intents enabled
- [ ] Code of Conduct file replaced; test the welcome flow with an alt account
- [ ] Team role, PM, mapping created via Admin Panel; PM sets repository
- [ ] Restart twice: second and third startup summaries show `created=0 repaired=0`
- [ ] Open a ticket as a member; confirm only opener, ADMIN, IPDC GRID and bot can see it
- [ ] Trigger `Refresh Activity`; confirm heatmap message is edited (same message ID) not re-posted
- [ ] Send a test report (wait for 9 PM IST or lower the schedule temporarily) and confirm the email + PDF
