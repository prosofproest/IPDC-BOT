# IPDC Discord Bot

Community bot for the **INVICTUS PROJECT DEVELOPMENT CENTRE (IPDC)**. Node.js 22, discord.js v14, Cloud Firestore, GitHub App monitoring, Gemini with immediate Groq failover, SMTP PDF reports, timezone-aware scheduling (`Asia/Kolkata`).

Built from `IPDC_Discord_Bot_Master_Specification.md`. See `docs/ACCEPTANCE.md` for a requirement-by-requirement map and `docs/ARCHITECTURE.md` for the design.

> **Before first start you must supply two things the handoff did not contain:**
> 1. **The exact Code of Conduct** — replace the entire contents of `config/code-of-conduct.txt`. The bot posts it verbatim. While the placeholder is present, onboarding refuses to continue and staff are alerted in `#admin-audit-logs`.
> 2. **Real credentials** — entered only in the host's environment/secrets panel (never in the repo).

## What it does

| Area | Summary |
|---|---|
| Startup reconciliation | Idempotent. Reuses objects by persisted ID, adopts matching existing ones, creates only what is missing, repairs only missing permission bits, never deletes. Locked against overlapping runs. |
| Onboarding | Temporary private welcome channel (deleted after 10 min via a durable queue), exact welcome embed with the unaltered official logo, verbatim Code of Conduct, accept/decline, role application with verified GitHub profile. |
| Approvals | Member join and same-PM team change go to that PM's private control channel. PM applications and cross-PM transfers go to `#admin-approvals`. Server-side authorization on every click. |
| Admin Panel (IPDC GRID) | Dashboard, PM management, team roles, role-to-PM mapping, applications, resources, tickets, permissions, audit logs, settings, challenges, GitHub override, structure repair, explicit destructive cleanup. |
| PM Control Panel | Set/change monitored repository (validated against GitHub App access), team overview, pending requests, refresh. |
| Support | Category ticket flow, private ticket channels, claim / add member / close / reopen, transcripts, optional Support Voice access, role/team change requests routed per spec. |
| GitHub | Identity linking (duplicates blocked), persistent heatmap message (edited daily 9 PM IST), leaderboard, server activity, PM `#github-activity`, Admin `#server-monitoring`, challenges, private inactivity notices, webhook near-live refresh. |
| Reports | One PDF per PM team per day, emailed over SMTP, delivery status shown on dashboards, failed sends retried automatically. |
| AI | Gemini first; any error, timeout or unusable output falls back to Groq immediately. Prompts are never logged. |

## 1. Discord setup

1. Discord Developer Portal → your IPDC application → **Bot**.
2. Enable **Privileged Gateway Intents**: **Server Members Intent** (join detection, member lookups) and **Message Content Intent** (ticket transcripts). Presence intent is not needed.
3. Invite the bot with this URL (replace `CLIENT_ID`). Permission integer `326687124560` is least-privilege: View Channels, Send Messages (+ in threads), Embed Links, Attach Files, Read History, Add Reactions, Manage Messages, Manage Channels, Manage Roles, Manage Threads, Create Public Threads, Connect. It does **not** include Administrator.
   `https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot%20applications.commands&permissions=326687124560`
4. **Role order matters.** In Server Settings → Roles drag the bot's role **above** `IPDC` and every PM/team role it will manage, but **below** `IPDC GRID` and `ADMIN`. The bot can then never touch those two roles (it is also hard-coded to refuse).
5. Assign `IPDC GRID` to yourself/trusted operators manually. The bot never assigns it.

## 2. Firebase setup

1. Firebase Console → create a project → **Firestore Database** (production mode).
2. Project settings → Service accounts → **Generate new private key**. Copy only `project_id`, `client_email`, `private_key` into the three `FIREBASE_*` variables. **Do not put the JSON file in the repo.**
3. Deploy `firestore.rules` (denies all client access; the Admin SDK bypasses rules).

## 3. GitHub setup

1. GitHub → Settings → Developer settings → **GitHub Apps → New**. Repository permissions (read-only): **Contents**, **Metadata**, **Pull requests**, optionally **Issues**. No write access.
2. Generate a private key; install the app on the organization/repositories PMs will monitor; note the **App ID** and **Installation ID** (from the installation URL).
3. Optional webhook: URL `https://<your-host>/github/webhook`, content type JSON, secret = `GITHUB_WEBHOOK_SECRET`, events Push + Pull request. Requires the host to expose `PORT`.
4. Alternative to an App: a read-only fine-grained token in `GITHUB_TOKEN`.

Contribution heatmaps use GitHub's public contribution calendar (GraphQL). If that is unavailable for a member the bot falls back to commits in the PM's monitored repository and labels the source in the data model. Production never uses sample data.

## 4. Environment variables

See `.env.example` for every name. Where to get each, and where it goes on Bot-Hosting.net (panel → your app → **Startup / Environment variables**):

| Variable | Obtain from |
|---|---|
| `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` | Developer Portal → Bot → Reset Token / General Information → Application ID |
| `DISCORD_GUILD_ID` | Discord Developer Mode → right-click server → Copy Server ID |
| `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` | Firebase service account key (see above). Newlines may be pasted as literal `\n`; the bot normalizes them. |
| `GEMINI_API_KEY` | Google AI Studio |
| `GROQ_API_KEY` | Groq Console → API Keys |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_INSTALLATION_ID`, `GITHUB_WEBHOOK_SECRET` | GitHub App (see above); webhook secret is a random string you generate |
| `SMTP_HOST/PORT/USER/PASS/FROM`, `REPORT_RECIPIENT_EMAIL` | Your SMTP provider (use an app password). Extra recipients can be added in Admin Panel → Server Settings. |
| `CLOUDINARY_*` | Not used by this version (no media upload feature); safe to leave unset. |
| `LOG_LEVEL`, `TZ` | `info`, `Asia/Kolkata` |

Required to boot: Discord, Firebase, Gemini, Groq. GitHub and SMTP are optional at boot: if absent the related features are disabled with a clear warning in the logs rather than silently dropped.

## 5. Deploying on Bot-Hosting.net

1. Create a **Node.js** app and select **Node.js 22**.
2. Source: connect the private GitHub repository (authorize only that repo), production branch `main` — or upload this project as an archive.
3. Add the environment variables from section 4 in the host's secrets configuration.
4. Startup command: `npm start`. Dependencies install from `package-lock.json`.
5. Start the app and read the logs. A healthy boot shows: `Firestore connected` → `logged in as …` → `reconciliation (startup): reused=… created=…` → `panels ensured` → `scheduler started` → `IPDC bot ready`.
6. Enable "auto pull on restart" only if you want redeploys on restart. **A restart never recreates server objects** — everything is looked up by persisted ID.
7. Updates: commit, push, pull/redeploy, confirm the startup summary shows `created=0`.
8. If your host provides a port, set `PORT` to enable `/health` and the GitHub webhook endpoint.

## 6. First-run checklist

1. Put the real Code of Conduct in `config/code-of-conduct.txt` and redeploy.
2. Open `#admin-panel` (visible to IPDC GRID only). **Team Roles → Add** (e.g. Frontend, Backend, UI-UX). Each creates a role and a resource forum.
3. **PM Management → Add PM**, pick the Discord member, enter the PM's name. This creates the PM role, a category named for the PM, `-control`, `-updates`, `github-activity`, and two voice channels.
4. **Role-to-PM Mapping** → choose the team roles for each PM; per-team text channels are created.
5. The PM sets the repository in their `-control` channel (**Set Repository**). The GitHub App must have access to it.
6. Share `#welcome`. New members click **BEGIN VERIFICATION** (or get a private channel automatically on join).
7. Slash commands: `/ipdc help | status | link-github | reconcile`.

## 7. Development

```bash
npm ci
npm run verify      # import check + 35 tests (no credentials or network needed)
npm run dev         # needs a real .env
```
Tests use an in-memory store and a fake Discord guild; they cover reconciliation idempotency, permission repair, the authorization matrix, approval workflows, exact welcome copy, AI failover, webhook signatures, the retry queue, secret redaction, and PDF/heatmap rendering.

## 8. Known limitations (read this)

- **Not yet run against live Discord, Firebase, GitHub, Gemini/Groq or SMTP.** Everything that can be verified offline is (see tests). Run the host acceptance checklist in `docs/ACCEPTANCE.md` on first deploy; fix-forward items are most likely in API-specific details (GitHub App permissions, SMTP TLS mode, intent toggles).
- Discord cannot AND roles in permission overwrites. PM team text channels therefore use per-member overwrites (granted/removed on approval and repaired by reconciliation); resource forums use the team role.
- Discord has no hover tooltips on images; commit detail is exposed via buttons/selects on the heatmap message.
- Discord cannot animate native UI. The experience relies on embeds, edits and interaction states. No animated GIF is bundled because none was supplied.
- Activity counts are evidence of GitHub activity, not a productivity score; this is stated on every dashboard.
- `npm audit` reports 6 moderate advisories inside `firebase-admin`'s transitive dependencies; they need an upstream release (not fixable here without a breaking downgrade).
