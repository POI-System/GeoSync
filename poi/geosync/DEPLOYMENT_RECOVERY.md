# GeoSync Deployment and Recovery Runbook

Status date: August 2, 2026

This runbook covers the Li Ziya backend integration on branch `LZY`. It does not
claim that a real SuperMap iServer deployment has been validated. Real service
details and authoritative GIS mappings must be supplied outside the repository.

## 1. Release Gates

Run all release work from `D:\poi项目` and confirm the branch before changing or
publishing anything:

```powershell
git branch --show-current
git status --short
git remote -v
git log -1 --oneline
```

The branch must be `LZY`. Do not develop on, merge into, or push `main`. Do not
delete or stage the untracked root documents, `docs/`, PPTX files, generated
reports, GIS data, credentials, uploads, logs, or backups.

Run the final checks from `D:\poi项目\poi` after all concurrent edits stop:

```powershell
& 'D:\nodejs\npm.cmd' ci
& 'D:\nodejs\npm.cmd' run check:syntax
& 'D:\nodejs\npm.cmd' run test:geosync
& 'D:\nodejs\npm.cmd' run test:integration
& 'D:\nodejs\npm.cmd' test
& 'D:\nodejs\npm.cmd' run audit:prod
```

Do not deploy when any command fails. A narrow focused suite is not a substitute
for the final combined test command.

The production dependency audit on August 2, 2026, after applying npm-compatible
non-forced updates, reported 14 package findings: 4 high, 10 moderate, 0 low,
and 0 critical. The remaining high findings are `nodemailer` and the legacy
AliCloud `@alicloud/oss-baseclient` -> `@alicloud/credentials` -> `json-bigint`
chain. Treat them as an unresolved release-security gate. Their published audit
remediation requires breaking upgrades or an incompatible transitive override,
so record an approved, time-bounded exception or complete focused compatibility
work before release. Do not run `npm audit fix --force` or accept major upgrades
without review and regression testing.

## 2. Production Topology

The production entry point is `poi/server.js`, started with:

```powershell
& 'D:\nodejs\npm.cmd' start
```

The process owns one Express application, one HTTP server, one Socket.io server,
and one Mongoose connection. `server.js` calls `geosync.attach(...)` before static
files and before `server.listen(...)`. GeoSync reuses the host POI, user model,
authentication identity, Mongoose instance, Socket.io instance, mail/template
helpers, and OCR helper.

The reviewed production topology is fixed at `/opt/poi`; `deploy.sh`, PM2, and
Nginx intentionally use the same path. Do not override the deployment directory
without updating and reviewing all three configurations together. Deployment
enforces Node.js 20 or newer and validates the same Let's Encrypt certificate and
key paths loaded by `nginx.conf` before reloading Nginx.

Nginx serves only `/uploads/` directly from its dedicated alias. All pages and
other public assets are proxied to Node so the server's extension allowlist and
backend-file denial remain authoritative. `/opt/poi` must never be configured as
an Nginx document root; `.env`, source, packages, GeoSync internals, and logs must
remain unreachable over HTTP.

`poi/geosync/standalone.js` is not the production entry point. It may be used for
isolated development only. Do not run it beside `poi/server.js` in production.

`poi/geosync` is the only tracked GeoSync implementation. The obsolete tracked
root `geosync/` copy was removed only after its original suite passed 67/67 and
the migrated single-service tree passed the final regression recorded in the
pull request.

Background jobs are enabled unless `GEOSYNC_BACKGROUND_ENABLED=false`. Production
normally leaves them enabled. Graph and POI-index initialization are core startup
work and run independently of that cron toggle. Health remains HTTP 503 while
either component is pending or after either component fails. `jobsRunning`
reflects the scheduler's actual result, while the `jobs` object distinguishes a
running primary instance, intentional `background-disabled`, and intentional
`non-primary-instance` disablement.

## 3. Configuration and Secret Handling

Use `poi/.env.example` as the list of supported variables, not as production
values. Supply production values through the deployment secret/configuration
system. Never commit `.env`, a populated manifest, passwords, tokens, private
service URLs, licenses, or migration mapping files.

The template includes background-mode, notification, provider, tuning, upload,
and simulator controls. Blank optional provider values disable their feature.
`SIM_MODE=true` remains development-only and is rejected during production boot.

Core production configuration includes:

- `MONGO_URI`: the shared POI/GeoSync MongoDB database.
- `ADMIN_USERNAME` and `ADMIN_PASSWORD`: required for administrator login.
- `ADMIN_TOKEN`: optional. When supplied it must be a separate strong opaque
  Bearer credential; it is never accepted in query strings or request bodies.
- `AUTH_SESSION_SECRET`: an independent random secret containing at least 32
  bytes. Keep the repository template blank, do not reuse an API credential, and
  inject the production value through the deployment secret manager.
- `AUTH_SIGN_REQUIRED=true`: required in production. Setting it to `false` only
  enables legacy `X-Open-Id` compatibility in a non-production environment;
  production forces signed authentication and ignores that downgrade request.
- `AUTH_USER_SESSION_TTL_SEC` and `AUTH_ADMIN_SESSION_TTL_SEC`: positive bounded
  lifetimes for signed user and administrator sessions. Defaults are 604800
  seconds (7 days) and 28800 seconds (8 hours); no session may exceed 2592000
  seconds (30 days).
- `AUTH_COOKIE_SECURE=true`: required behind production HTTPS. Authentication
  cookies are HttpOnly and SameSite=Lax; set this to `false` only for an isolated
  loopback HTTP development environment.
- `REVIEWER_OPENIDS`: the authoritative comma-separated, server-side reviewer
  entitlement allowlist. Keep it blank until legitimate reviewer identities are
  verified; never expose it in public configuration or logs. Historical database
  `role='reviewer'` or `reviewerSubscribed=true` values do not grant access by
  themselves.
- `POSITION_HMAC_SECRET`: a strong random secret; position processing is disabled
  when it is absent or left at the known placeholder value.
- `SCREEN_TOKEN`: an optional distinct, strong opaque credential accepted only
  through `X-Screen-Token`. It is never written into a cookie.
- `SCREEN_SESSION_TTL_S`: the positive bounded lifetime of the signed screen
  session issued by the administrator bootstrap endpoint (900 seconds by default
  and at most 86400 seconds/24 hours). Expiry is enforced from the signed session
  claims; an expired cookie cannot be extended by the browser.
- `SCENIC_ID`, `SCENIC_CENTER`, and `SCENIC_FENCE_RADIUS_M`: the deployed scenic
  identity and WGS84 `[lng,lat]` operating area.
- `HOST`, `PORT`, `PUBLIC_HOST`, and `CORS_ORIGIN`: host process settings.
- `TRUST_PROXY=loopback`: the safe default for direct deployments and a local
  reverse proxy. Authentication rate limits use `req.ip`, so a non-loopback
  proxy deployment must replace this with a topology-reviewed numeric hop count
  from 0 through 10, an exact trusted proxy IP/CIDR, or a comma-separated trusted
  list. `false` explicitly disables proxy trust. Unsafe blanket values `true` and
  `*`, plus out-of-range numeric values, fall back to `loopback`; do not rely on
  them as configuration. Trusting arbitrary upstream addresses would let clients
  spoof forwarding headers and evade per-network throttles.

The obsolete `poi/init-admin.js` plaintext database initializer and its
disconnected `AdminUser` model have been removed. Administrator credentials now
come only from the deployment secret system and signed session flow. Rotate them
through the secret system and restart the service; do not recreate a plaintext
administrator collection or commit credential bootstrap scripts.

### Host POI Schema Contract

The existing host `POI` model remains the authoritative `pois` collection. The
GeoSync extension is applied before model compilation and adds optional WGS84
GeoJSON `geo`, structured `visitMeta`, `gateNodeId`, and `superMapRef` fields
without replacing the legacy collection or review workflow.

`visitMeta.openHours` uses the existing planner-compatible contract from the POI
data-model specification: an array of `{start, end}` windows. The single `String`
example in the backend-interface document conflicts with that established
contract and is not used. Each present window requires zero-padded, valid
24-hour `HH:mm` values; incomplete entries and values such as `24:00` are
rejected. An optional `geo` value, when present, must contain a complete WGS84
`Point` with `[lng, lat]` coordinates.

SuperMap server-side configuration includes:

- `SUPERMAP_ENABLED`
- `SUPERMAP_MANIFEST_PATH`
- `ISERVER_BASE`
- `ISERVER_USERNAME`
- `ISERVER_PASSWORD`
- `SUPERMAP_TIMEOUT_MS`
- `SUPERMAP_HEALTH_TIMEOUT_MS`
- `SUPERMAP_CACHE_TTL_S`
- `SUPERMAP_FALLBACK_ENABLED`
- `SUPERMAP_MAX_RETRIES`

`ISERVER_BASE`, usernames, passwords, MongoDB URIs, reviewer identities, session
secrets, and administrator or screen tokens must never appear in
`/api/geosync/client-config`, public browser storage, query strings, logs, test
snapshots, or PR text. User and administrator browser authentication uses signed,
expiring HttpOnly cookies. Administrator APIs may also use the separately
configured opaque token in an `Authorization: Bearer` header. Screen access uses
the protected header/cookie transport; the legacy query-string token is rejected.

Supported credential transports are intentionally narrow:

| Principal | Cookie | Non-cookie transport |
|---|---|---|
| User | `poi_user_session` | `X-POI-Session` signed session header |
| Administrator | `poi_admin_session` signed session | `Authorization: Bearer <ADMIN_TOKEN>` using the separate opaque administrator token |
| Screen | `poi_screen_token` containing a signed `screen` session | Optional strong opaque `X-Screen-Token` |

A signed administrator session is a cookie credential, not a Bearer token. Query
and request-body tokens are not accepted as substitutes for these transports.
The screen bootstrap endpoint signs a bounded `SESSION_KINDS.SCREEN` credential
with `AUTH_SESSION_SECRET`; it never copies the raw `SCREEN_TOKEN` into the
browser cookie. An expired or otherwise invalid signed screen cookie is HTTP 403
when presented alone. Screen-protected routes may independently fall back to a
valid administrator session, allowing an operator to access the route and issue
a fresh screen session. An explicitly supplied invalid `X-Screen-Token` remains
a screen-authentication failure and should not be sent as an administrator
transport.

Browser WeChat OAuth uses a short-lived HttpOnly state cookie. At callback, the
server first reserves the matching state so a concurrent callback cannot use it,
then performs the upstream code exchange, validates the returned OpenID, and
resolves the user before committing the state exactly once. A failed or aborted
callback before commit releases a still-valid reservation in `finally`, allowing
a later retry; an expired state remains unusable. QR issuance also sets the
HttpOnly, SameSite=Strict `poi_qr_login_claim` cookie and stores only its hash
server-side. QR OAuth state is bound to the server-issued `sid`, and
`/auth/status` requires both that `sid` and the matching claim cookie. The
scanning device or a caller holding only a bare `sid` cannot claim the desktop
user session. Committed state, claim, and `sid` values cannot be replayed across
flows. Pending OAuth and QR state is process-local, so a restart intentionally
expires unfinished authorization attempts.

Authentication issuance is throttled with bounded fixed windows. Administrator
login permits at most 30 attempts per network and 10 attempts per normalized
network/account pair in 15 minutes. Browser and QR OAuth issuance share a limit
of 20 attempts per network per minute, and pending authorization stores are
capped at 2048 records. Rejected requests return HTTP 429 with `Retry-After`.
These limits key the network only from Express `req.ip` under the explicit
`TRUST_PROXY` policy above; do not weaken that boundary to accept arbitrary
forwarded addresses.

Socket.io clients authenticate with a signed user or administrator session in
the handshake auth payload or HttpOnly cookie. The server reloads the user and
role before deriving room membership. Query-only identities, mismatched query
openIds, and client-declared administrator roles are rejected in production;
legacy query identity is available only in the explicit non-production
compatibility mode described above. Both host and GeoSync room authorization
refresh idle connections every 60 seconds, so expired sessions, revoked users,
and role changes remove stale capabilities without requiring a client event.

### Backend-Only Authentication Rollout

This release hardens the backend without changing the portal frontend owned by
the frontend team. Existing portal builds may retain an OpenID under the
`localStorage` keys `user_openid` or `userOpenId` and continue displaying it
after the new HttpOnly `poi_user_session` cookie is missing, expired, or cleared.
That stored OpenID is not a credential and the production backend will not
restore authority from it or from `X-Open-Id`.

All deployed users must complete WeChat authorization again after this backend
release to receive a signed HttpOnly user cookie. A user whose cookie later
expires or is removed will receive HTTP 401 until re-authorization succeeds,
even if the old browser OpenID remains present and the portal still renders the
main authenticated view. Do not migrate or mint a session from the
browser-stored value.

Portal user logout and expiry recovery are not implemented. The current logout
handler only changes browser-visible role/UI state and does not call
`POST /api/auth/logout`. On a shared device, clearing or changing localStorage or
other visible state can therefore leave the signed HttpOnly user cookie active.
In the opposite direction, cookie expiry produces HTTP 401 responses while the
portal may still believe the stored OpenID represents an authenticated user.

Administrator cleanup has the same split-state problem. The portal stores the
non-credential `cookie-session` marker in `sessionStorage` after login, but it has
no administrator logout path. The marker can remain after the signed
`poi_admin_session` cookie expires, and hiding the panel or clearing the marker
does not clear an otherwise valid HttpOnly administrator cookie. The frontend
follow-up must recover from authentication failures, including HTTP 401/403 as
applicable, clear stale administrator UI state, and call
`POST /api/admin/logout` for explicit administrator sign-out.

Full OpenID transport also remains a privacy and logging risk. The current flow
still carries complete OpenIDs through OAuth redirect URLs, the `/auth/status`
QR polling response, `localStorage`, portal navigation and
POI/notification/chat request URLs, form fields, and Socket query strings. The
hardened backend derives authority from the signed session and treats these
values only as compatibility or mismatch inputs, but that does not remove their
exposure in browser history, access logs, diagnostics, or client storage.

The frontend follow-up should bootstrap identity through
`GET /api/auth/session`, handle HTTP 401 by clearing stale display state and
restarting authorization, call `POST /api/auth/logout` for user sign-out, and
remove full OpenID values from redirects, polling payloads, localStorage, request
URLs/forms, and Socket query parameters. That frontend change is intentionally
not included in this backend-owned delivery without confirmation from the
frontend owner. Before rollout, operators must communicate the required
re-authorization and monitor authentication failures. These limitations are
independent of the real-iServer blocker: real iServer validation still requires
the authoritative service details listed in Section 11.

### Reviewer Allowlist Rollout

`REVIEWER_OPENIDS` must be populated before reviewer traffic reaches the hardened
service. An empty allowlist intentionally downgrades every historical reviewer to
collector authority at HTTP authentication and Socket refresh time, even when a
database row still contains `role='reviewer'` or `reviewerSubscribed=true`.

Before deployment:

1. Take the approved database backup and inventory user rows whose `role` is
   `reviewer` or whose `reviewerSubscribed` flag is true. Keep OpenIDs in the
   secured change record, never in logs, tickets, or this repository.
2. Have the responsible owner verify the legitimate reviewer identities and set
   exactly those values in `REVIEWER_OPENIDS` through deployment configuration.
3. Restart the service so the new allowlist is active, then verify an allowlisted
   reviewer and a deliberately non-allowlisted historical reviewer through both
   HTTP and Socket authorization.
4. Through a reviewed, conditional database change, downgrade stale
   non-allowlisted reviewer rows to collector state and clear obsolete reviewer
   subscription flags. Record dry-run/affected counts and do not use a blanket
   update without the verified inventory.

An allowlisted reviewer may switch the current UI role to collector without
clearing the persisted `reviewerSubscribed` flag. They may later select reviewer
mode again because the allowlist, not that flag, grants the entitlement. To revoke
a reviewer, remove the OpenID from `REVIEWER_OPENIDS`, restart with the new
configuration, allow the 60-second Socket revalidation to remove stale rooms,
and clean the historical database flags through the same reviewed procedure.

## 4. Manifest Provisioning

`poi/config/supermap-manifest.example.json` is a placeholder contract example.
It is not a real published service definition. Provision the real manifest in a
secured location outside the Git worktree and point `SUPERMAP_MANIFEST_PATH` to
that file.

The manifest validator requires:

- A semantic `contractVersion` with supported major version `1`.
- A nonempty `dataVersion` and matching `scenicId`.
- `EPSG:4326`, a WGS84 center, and an ordered WGS84 extent.
- Logical `map`, `data`, and `network` services with the required operations.
- Root-relative operation paths.
- Dataset and field allowlists.
- A maximum feature limit no greater than 500.

Optional terrain and scene services may remain disabled. Missing, malformed, or
incompatible manifests do not crash the POI service; GIS reports `offline`.

Never invent operation paths or response mappings from the example. Real
integration requires the published service paths and representative raw
responses from the iServer owner.

## 5. Database Preparation

Take a verified MongoDB backup before any production migration. Record the
release commit, manifest `dataVersion`, mapping file checksum, operator, and
timestamp in the deployment change record. Do not put the backup or mapping file
inside the Git repository.

Set `MONGO_URI` through the deployment secret system, then create indexes only
under the deployment change procedure:

```powershell
& 'D:\nodejs\npm.cmd' run init:indexes
```

The index runner refuses to connect without an explicit `MONGO_URI`, disables
implicit `autoIndex` and `autoCreate`, and deliberately creates the host POI
`geo` 2dsphere index plus the `{status, visitMeta.tags}` review/tag index. The
deployment script runs this gate before reloading the application.

### Host POI GeoSync Migration

The POI migration backfills only derivable `geo` and `visitMeta` values. Dry-run
is the default and requires an explicitly configured `MONGO_URI`:

```powershell
& 'D:\nodejs\npm.cmd' run migrate:poi-geo:dry-run
```

Review `total`, `success`, `skipped`, `failed`, `gateNodeIdDeferred`,
`superMapRefDeferred`, and every sanitized per-POI error. `success` in dry-run is
the number of records that would be updated. The tool never invents
`gateNodeId`, dataset names, `smId`, or `dataVersion`; deferred counts must be
resolved from authoritative GIS data through the separate mapping workflow.

After backup, review, and explicit database-change approval, apply with:

```powershell
& 'D:\nodejs\npm.cmd' run migrate:poi-geo:apply
```

Apply uses conditional snapshots of every field being changed and of source
fields such as `location` and `category`. A concurrent edit is reported as
`CONCURRENT_CHANGE` rather than overwritten. Rerunning after success is
idempotent and should report `success=0`, `skipped=total`, and `failed=0` for the
derivable fields. Exit codes are:

- `0`: no failures.
- `1`: runtime or database failure.
- `2`: CLI or required-input failure.
- `3`: processing completed with one or more per-POI failures.

Recovery uses the verified pre-migration MongoDB snapshot. Because the migration
is additive and conditional, partial success should normally be handled by
repairing invalid or concurrently changed records and rerunning; do not delete
new fields broadly or fabricate deferred authoritative mappings.

## 6. SuperMap WalkEdge sourceRef Migration

Trusted local fallback and barrier routing require an authoritative mapping for
each relevant business `edgeId`:

```text
edgeId, datasetName, smId, optional sourceId, dataVersion
```

The mapping file is a JSON array. Every value must come from the published GIS
dataset or import/export record. The migration rejects blank values, negative or
non-integer `smId` values, unsupported fields, duplicate edge IDs, and conflicting
mappings. It never derives `smId`, dataset names, source IDs, or versions from an
edge ID.

Run dry-run first. The mapping path is mandatory:

```powershell
& 'D:\nodejs\npm.cmd' run migrate:supermap-refs:dry-run -- --mapping '<secure-absolute-mapping-path>'
```

Review `total`, `success`, `skipped`, `failed`, and every per-edge error. Dry-run
does not call `updateOne`. Do not continue while `failed` is nonzero or while the
mapping does not cover the graph required by the deployment.

Apply mode requires `MONGO_URI` to already be supplied by the deployment
environment. Do not place the URI on the command line:

```powershell
& 'D:\nodejs\npm.cmd' run migrate:supermap-refs:apply -- --mapping '<secure-absolute-mapping-path>'
```

Apply mode uses an idempotent conditional update containing the observed previous
`sourceRef`. It skips already matching edges and reports concurrent changes,
missing edges, and write errors independently. Exit codes are:

- `0`: no failures.
- `1`: runtime or database failure.
- `2`: CLI or mapping-validation failure.
- `3`: processing completed with one or more per-edge failures.

After a successful apply, rerun dry-run with the same file. The expected result is
`success=0`, `skipped=total`, and `failed=0`.

### Migration Recovery

The migration does not generate a rollback file. Recovery must use one of these
authoritative sources:

1. Restore the pre-migration MongoDB snapshot.
2. Prepare a second explicit mapping array containing the verified previous
   `sourceRef` values, dry-run it, and apply it through the same conditional tool.

Never reconstruct previous mappings from `edgeId` text. When an apply returns
partial failures, do not undo successful entries ad hoc. Repair the authoritative
input or database conflict and rerun; successful entries become idempotent skips.

Local fallback remains operationally blocked until the authoritative mapping is
complete and its `dataVersion` matches the deployed manifest. Synthetic unit
tests do not prove that the seeded production graph is ready.

## 7. Startup and Verification

Start the single service, then verify both the legacy POI surface and GeoSync:

1. `GET /api/client-config` returns HTTP 200.
2. `GET /api/geosync/client-config` returns HTTP 200 and contains no credentials,
   private service paths, MongoDB URI, administrator token, or dataset allowlist.
3. `GET /api/geosync/health` reports MongoDB, graph, jobs, GIS, manifest, route
   cache count, last invalidation reason, and last successful GIS time.
4. `GET /api/admin/geosync/gis/status` succeeds only with a valid signed
   administrator session or configured administrator Bearer token.
5. `POST /api/admin/geosync/gis/route-test` succeeds only with the same
   administrator authentication and is used only for smoke testing.
6. `POST /api/admin/screen/session` issues a short-lived, signed HttpOnly screen
   session only after administrator authentication; it never places the raw
   `SCREEN_TOKEN` in the cookie. `POST /api/admin/screen/logout` clears the
   session. The optional opaque screen token must never be sent in a URL. Verify
   that an expired screen cookie alone receives 403 and that the same route can
   still be reached through an independently valid administrator session.

Health status interpretation:

| Condition | HTTP | GIS state | Operator meaning |
|---|---:|---|---|
| MongoDB, graph, and POI index ready; required GIS services online | 200 | `online` | Core and GIS available |
| Core ready and only part of GIS is available | 200 | `degraded` | Core stays available; inspect service states |
| Core ready and GIS disabled/unavailable | 200 | `offline` | Core stays available; GIS requests may degrade or fail |
| MongoDB connecting or core startup pending | 503 | any | Keep traffic out until readiness settles |
| MongoDB offline/disconnecting or graph/POI-index/job startup failed | 503 | any | Core is not ready; inspect `startup.components` and sanitized logs |

For route smoke tests, exercise `normal`, `accessible`, and `shade`. A successful
route must contain canonical WGS84 GeoJSON `LineString` geometry, meters, seconds,
legacy `pathGeometry`, and `gis` provenance. `accessible` must never accept an
unverified local fallback.

Do not label the deployment as real-iServer validated until the test used the
published URL, manifest, authorized account, production-equivalent permissions,
and representative raw responses.

## 8. Failure Handling

| Failure | Expected behavior | Recovery action |
|---|---|---|
| Manifest missing or incompatible | Main service starts; GIS is `offline` | Restore a validated manifest; force status refresh |
| iServer timeout | At most one retry; cache or trusted local fallback may be used | Check iServer and network; inspect route `gis.source` |
| No normal/shade fallback | HTTP/code `8201` | Restore iServer or complete trusted graph provenance |
| Route timeout | HTTP/code `8202` | Check service latency and timeout budget |
| Snap distance exceeded | HTTP/code `8203` | Verify coordinates, extent, and network publication |
| Mode unreachable | HTTP/code `8204` | Verify network attributes; never bypass accessible checks |
| Contract/dataVersion mismatch | HTTP/code `8205`; cache must not be trusted | Align manifest, network publication, and sourceRef mapping |
| Invalid upstream geometry | HTTP/code `8206` | Capture a sanitized representative response for adapter work |
| MongoDB unavailable | Health HTTP 503 | Remove traffic, restore database connectivity, then recheck |
| Graph or POI index startup pending/failed | Health HTTP 503 with component state | Repair database/index data or startup configuration, restart, and wait for readiness |
| Jobs requested but scheduler failed | Health HTTP 503 and `jobs.state=failed` | Repair scheduler startup; non-primary/background-disabled states are intentional and named |
| `AUTH_SESSION_SECRET` missing or unsafe | Session issuance/authentication fails closed; login may return HTTP 503 | Inject an independent random secret of at least 32 bytes and restart |
| `SCREEN_TOKEN` missing or unsafe | Opaque `X-Screen-Token` access is rejected; the signed administrator-issued screen session remains available | Configure a distinct strong token only if non-cookie header access is operationally required |
| Signed screen session expired | Screen-only request returns HTTP 403 | Authenticate as an administrator and issue a new bounded screen session; do not reuse or extend the expired cookie client-side |
| Closed edge lacks sourceRef | Barrier snapshot fails closed | Repair authoritative mapping; create a new real transition/event |

Route cache invalidation is required after edge close/open, manifest version
change, or network republication. A process restart also clears the in-memory
cache, but restart is not a substitute for correcting a version mismatch.

## 9. Durable State and Event Delivery Risk

The following state is durable in MongoDB after successful compare-and-set writes:

- WalkEdge open/closed status, reason, timestamp, and `sourceRef`.
- Itinerary route, stops, ETA/timetable, version, and counters.
- Pending proposal data and lifecycle entries in `rerouteLog`.

The event bus, barrier-event dedupe records, per-scenic processing queues, Socket
delivery, SSE client set, and pending OAuth/QR state are process-local. There is
no transactional outbox, durable message queue, or cross-process Redis event
bus. A process crash can lose an `ops:impact`, `ops:proposal-status`, or graph
notification after the database write, and a restart clears event dedupe memory
and intentionally expires unfinished authorization flows. Multiple application
instances would not share these in-memory guarantees.

Operations clients must treat MongoDB-backed API state as authoritative, reload
after reconnect, and not use a received Socket event as the only record of a
decision. Durable event delivery remains a residual production risk.

## 10. Application Rollback

1. Stop new traffic and record health, GIS diagnostics, the failing request ID,
   release commit, manifest versions, and sanitized error codes.
2. Stop the process cleanly through the service manager.
3. Restore the last approved `LZY` release commit. Do not switch production to an
   unreviewed `main` worktree and do not use destructive Git cleanup commands.
4. Run `npm ci`, syntax checks, and the full test gate for the rollback commit.
5. Restore MongoDB only when the rollback plan explicitly requires it. The new
   schema fields are additive; an application rollback does not automatically
   require deleting them.
6. If rolling back the manifest/network publication, restore an aligned manifest,
   graph mapping, and `dataVersion` together.
7. Restart the single service and repeat all health, legacy POI, admin GIS, and
   route checks.

## 11. External Blockers and Delivery State

Real iServer integration remains blocked until all of the following are supplied:

- The actual server base and published logical service paths.
- A validated production manifest.
- An authorized server-side account and confirmed map/data/network permissions.
- Representative raw status, query, route, and barrier-route responses.
- The authoritative WalkEdge `edgeId` to `datasetName + smId` mapping with the
  matching `dataVersion`.

As of August 2, 2026, the final verified branch was pushed to `origin/LZY` and
GitHub Pull Request #1 was opened from `LZY` to `main` through an approved API
workflow. The GitHub CLI (`gh`) remains unavailable, but it is no longer a
delivery blocker. Do not push or merge `main` directly; the open pull request
must remain the review and merge boundary.

Production dependency remediation also remains open. The active application
dependency graph has 14 findings, including 4 high-severity findings in
`nodemailer` and the legacy AliCloud dependency chain. Any temporary exception
must name the affected packages, compensating controls, owner, and expiry date.
