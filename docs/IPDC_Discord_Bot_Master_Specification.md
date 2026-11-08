# IPDC Discord Bot — Master Specification
**Project:** INVICTUS PROJECT DEVELOPMENT CENTRE (IPDC)  
**Status:** Planning baseline consolidated from the decisions made in chat  
**Naming standard:** Professional names only. No emojis in categories, channels, roles, or bot panel labels.

---

## 1. Core rules

- The `IPDC` role is the common member role for approved members.
- `IPDC GRID` is the administrator-equivalent bot role. It has full bot Admin Panel permissions and server-wide bot monitoring access.
- `IPDC GRID` is manually assigned by the server owner/admin; the bot must not assign it automatically.
- `IPDC GRID` role ID: `1568690888413282396`
- Separate `ADMIN` role ID: `1568690393824891141`. Do not treat this role as the full administrator-equivalent role unless explicitly configured.
- Support access is for the `ADMIN` role and `IPDC GRID`, plus the ticket creator and bot as needed for each ticket.
- PM names and team roles are configured by the owner/admin through the Admin Panel. They must not be hardcoded.
- Team roles are dynamic: creating/editing/removing a team role updates its associated channel/resource access configuration.
- One PM team works on one active GitHub repository at a time. The PM can change the monitored repository through their PM Control Panel.
- Each member supplies their GitHub profile URL during initial role application so the bot can associate Discord identity with GitHub identity.
- The same daily Discord GitHub heatmap message is edited in place; no daily duplicate messages.
- The bot must use least-privilege permissions, audit important actions, and keep secrets out of source code and Discord messages.

## 2. Roles and access

### Core roles
- `IPDC`: approved member base role.
- `IPDC GRID`: full bot administrator-equivalent role.
- `ADMIN`: separate role ID `1568690393824891141`; support access is included as stated. Any additional permissions should be configurable.
- PM name roles: dynamically configured per PM.
- Team/work roles: dynamically configured by Admin Panel.

### Member role assignment
- Approved student: `IPDC` + one selected team role + one PM-name role.
- Approved PM: `IPDC` + their PM-name role.
- A member has one active team role and one PM affiliation at a time.
- The exact role application rules are governed by the owner/admin-configured role and PM entries.

## 3. Server categories and channel structure

All names below use plain professional naming, no emojis. Dynamic `<PM NAME>` and `<TEAM ROLE>` values are generated from Admin Panel configuration.

### Public/member-visible categories

#### `WELCOME`
- `#welcome` — entry point and verification instructions.
- New member gets a temporary private welcome channel visible to the joining member, authorized staff and bot.
- Welcome embed uses the official IPDC logo (owner will provide it when handing the files to Claude).
- **Use this exact welcome embed copy:**
  - **Title:** `WELCOME TO IPDC`
  - **Description:** `Welcome, {member_mention}, to the INVICTUS PROJECT DEVELOPMENT CENTRE (IPDC).`
  - **Body:** `IPDC is a collaborative project development community where members come together to build, learn, share knowledge, and turn ideas into meaningful projects. We value commitment, teamwork, responsible participation, and continuous growth.`
  - **Next step:** `Before accessing the community, please review and accept the IPDC Code of Conduct. Your participation begins with understanding the standards that keep this community respectful, focused, and productive.`
  - **Button:** `CONTINUE TO CODE OF CONDUCT`
  - **Footer:** `INVICTUS PROJECT DEVELOPMENT CENTRE | Member Onboarding`
- Keep the embed polished, concise, and professional. No emojis. Do not add unofficial claims, slogans, or extra welcome copy.
- Clicking `CONTINUE TO CODE OF CONDUCT` displays the Code of Conduct exactly as supplied by owner; do not paraphrase or rewrite it.
- Member selects `I AGREE — ACCEPT CODE OF CONDUCT` or `I DO NOT AGREE`.
- Accept continues to role application. Reject remains unverified / does not receive member access.
- Temporary welcome channel is deleted after 10 minutes.

#### `GENERAL`
- `#announcements` — official server-wide announcements; read-only for members.
- `#general` — approved IPDC member discussion.
- Voice channels: `General Meeting`, `Open Discussion`.

#### `CHALLENGES`
- `#github-contributions` — one persistent post/message containing individual member heatmaps; visible to `IPDC`, read-only for members.
- `#contribution-leaderboard` — server-wide contribution ranking; visible to `IPDC`, read-only for members.
- `#server-activity` — server-wide and PM team activity dashboard; visible to `IPDC`, read-only for members.
- `#github-challenges` — coding/contribution challenges; visible to `IPDC`.
- Voice channels: `Coding Room`, `Collaboration Room`.

#### `IPDC RESOURCES`
- One Discord Forum resource channel per configured team role, e.g. `#frontend`, `#backend`, `#ui-ux`.
- Resources are forum posts for external links and material (GitHub, YouTube, Telegram, sites, tutorials, PDFs, etc.).
- Only members with `IPDC` and the matching team role can view that role’s resource forum.
- `IPDC GRID` can view/manage all resource forums.
- Creating a team role through Admin Panel creates the matching resource forum and applies access permissions.

### PM-specific categories (one per PM; category named exactly for PM name)

Each `<PM NAME>` category includes:
- `#<pm-name>-control` — private PM application/role application/change request channel; visible to assigned PM, `ADMIN`, `IPDC GRID`, and bot.
- `#<pm-name>-updates` — PM announcements, deadlines, meeting updates. PM can post; members assigned to that PM can read; Admin roles can view/manage; bot may post system updates.
- One text channel for each configured team role in that PM’s team, created dynamically and access-restricted to the assigned PM team.
- `#github-activity` — PM-specific daily consolidated GitHub activity/report channel, separate from PM updates.
- Voice channels: `Team Meeting`, `Project Discussion` (visible only to that PM’s assigned team and authorized Admin roles).

Each PM is responsible only for their own project/team. PM category name is the PM’s actual name, not Alpha/Beta or a code.

### `IPDC SUPPORT`
- `#support-center` — ticket entry with categories: Technical Support, Role/Team Issues, Resource Help, Project Related, Other.
- Voice channel: `Support Voice` (only ticket creator and authorized support staff can access when a ticket requires voice support).

### `SUPPORT TICKETS`
- Private ticket channels created per request, e.g. `#ticket-001-<member>`.
- Ticket visibility: ticket creator, `ADMIN`, `IPDC GRID`, and bot. No other members or PMs unless explicitly added.
- Ticket controls: `Claim Ticket`, `Add Member`, `Close Ticket`, `Reopen Ticket`.
- Save transcript and log ticket actions.
- Support staff roles are configurable; current support access baseline is `ADMIN` and `IPDC GRID`.

### `ADMIN CONTROL`
- `#admin-panel` — private bot panel for `IPDC GRID`.
- `#server-monitoring` — private consolidated monitoring dashboard for `IPDC GRID`.
- `#admin-approvals` — PM application and cross-PM transfer approval channel.
- `#admin-audit-logs` — bot/server configuration and workflow audit trail.
- Voice channels: `Admin Meeting`, `PM Coordination`.
- `IPDC GRID` is the administrator-equivalent bot role. Only it can use full Admin Panel controls and see server-wide monitoring.
- Admin Panel functions: dashboard, PM management, team role management, role-to-PM mapping, application approvals, resources, support ticket management, permissions, audit logs, server settings.

## 4. Welcome, applications, and transfers

### Initial role application
- Member accepts Code of Conduct.
- Member selects the desired team role, then the PM/project.
- Member submits their GitHub profile URL.
- Request routes to the selected PM’s private `control` channel.
- PM approves/rejects.
- On approval, bot assigns `IPDC`, selected team role, and PM-name role; grants the relevant category/channel/forum access.
- PM application (applicant chooses PM position) does not select a PM; it routes to Admin approval.

### Change team role under same PM
- Member opens support ticket and requests a new role.
- Request routes to the current PM only.
- Upon approval, bot removes old team role and assigns new team role. `IPDC` and PM-name role remain unchanged.

### Change PM and team role
- Member opens support ticket and selects new PM and role.
- Request routes to `#admin-approvals`.
- Upon Admin approval, bot removes old PM-name and team roles, then assigns new PM-name and team roles. `IPDC` remains.
- Old access/roles remain until approval.
- Log approvals, rejections, transfers and role changes.

## 5. GitHub integration and monitoring

### Member GitHub identity
- Each member submits GitHub profile URL during onboarding/application.
- Verify the profile exists and associate its username with the Discord member.
- Prevent duplicate account mapping unless an Admin overrides it.
- Keep a member-to-GitHub username mapping.

### Repository ownership/configuration
- One PM team uses one active repository at a time.
- PM can set/change the repository from PM Control Panel.
- PM cannot alter the GitHub App/token permissions.
- Admin configures GitHub App access. Read-only access required for repository metadata, contents/commit data and pull requests as needed.
- Credentials are kept in hosting environment secrets, never committed or posted.

### Live data features
- `#github-contributions`: individual heatmaps for all registered members in one persistent message.
- Update the existing message daily at 9 PM IST; do not create a new message each day.
- Real GitHub data only in production; sample data only in demos.
- Discord cannot provide custom hover tooltips on image squares. Commit detail should be accessible through interaction/buttons or a linked web view.
- `#contribution-leaderboard`: server-wide member contribution ranking.
- `#server-activity`: dashboard for the whole IPDC server and PM teams.
- `#github-challenges`: server-wide coding/contribution challenges.
- PM `#github-activity`: consolidated activity for that PM team.
- `#server-monitoring` (Admin only): PM-separated whole-server monitor, including assigned members, repository, commit/branch/PR activity, inactivity status, team overview, pending applications/support tickets and monitoring health.
- Inactivity alerts route to the relevant PM for their members; Admin can see server-wide inactivity. Configurable inactivity duration. Avoid public shaming.
- GitHub monitoring includes commits, branches and PRs. GitHub Issues/milestones may be included where teams use them.
- Treat activity counts as evidence of GitHub activity, not a definitive productivity score.

### Daily report
- Generate one daily consolidated PDF per PM team containing member identities, repository, branches, timestamps, commit messages, commit links, file change stats where API provides them, and PR summary.
- Email to configured recipient(s) using Admin-provided SMTP settings.
- SMTP secrets are stored only as environment variables.
- Report delivery status can be posted in PM activity/admin monitoring channels.

## 6. Support ticket behavior
- Ticket is created as private channel with permissions for opener, `ADMIN`, `IPDC GRID`, and bot.
- Tickets are isolated from other members.
- Actions include claim, add member, close/reopen, transcript export.
- Logs capture ticket creation, staff actions, closure and reopening.
- Support categories are configurable; role/team requests use the workflows in Section 4.

## 7. Voice channel permissions
- General voice: all `IPDC` members.
- PM team voice: members of that PM’s team plus authorized Admin roles.
- Support voice: ticket opener and support staff only, as needed.
- Admin voice: `IPDC GRID` only.
- Voice channels should be created/configured dynamically with PM/team setup where appropriate.

## 8. Security, deployment, and implementation
- Runtime: Node.js 22 and Discord.js.
- Hosting target: Bothosting.net.
- Source control: private GitHub repository.
- Secrets: Discord bot token, GitHub App credentials, SMTP credentials and other keys stored as environment variables/hosting secrets.
- No public Admin registration or self-assignment of `IPDC GRID`.
- Enforce Discord channel permission overwrites and bot-side authorization checks; never rely only on hiding UI controls.
- Use audit logs for administrative changes.
- Persist IDs for long-lived messages (heatmap, dashboards) so bot edits existing messages after restarts.
- Use scheduled jobs for daily reports/refresh and webhooks where supported for near-live GitHub activity.
- Include error handling, retry queue, monitoring health and rate-limit handling.

## 9. Owner-provided items / configurable values

The owner will configure through Admin Panel or deployment:
- PM names and PM assignments.
- Team roles, role IDs, edits and removals.
- PM-to-team-role mappings.
- Support categories and staff configuration.
- GitHub organization/repositories and App access.
- GitHub profile links from members.
- SMTP email recipient/settings.
- Official IPDC logo and exact Code of Conduct text.
- Admin role IDs and any additional permission settings.

Known role IDs:
- `IPDC GRID`: `1568690888413282396` — administrator-equivalent bot access.
- `ADMIN`: `1568690393824891141` — separate role; support access baseline, not the full Admin Panel role by default.

## 10. Completion criteria
- Categories/channels/voice channels are created with the intended professional naming and permission boundaries.
- Dynamic PM/team-role creation works through Admin Panel without hardcoding names.
- Member verification and PM/Admin approval workflows work as specified.
- Private support tickets are isolated.
- GitHub profiles are verified and linked to Discord identities.
- PM repository selection/change is supported with authorized GitHub access.
- Contribution heatmap and dashboards use real GitHub data in production.
- Daily update edits the same Discord message.
- PM-specific reports and Admin server monitoring show appropriate scoped data.
- Bot secrets are not committed or exposed.
- Admin actions are auditable.


---

# 11. Startup reconciliation — critical anti-duplication requirement

**The bot must never rebuild the server structure on every restart.**

On startup, run an idempotent reconciliation process:
1. Fetch the guild and the bot's persisted server-structure registry.
2. Compare each configured category, channel, role, forum, and voice channel against existing Discord objects.
3. If the expected object exists, reuse it and preserve its ID. Do not create another copy, rename it unnecessarily, or reset its permissions.
4. Create **only genuinely missing objects**.
5. If an object exists but is missing a required permission overwrite, repair only that missing/incorrect overwrite.
6. Update the persistent registry with newly created IDs.
7. Log a concise reconciliation summary (reused / created / repaired / skipped / errors).
8. Never delete existing channels, categories, roles, messages, or member data automatically during startup reconciliation.

### Object identity and persistence
- Store guild ID and IDs for every managed category/channel/role/forum/voice channel and long-lived message in persistent storage (Firestore or a durable database/config store).
- Use stable internal keys such as `pm:<pmId>:category`, `pm:<pmId>:team:<teamRoleId>:text`, `resource:<teamRoleId>:forum`, not only channel names.
- Names can change. The saved object ID is the primary identity; name is a display label.
- When a stored ID no longer resolves, search for an existing matching managed object before creating one. Avoid duplicate names by checking parent category and stable key/registry.
- The bot must not recreate all channels because the process restarted, redeployed, crashed, or the hosting container restarted.
- Do not rely on in-memory variables for created-object IDs.
- Provide an Admin Panel action for deliberate structure repair/reconciliation. Destructive cleanup must be a separate explicit Admin action with confirmation and audit logging.
- Reconciliation must be safe to run repeatedly (idempotent), including simultaneous/repeated startup events. Use a lock/guard to prevent overlapping runs.

### Startup pseudocode contract
```text
onReady:
  acquire reconciliation lock
  load persisted managed-object registry
  for each configured object:
    if persisted ID exists and Discord object exists:
      reuse it
      repair only required permissions if needed
    else:
      find matching managed object by stable key/parent/name
      if found:
        adopt and persist its ID
      else:
        create this missing object only
        persist its ID immediately
  report summary
  release lock
```

---

# 12. Welcome logo asset and image behavior

- The supplied official logo is included beside this specification as `IPDC_Official_Logo.png`.
- Use this exact image in the welcome embed/image area. Do not redraw, alter, recolor, crop away the logo, replace it with an AI-generated logo, or use a placeholder.
- Claude may place the asset in the bot's assets folder and reference it with a relative path. Include it in the repository and deployment package.
- The logo may be shown as the embed thumbnail or as the welcome embed's primary image according to the polished layout. Preserve the complete mark and tagline “DEPTH CREATES ADVANTAGE”.
- If Discord attachment-based embeds are used, upload the image as an attachment and use a `attachment://` reference. If using a CDN-hosted asset, use a stable URL controlled by IPDC.

---

# 13. Animation and visual experience requirements

The server and bot UI should feel polished, lively, and modern, while remaining professional and usable. Avoid emoji-based decoration in channel names, role names, categories, and panel titles.

### Where animation is expected
- Welcome screen: subtle animated entrance/transition where Discord's supported interface allows it; the supplied logo remains unchanged. Use a tasteful animated GIF/looping banner if a real animation asset is created or supplied. Prefer subtle motion, not flashing.
- Bot embeds/panels: use progressive interaction states (loading, success, error), ephemeral confirmations, button/select-menu interactions, and smooth updates through Discord's native UI.
- Dashboards: update/edit existing dashboard messages rather than posting repeated snapshots. Use charts/visuals generated as images only when useful.
- GitHub heatmaps: green contribution cells and polished visual presentation, refreshed by editing the persistent message.
- Progress indicators: use Discord-native loading/deferred responses and clear status labels.
- Optional animated assets can be used in bot profile/banner or embeds only where Discord supports them and assets are actually available.

### Platform limitation and accessibility
- Discord does not allow a bot to add arbitrary CSS animations or custom transitions to native channel UI, embeds, buttons, or select menus. Do not promise impossible server-wide animation.
- Use supported animated GIF assets, polished embeds, button interactions, message edits, and status states to create the lively feel.
- No rapid flashing, strobing, or motion that impairs readability. Respect reduced-motion preferences where a linked web dashboard is implemented.
- Keep all text readable, layouts clean, and functional workflows more important than decorative effects.

---

# 14. Detailed authorization matrix

Authorization must be enforced in both Discord permission overwrites and bot interaction handlers. A visible button is not proof of authorization.

| Action / data | Member (`IPDC`) | PM role / assigned PM | `ADMIN` | `IPDC GRID` |
|---|---|---|---|---|
| View own profile/progress/photos/recommendations | Own only | Only if explicitly shared / PM-scoped need | Support context only; no blanket personal-data access | Full server admin panel access; sensitive data access should still be audited and minimized |
| View PM control and PM updates | Assigned PM scope | Own PM only | View/manage per configured support/admin permissions | All PMs |
| Approve initial team application | No | Assigned PM only | No, unless explicitly configured | Override/admin |
| Approve PM application | No | No | Yes | Yes |
| Approve cross-PM transfer | No | No | Yes | Yes |
| Approve same-PM team-role change | No | Current PM only | Support/override only if configured | Override/admin |
| View team text/voice/resource channels | Own team only | Own PM team | Per configured permissions | All |
| Create/edit resource posts | No by default | As configured | Support/admin permissions | All |
| Create/manage support tickets | Create own, view own | Not by default | All tickets | All tickets |
| Manage dynamic PM/team configuration | No | Own PM configuration only, limited | Admin panel permissions only if granted | Full |
| Change GitHub monitored repository | No | Own PM only | Can view/configure server integration | Full |
| View whole-server monitoring | No | No; own PM dashboard only | Only if explicitly granted | Yes |
| Assign `IPDC GRID` | Never | Never | Never by bot | Bot must never assign this role; owner manually assigns |
| View audit logs | Own relevant ticket/status where exposed | Own PM-scoped logs | Admin-scoped logs | Full |

**Data privacy interpretation:** `IPDC GRID` is a privileged server role, but application code should still minimize personal data returned in dashboards and log every privileged access to sensitive member records. Coaches/PMs must never receive private member photos, health-related details, or progress data unless the member explicitly shares the relevant data and the scope is clearly limited.

---

# 15. Role definitions and assignment rules

- **`IPDC`**: common role assigned only after member accepts the Code of Conduct and their application is approved. It grants the baseline approved-member access.
- **`IPDC GRID`**: manually assigned, administrator-equivalent role for trusted server operators. Full bot panel and server-monitor access. Bot must never grant/remove this role through self-service workflows.
- **`ADMIN`**: separate support/admin operations role. Role ID is `1568690393824891141`. Baseline support ticket access. It is not automatically equivalent to `IPDC GRID`; individual Admin Panel permissions are explicitly configured.
- **PM-name role**: identifies a member's approved project manager/team affiliation. One active PM affiliation per member unless owner config explicitly permits otherwise.
- **Team/work role**: indicates the member's active skill/team assignment, dynamically configured. One active team role per member unless owner config explicitly permits otherwise.
- **Pending applicant**: no `IPDC` member access, no PM/team roles until approval. They may interact only with the private onboarding/application workflow.
- **PM applicant**: submitted application for PM role; routed to `ADMIN`/`IPDC GRID` approval. Do not assign PM-name role before approval.
- **Bot role**: grant only the Discord permissions necessary for its workflows. Avoid Discord Administrator permission if channel-level permissions and explicit bot authorization suffice; role position must be above roles/channels it manages but below owner-controlled `IPDC GRID` role as appropriate.

All role changes must be transactional as far as Discord API permits: validate target roles and mapping, apply change, confirm success, then persist application status; on partial failure, retry safely and log it.

---

# 16. Welcome onboarding acceptance tests

1. New member receives a private temporary welcome channel; unrelated members cannot view it.
2. Welcome embed title, body, next-step copy, footer, and button match Section 3 exactly.
3. `IPDC_Official_Logo.png` is shown without altering the mark.
4. `CONTINUE TO CODE OF CONDUCT` displays owner-supplied CoC verbatim.
5. Accepting CoC opens the role application; rejecting does not grant member access.
6. Temporary welcome channel is deleted after 10 minutes; failure is retried/logged.
7. Restarting the bot does not duplicate welcome/category/server structure or long-lived dashboard messages.
8. Welcome embed remains readable on desktop and mobile, and animation does not obscure text.

---

# 17. Required build workflow for Claude

Claude should implement this specification in controlled phases rather than attempting a single unverified code dump:

1. **Inspect and plan:** inspect existing repository, dependencies, docs, environment, and current Discord server setup. Do not overwrite existing project files blindly.
2. **Foundation:** Discord.js client, config validation, secrets/env template, logging, durable storage, authorization middleware.
3. **Reconciliation engine:** stable IDs/registry, startup idempotency, missing-object creation only, permission repair, tests.
4. **Onboarding and role application:** welcome logo/embed, verbatim Code of Conduct, temporary channel, application workflow and PM/Admin approvals.
5. **Admin Panel and dynamic PM/team configuration:** role/channel/forum provisioning, scoped permissions, audit logs.
6. **Support system:** isolated tickets, controls, transcripts, support permissions.
7. **GitHub integration:** identity linking, PM repository configuration, persistent heatmaps, PM activity reports, leaderboard, server monitoring, scheduled PDF/email.
8. **Visual polish:** embeds, supported GIF assets, native Discord interaction states, dashboard layout.
9. **Verification:** unit/integration tests, permission test matrix, restart tests, duplicate prevention tests, API failure/rate limit tests, production build and deployment checklist.

At every phase: implement, run tests, report files changed, summarize unresolved blockers, and do not mark a feature complete without verification. Keep credentials and user-provided Code of Conduct text out of logs.

---

# 18. Final non-negotiable requirements checklist

- [ ] Full feature set in this document is implemented; do not arbitrarily omit features.
- [ ] Official logo supplied by owner is used as-is on welcome embed.
- [ ] Welcome copy is exact and Code of Conduct is verbatim owner content.
- [ ] Server naming is professional; no emojis in structural names.
- [ ] Dynamic PM names and team roles are configurable and not hardcoded.
- [ ] Permissions are scoped, validated server-side, and audited.
- [ ] Bot never self-assigns `IPDC GRID`.
- [ ] Startup reconciliation creates only missing objects and never duplicates the structure.
- [ ] Existing channel/message IDs are persisted and reused after restarts.
- [ ] Long-lived dashboard/heatmap messages are edited, not recreated.
- [ ] GitHub/SMTP/Discord credentials are environment secrets, not committed.
- [ ] Production data is real; demo data is clearly labeled.
- [ ] Errors, retries, API rate limits, and monitoring health are handled.
- [ ] User privacy and explicit member sharing are enforced.


---

# 19. Mandatory technology stack and deployment target

## Runtime and libraries
- **Runtime: Node.js 22 LTS** (use Node 22 in the Bot-Hosting.net runtime selector; do not choose Java/Python or a different runtime without owner approval).
- **Language:** JavaScript with modern ES modules (or TypeScript only if Claude implements a complete build/start pipeline).
- **Discord SDK:** Discord.js v14.
- **Persistent data:** Firebase Authentication + Cloud Firestore as specified for the project. Never store passwords in Firestore.
- **AI:** Gemini API is the primary provider; Groq API is the mandatory immediate fallback. If Gemini errors, times out, or returns unusable output, trigger Groq fallback immediately without waiting for a long retry. Use a short configurable timeout and log provider status without logging prompts containing private member data.
- **GitHub:** GitHub App or read-only fine-grained token for repository/contribution monitoring. PMs select/change the monitored repo through their PM panel; they do not configure credentials or permissions.
- **Image assets:** include `IPDC_Official_Logo.png` in repository assets. If Cloudinary is used for image hosting, its credentials are environment variables.
- **Email:** SMTP integration for scheduled PM reports/PDF delivery. SMTP values are configured as environment variables.
- **Scheduling:** timezone-aware jobs using `Asia/Kolkata` (IST), especially the daily GitHub heatmap/report schedule at 9:00 PM IST.

Claude must create a correct `package.json` with stable dependencies, scripts, and a lockfile. Minimum scripts:
```json
{
  "scripts": {
    "start": "node src/index.js",
    "dev": "node --watch src/index.js",
    "check": "node --check src/index.js"
  }
}
```
If the final entrypoint is not `src/index.js`, adjust these scripts to the actual entrypoint. Bot-Hosting.net production startup must use `npm start`; development/watch mode is not the production command.

## Bot-Hosting.net deployment walkthrough
The owner is deploying from the Bot-Hosting.net panel shown in the supplied screenshot:
1. Create/select a **Node.js** app/runtime and select Node.js **22**.
2. Source: connect the private GitHub repository (authorize access to this repository only if possible), choose the production branch (normally `main`), or upload the project archive if GitHub connection is not used.
3. Enable automatic pull on restart only if this is the desired deployment behavior. A restart must restart the application, not recreate Discord server objects.
4. In the host's environment variables / secrets configuration, add the variables from Section 20. Never place real secrets in the repository, Markdown handoff, `.env.example`, Discord channels, or logs.
5. Configure the application start command as `npm start` (or host's equivalent startup field). Ensure dependency installation runs from `package.json` / lockfile.
6. Start the app and inspect runtime logs. Validate Discord bot login, Firestore connectivity, scheduled jobs, and startup reconciliation summary.
7. For updates, commit and push to the selected GitHub branch, then use the host's pull/redeploy mechanism. Confirm health in logs.
8. Set a persistent data location only for any file-based state; prefer Firestore for managed-object registry, schedule state, message IDs, and application data. Do not depend on ephemeral container filesystem for durable records.

**Important:** The Bot-Hosting.net screenshot shows the source selection stage, not a completed deployment. Claude must produce the project and deployment-ready configuration; the owner still connects the GitHub repository and enters the real secrets in the hosting panel.

---

# 20. Environment variables and exact connection map

Claude must provide both:
- `.env.example` containing variable names and safe placeholder values only; and
- a deployment README explaining where each credential is obtained and which Bot-Hosting.net field receives it.

Do not create or commit a real `.env` file. Add `.env`, `.env.*` (except `.env.example`), service-account JSON, private keys, tokens, and credential files to `.gitignore`.

### Required / integration-dependent variables

| Variable | Purpose / connection | Where owner obtains it |
|---|---|---|
| `DISCORD_TOKEN` | Bot token used to log the Discord.js client into the Discord server | Discord Developer Portal → IPDC application → Bot → Reset/Copy Token |
| `DISCORD_CLIENT_ID` | Discord application ID for slash-command registration | Discord Developer Portal → General Information → Application ID |
| `DISCORD_GUILD_ID` | IPDC Discord server ID | Discord Developer Mode → right-click server → Copy Server ID |
| `FIREBASE_PROJECT_ID` | Firebase project identifier for Firestore | Firebase Console → Project settings |
| `FIREBASE_CLIENT_EMAIL` | Service account identity for server-side Firebase Admin SDK | Firebase Console → Project settings → Service accounts |
| `FIREBASE_PRIVATE_KEY` | Private key for Firebase Admin SDK; preserve newline handling | Firebase Console → Project settings → Service accounts → Generate private key; store only in host secrets |
| `GEMINI_API_KEY` | Primary Gemini API access | Google AI Studio / Google Cloud credential setup |
| `GROQ_API_KEY` | Mandatory Groq failover provider | Groq Console → API Keys |
| `GITHUB_APP_ID` | GitHub App identity for read-only monitoring | GitHub → Settings → Developer settings → GitHub Apps |
| `GITHUB_APP_PRIVATE_KEY` | GitHub App private key used for app authentication | GitHub App configuration; secret in host panel only |
| `GITHUB_INSTALLATION_ID` | Installation ID of the IPDC GitHub App on target repositories/org | GitHub App installation details |
| `GITHUB_WEBHOOK_SECRET` | Verifies incoming GitHub webhook signatures if webhooks are enabled | Owner-generated random secret; same value in GitHub webhook and host secrets |
| `SMTP_HOST` | Outgoing mail server hostname | SMTP provider |
| `SMTP_PORT` | SMTP port, typically provider-specific (often 587 or 465) | SMTP provider |
| `SMTP_USER` | SMTP account username | SMTP provider |
| `SMTP_PASS` | SMTP password/app password | SMTP provider |
| `SMTP_FROM` | Approved sender address/name for scheduled reports | Owner's configured SMTP mailbox |
| `REPORT_RECIPIENT_EMAIL` | Recipient for PM report PDF/email (admin configurable if multiple recipients) | Owner specifies |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary account name, if photo/media upload integration is implemented | Cloudinary Console |
| `CLOUDINARY_API_KEY` | Cloudinary API key, if used | Cloudinary Console |
| `CLOUDINARY_API_SECRET` | Cloudinary API secret, if used; host secret only | Cloudinary Console |
| `LOG_LEVEL` | Logging verbosity, e.g. `info` in production | Owner-configurable |
| `TZ` | Scheduler timezone; set to `Asia/Kolkata` | Fixed project requirement |

The implementation may not need every optional integration variable if the related feature is explicitly disabled, but the required Discord, Firebase, Gemini, and Groq connections must be supported. Github monitoring and SMTP report features must be implemented as planned, not silently dropped.

### Firebase Admin SDK key handling
- Prefer the host's secret/environment-variable fields for service account key values.
- Parse `FIREBASE_PRIVATE_KEY` safely, including escaped newline sequences if the host stores them as `\\n`.
- Do not download a service-account JSON into the repository.
- Grant the service account only the Firebase project permissions needed by this bot.
- Never print the private key, token, or complete environment configuration in logs.

### `.env.example` example (safe placeholders only)
```dotenv
DISCORD_TOKEN=replace_with_discord_bot_token
DISCORD_CLIENT_ID=replace_with_discord_application_id
DISCORD_GUILD_ID=replace_with_ipdc_server_id

FIREBASE_PROJECT_ID=replace_with_firebase_project_id
FIREBASE_CLIENT_EMAIL=replace_with_service_account_email
FIREBASE_PRIVATE_KEY="replace_with_private_key"

GEMINI_API_KEY=replace_with_gemini_api_key
GROQ_API_KEY=replace_with_groq_api_key

GITHUB_APP_ID=replace_with_github_app_id
GITHUB_APP_PRIVATE_KEY="replace_with_github_app_private_key"
GITHUB_INSTALLATION_ID=replace_with_github_installation_id
GITHUB_WEBHOOK_SECRET=replace_with_random_webhook_secret

SMTP_HOST=replace_with_smtp_host
SMTP_PORT=587
SMTP_USER=replace_with_smtp_username
SMTP_PASS=replace_with_smtp_password
SMTP_FROM=replace_with_sender_email
REPORT_RECIPIENT_EMAIL=replace_with_report_recipient

CLOUDINARY_CLOUD_NAME=replace_if_cloudinary_enabled
CLOUDINARY_API_KEY=replace_if_cloudinary_enabled
CLOUDINARY_API_SECRET=replace_if_cloudinary_enabled

LOG_LEVEL=info
TZ=Asia/Kolkata
```

---

# 21. Host readiness and deployment acceptance tests

- [ ] `npm install` / host dependency installation succeeds using the committed lockfile.
- [ ] `npm start` launches the bot in production mode.
- [ ] Runtime selected in Bot-Hosting.net is Node.js 22.
- [ ] `.env.example` documents all configuration names; no actual credentials appear in Git history.
- [ ] Bot token logs in successfully and bot is present in the target IPDC guild.
- [ ] Firebase Admin SDK connects successfully and Firestore rules/data access follow least privilege.
- [ ] Gemini primary and Groq immediate failover are tested independently and with forced Gemini failure.
- [ ] GitHub App can read only intended repositories and report data.
- [ ] SMTP test report reaches configured recipient without exposing credentials.
- [ ] Scheduler uses Asia/Kolkata and daily heatmap/report timing is 9 PM IST.
- [ ] Restarting/redeploying on Bot-Hosting.net does not duplicate channels, roles, or persistent dashboard messages.
- [ ] Host logs show clear health status and redacted errors; secrets are never logged.
