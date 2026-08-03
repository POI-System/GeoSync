# GeoSync Deployment and Recovery Runbook

Status date: August 3, 2026

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

The P2 dependency update removes the unused legacy
`@alicloud/ocr20191230` fallback chain and upgrades `nodemailer` and
`node-cron` through reviewed application-compatible releases. The production
audit gate for the current lock file is zero vulnerabilities after `npm ci`.
Any later nonzero `npm run audit:prod` result blocks release until it is reviewed
and resolved. Do not run `npm audit fix --force` or accept unreviewed major
upgrades merely to change the audit count.

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
other public assets are proxied to Node. Node exposes the four legacy root HTML
files only through the exact five routes `/`, `/index.html`, `/portal.html`,
`/admin.html`, and `/chat.html`. The `tour`, `ops`, and `screen` entries
and all general public assets are served only from `poi/public`; there is no
repository-root `express.static(__dirname)` mount. Unmapped private HTML,
`node_modules` documentation, unreferenced repository images, source, packages,
GeoSync internals, and logs must return 404. `/opt/poi` must never be configured
as an Nginx document root.

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

### Request Parsing and Process Shutdown

The host JSON and URL-encoded parsers use a fixed `1mb` limit. No current JSON
endpoint accepts files, base64 images, bulk GIS publications, or another payload
that requires a larger body. Host POI/OCR uploads and GeoSync check-in,
photospot, and pairing-fulfilment photos use `multipart/form-data` with dedicated
Multer middleware and a 10 MiB per-file ceiling, so they do not depend on the
JSON parser limit. Do not raise the global parser limit to accommodate an upload;
add a reviewed route-local parser only if a future non-multipart contract proves
that it needs one.

Nginx must not retain the former 50 MiB blanket allowance. The smallest
compatible upstream ceiling is 12 MiB, which leaves multipart framing room above
the application-level 10 MiB file limit; Node still rejects JSON and URL-encoded
bodies above 1 MiB. A stricter Nginx layout may keep a 1 MiB default and apply the
12 MiB ceiling only to the documented multipart routes. Verify both limits after
every proxy configuration change.

`server.js` installs the shared graceful-shutdown lifecycle after `server`, `io`,
and the GeoSync attachment exist and before `server.listen(...)`:

```js
const { installGracefulShutdown } = require('./geosync/services/gracefulShutdown');

installGracefulShutdown({
    server,
    io,
    mongoose,
    timeoutMs: process.env.SHUTDOWN_TIMEOUT_MS,
    logger: console
});
```

The first `SIGTERM` or `SIGINT` stops HTTP admission and Socket.io together,
waits for both drains, disconnects Mongoose, and exits once. Repeated signals
share the same shutdown promise. The total default deadline is 10000 ms and is
bounded to at most 60000 ms; timeout or any close/disconnect failure exits with
code 1. Logs contain the signal and failed phase names only, never driver or
connection error messages.

PM2 must allow the application deadline to finish. For the default application
timeout, set `kill_timeout: 12000` in `ecosystem.config.js`. If
`SHUTDOWN_TIMEOUT_MS` is changed, keep PM2's `kill_timeout` strictly greater than
that value and validate a real restart with an in-flight HTTP request and an
active Socket connection.

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
- `MONGO_STARTUP_FAIL_FAST`: optional literal `true` or `false`. When blank or
  unset, an initial MongoDB connection failure terminates the process in
  production and remains observable without terminating in development/test.
  Production should keep the default fail-fast behavior. Use `false` only for a
  reviewed diagnostic window where serving liveness without database-backed POI
  traffic is intentional. Invalid values do not disable the environment default,
  and startup logs contain only sanitized error codes, never the MongoDB URI or
  driver error message.
- `SHUTDOWN_TIMEOUT_MS`: optional positive integer total shutdown deadline in
  milliseconds. The default is 10000 and the maximum is 60000; invalid, blank,
  zero, negative, or oversized values use the default without logging the raw
  value. PM2's `kill_timeout` must remain greater than the effective deadline.
- `ADMIN_USERNAME` and `ADMIN_PASSWORD_HASH`: required for browser administrator
  login. The hash must be generated by `npm run hash:admin-password` and uses the
  versioned scrypt format `$scrypt$v=1$ln=15,r=8,p=3$...`. The legacy plaintext
  `ADMIN_PASSWORD` variable is forbidden; if it is still populated, password
  login fails closed even when a hash is also present.
- `ADMIN_TOKEN`: optional. When supplied it must be a separate strong opaque
  Bearer credential; it is never accepted in query strings or request bodies.
  This credential is deliberately independent of the signed-session revocation
  store and remains available for recovery while MongoDB is unavailable.
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
- `AUTH_COOKIE_SECURE`: when blank or unset, secure-cookie behavior is derived
  from the parsed `PUBLIC_HOST` protocol. Production startup fails closed unless
  `PUBLIC_HOST` is a valid HTTPS origin containing no credentials, path, query,
  or fragment and secure cookies are enabled; the
  deployment preflight likewise accepts only a blank value or literal `true`.
  An explicit `false` is allowed only for an isolated loopback HTTP development
  environment. Authentication cookies remain HttpOnly and SameSite=Lax.
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
- `SCENIC_TIME_ZONE`: the IANA time-zone identifier used for opening windows,
  golden-window dates, and date-offset calculations. It defaults to
  `Asia/Shanghai`; an invalid identifier fails configuration validation instead
  of silently using the host machine's local time zone.
- `BARRIER_REROUTE_CONCURRENCY`: positive integer number of active itineraries
  rebuilt concurrently for one accepted graph event. The default is 6. Events
  for the same scenic area remain serialized; increasing this value raises
  concurrent MongoDB and iServer pressure and requires a measured load test.
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
- `SUPERMAP_MANIFEST_RETRY_MS`
- `SUPERMAP_MAX_RESPONSE_BYTES`
- `SUPERMAP_CACHE_TTL_S`
- `SUPERMAP_FALLBACK_ENABLED`
- `SUPERMAP_MAX_RETRIES`

`SUPERMAP_MANIFEST_RETRY_MS` controls the short cache applied only to failed
manifest loads. The default is 30000 ms. After that interval, ordinary health,
query, route, and public-config calls retry the manifest automatically; an
operator does not need to call the forced administrator status endpoint to
recover from a transient file-read or mount-order failure.

`SUPERMAP_MAX_RESPONSE_BYTES` is the positive integer Axios response ceiling and
defaults to 10485760 bytes (10 MiB). Redirect following is always disabled for
iServer requests, independent of configuration. Geometry normalization rejects
an upstream geometry or route containing more than 100000 input positions before
axis, extent, or endpoint scoring. Treat either limit as a contract failure to
investigate; do not raise it merely to accept an unexplained oversized response.

### AMap Browser Proxy and Optional Providers

The browser receives only the public Web JS `AMAP_KEY`. It uses the same-origin
`/_AMapService/` path as its AMap service host and must never receive
`securityJsCode`. Nginx appends that secret only while proxying to the fixed
`https://restapi.amap.com/` upstream, strips Cookie and Authorization headers,
replaces the Referer with the public site origin, disables proxy caching, and
disables access logging for the proxy location.

Provision the secret outside `.env` and outside the repository:

```nginx
set $poi_amap_jscode "<ROTATED_REAL_VALUE>";
```

The file must be `/etc/nginx/snippets/poi-amap-jscode.conf`, owned by
`root:root` with mode `0600`. Rotate any value that has previously appeared in
browser configuration, source, logs, screenshots, or chat. The AMap owner must
also restrict the Web JS key to the exact production domain allowlist. If
Cloudflare or another CDN fronts the site, explicitly bypass caching for
`/_AMapService/`; the Nginx no-cache headers are not a substitute for an edge
rule. After every secret or proxy change, run `nginx -t`, reload Nginx, and
perform a real-browser map smoke test without printing the secret.

LLM-backed guide and natural-language edit features are enabled only when
`LLM_API_URL`, `LLM_API_KEY`, and an explicit `LLM_MODEL` are all nonblank.
The service no longer guesses a provider-specific default model identifier.
Blank or partial configuration disables those optional features. AliCloud OCR
uses the reviewed API client path only; the removed legacy
`@alicloud/ocr20191230` package is not a runtime fallback.

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
| User | `poi_user_session` | `X-POI-Session` signed session header; GeoSync compatibility also accepts `Authorization: Bearer <signed user session>` |
| Administrator | `poi_admin_session` signed session | `Authorization: Bearer <ADMIN_TOKEN>` using the separate opaque administrator token |
| Screen | `poi_screen_token` containing a signed `screen` session | Optional strong opaque `X-Screen-Token` |

Signed user and administrator sessions are cookie/header credentials, not query
or request-body tokens. Logout stores only a SHA-256 digest of the signed session
`jti` plus its bounded expiry. User digests are stored in
`user_session_revocations`; administrator digests remain in
`admin_session_revocations` for compatibility with already-issued sessions. Each
collection has an `expiresAt` TTL index. HTTP and Socket checks consult the shared
collection for that principal, so a successful logout invalidates copied cookies
and headers across instances for the rest of the original lifetime.

All photo upload routes authenticate before Multer can write a file, then recheck
the parsed multipart `openId`, `openid`, and `userOpenId` aliases against the
signed principal. Conflicts return HTTP 403 only after the unowned upload is
removed. GeoSync image routes accept JPEG/PNG up to 10 MiB, return bounded JSON
errors (`400` for type/parse errors, `413` for size, and sanitized `503` for
server-side storage failure), and delete files on
validation or pre-persistence failure. Once a database record durably references
the upload, later notification or points-side failures retain the file rather
than creating a broken database URL.

`POST /api/admin/logout` revokes the presented signed administrator session.
`POST /api/auth/logout` attempts both presented user and administrator sessions;
it clears each cookie only after that session's verification/revocation operation
completes safely. If either revocation store is unavailable, the response fails
and does not claim a complete logout. The Portal visibly warns that server-side
authority may still remain. The independent opaque `ADMIN_TOKEN` is not stored in
or checked against either signed-session revocation collection.
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
a later retry; an expired state remains unusable. A successful browser callback
sets the signed HttpOnly `poi_user_session` cookie and redirects to the committed
safe portal target without adding OpenID to the URL. QR issuance also sets the
HttpOnly, SameSite=Strict `poi_qr_login_claim` cookie and stores only its hash
server-side. QR OAuth state is bound to the server-issued `sid`, and
`/auth/status` requires both that `sid` and the matching claim cookie. The
scanning device or a caller holding only a bare `sid` cannot claim the desktop
user session. On successful desktop consumption, `/auth/status` sets the user
cookie and returns only `{"status":"ok"}`; the portal obtains identity through
`GET /api/auth/session`. Committed state, claim, and `sid` values cannot be
replayed across flows. Pending OAuth and QR state is process-local, so a restart
intentionally expires unfinished authorization attempts.

Authentication issuance is throttled with bounded fixed windows. Administrator
login permits at most 30 attempts per network and 10 attempts per normalized
network/account pair in 15 minutes. Browser and QR OAuth issuance share a limit
of 20 attempts per network per minute. Pending authorization also has a global
cap of 2048 logical flows and a shared per-network cap configured by
`AUTH_FLOW_MAX_PENDING_PER_NETWORK` (default `8`, accepted range `1` through
`64`). Browser and QR flows consume the same network allowance, keyed only from
Express `req.ip`/the server socket address under the explicit `TRUST_PROXY`
policy above; do not weaken that boundary to accept arbitrary forwarded or
client-supplied identity values. Rejected requests return HTTP 429 with a bounded
`Retry-After` based on the earliest relevant lease expiry.

A browser lease is held from state issuance until successful OAuth state commit
or TTL expiry. A failed callback remains retryable and does not release the
lease early. A QR lease is held from QR issuance through scanner callback commit
and remains held until the desktop consumes the matching `sid` plus claim, or
until TTL expiry. Cleanup and successful consumption release total and network
counts exactly once.

Socket.io clients authenticate with a signed user or administrator session in
the handshake auth payload or HttpOnly cookie. The server checks revocation,
reloads the user and role, and then derives room membership. Query-only
identities, conflicting identity aliases, mismatched identity hints, and
client-declared administrator roles are rejected in production;
legacy query identity is available only in the explicit non-production
compatibility mode described above. Both host and GeoSync room authorization
refresh idle connections every 60 seconds, so expired sessions, revoked users,
and role changes remove stale capabilities without requiring a client event.

### OAuth Session Bootstrap and Rollout

The portal clears the legacy `user_openid` and `userOpenId` storage keys, removes
case-insensitive `openid` query parameters from the visible URL, and never uses
either source to restore identity. On initial load it calls
`GET /api/auth/session` with caching disabled. HTTP 200 restores the server
session; HTTP 401 marks the browser anonymous and only then starts browser OAuth
or QR issuance. A network error or other unavailable response does not start a
new authorization flow automatically. The user may retry session bootstrap,
which prevents an OAuth redirect loop during a backend or network outage.

All deployed users without a valid signed cookie must complete WeChat
authorization again. Do not migrate or mint a session from browser-stored or URL
identity values. Browser callback redirects and QR polling success responses no
longer expose OpenID. The portal and the legacy `index.html`, `admin.html`, and
`chat.html` entry wrappers remove old identity storage and do not copy OpenID
into URLs, JSON/multipart bodies, or Socket query parameters. If an older client
still sends `X-Open-Id`, `openId`, `openid`, or `userOpenId`, every nonempty value
must match the signed principal or the request is rejected with HTTP 403.

Portal user logout calls `POST /api/auth/logout`, clears the in-memory identity,
role, and legacy storage, and distinguishes a confirmed anonymous result from an
unavailable server response. Network or revocation-store failure produces a
visible warning that the server-side session may still be active.

The administrator UI is Cookie-only. It removes the retired
`sessionStorage.adminToken` marker, restores state through protected
`GET /api/admin/session`, sends no administrator token in URLs, headers, or JSON
bodies, and exposes explicit `POST /api/admin/logout` sign-out. It revalidates on
window focus/page visibility and clears cached administrator data plus closes the
panel on any management request returning HTTP 401/403. Failed persistent
revocation remains visibly observable and does not claim success.

Other independently deployed clients must migrate to the same signed-cookie
contract before the backend compatibility fields can be removed entirely.
Before rollout, operators must communicate the required re-authorization and
monitor authentication failures. These limitations are independent of the
real-iServer blocker: real iServer validation still requires the authoritative
service details listed in Section 11.

### Administrator Password Hash Rollout and Legacy Cleanup

The runtime authenticates browser administrators only against
`ADMIN_PASSWORD_HASH`. It never compiles an `AdminUser` model and never falls
back to the historical `adminusers` collection. This is deliberate: compatibility
means keeping old rows inert while operators rotate the credential and remove the
obsolete collection, not re-enabling plaintext database authentication.

Generate the hash from standard input so the password is not placed in shell
arguments or history. From PowerShell in `poi/`:

```powershell
$secure = Read-Host -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    $plain | npm run --silent hash:admin-password
} finally {
    if ($plain) { Remove-Variable plain }
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
}
```

The command writes only the encoded hash. New administrator passwords must be
16-1024 UTF-8 bytes and must not contain CR, LF, or NUL. Store the resulting hash
in the deployment secret manager as `ADMIN_PASSWORD_HASH`; do not commit it even
though it is salted and one-way.

Rollout sequence:

1. Take an approved MongoDB backup and record its secured location and retention
   policy. Generate a new random administrator password that is not the historical
   plaintext password and is not reused by `ADMIN_TOKEN` or another service.
2. Generate the hash, set `ADMIN_PASSWORD_HASH`, and completely remove
   `ADMIN_PASSWORD` from `.env`, PM2 configuration, CI variables, image layers,
   and active secret-manager versions. The server logs only a sanitized code such
   as `ADMIN_PASSWORD_PLAINTEXT_FORBIDDEN`; it never logs either value.
3. Restart the service. Verify one incorrect password returns HTTP 401, the new
   password returns HTTP 200 with the signed HttpOnly cookie, and the retired
   password returns HTTP 401. Keep the independent opaque `ADMIN_TOKEN` available
   through the rollout recovery window.
4. Password rotation does not itself invalidate already-issued signed cookies.
   Explicitly log out known administrator sessions. If the historical password or
   a session may have been compromised, rotate `AUTH_SESSION_SECRET` as an incident
   action, accepting that this invalidates both administrator and user sessions.
5. Inventory the inert historical collection without reading any document fields:

   ```powershell
   npm run cleanup:legacy-admin:dry-run
   ```

6. After the backup and affected count are reviewed, drop only `adminusers` with
   the explicit destructive confirmation:

   ```powershell
   node geosync/scripts/cleanup-legacy-adminusers.js --apply --backup-confirmed --confirm=drop-adminusers
   ```

7. Repeat the dry-run and require `exists=false`. Preserve only the approved
   backup under restricted access until its retention deadline; do not restore the
   old collection or old plaintext credential during application rollback. A
   rollback may restore the previous known-good scrypt hash only when it was not
   part of a credential incident.

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

Production runtime sets Mongoose `autoIndex=false`; development and test keep
automatic indexes enabled for feedback. The deployment runner refuses to connect
without an explicit `MONGO_URI`, disables both `autoIndex` and `autoCreate`,
 and explicitly creates 25 host indexes across the seven authoritative collections
`users`, `pois`, `notifications`, `chatmessages`, `chatrooms`,
`systemsettings`, and `disputes`. It then creates every declared GeoSync model
index, including the user/administrator session-revocation TTL indexes and the
unique `eventId`, active-lease, and seven-day TTL indexes on
`barrier_event_records`. The deployment script runs this gate before reloading
the application. Do not deploy barrier processing without a successful index run
because the unique event index is the cross-instance ownership boundary.

### Host POI GeoSync Migration

The POI migration backfills only derivable `geo` and `visitMeta` values. Dry-run
is the default and requires an explicitly configured `MONGO_URI`:

```powershell
& 'D:\nodejs\npm.cmd' run migrate:poi-geo:dry-run
```

Review `total`, `success`, `skipped`, `failed`, `gateNodeIdDeferred`,
`superMapRefDeferred`, and the `report` object. `success` in dry-run is the number
of records that would be updated. Aggregate counters always cover the full
cursor. To bound memory and output, `operations`, `items`, and `errors` are each
capped by `POI_MIGRATION_REPORT_LIMIT` (default 1000, maximum 10000, with `0`
allowed for summary-only output). `report.truncated` and `report.omitted` disclose
all dropped report rows. `POI_MIGRATION_BATCH_SIZE` controls the cursor batch
(default 250, maximum 5000). The tool never invents
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

The mapping file is a JSON array no larger than 10 MiB and may contain at most
10,000 entries. Every value must come from the published GIS dataset or
import/export record. The migration rejects oversized input, blank values,
negative or non-integer `smId` values, unsupported fields, duplicate edge IDs,
and conflicting mappings. It never derives `smId`, dataset names, source IDs, or
versions from an edge ID.

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

1. `GET /api/geosync/health/live` returns HTTP 200 and only proves that the Node.js
   process can answer HTTP. Never use it as a traffic-readiness check.
2. `GET /api/geosync/health/ready` returns HTTP 503 while the shared MongoDB
   connection is unavailable. With MongoDB online it returns HTTP 200; when
   GeoSync graph/index/jobs are still pending or failed it reports
   `{"state":"degraded","ready":true}` so the host POI service is not removed
   from the load balancer solely because an attached GeoSync component is down.
   This public endpoint never returns MongoDB readyState, graph/index counts, or
   scheduler details.
3. `GET /api/client-config` returns HTTP 200.
4. `GET /api/geosync/client-config` returns HTTP 200 and contains no credentials,
   private service paths, MongoDB URI, administrator token, or dataset allowlist.
5. Public `GET /api/geosync/health` returns only `{state}`. Full MongoDB, graph,
   jobs, GIS, manifest, and route-cache diagnostics are available at
   `GET /api/admin/geosync/health` for administrators and
   `GET /api/screen/geosync/health` for signed/opaque screen credentials.
6. `GET /api/admin/geosync/gis/status` succeeds only with a valid signed
   administrator session or configured administrator Bearer token.
7. `POST /api/admin/geosync/gis/route-test` succeeds only with the same
   administrator authentication and is used only for smoke testing.
8. `POST /api/admin/screen/session` issues a short-lived, signed HttpOnly screen
   session only after administrator authentication; it never places the raw
   `SCREEN_TOKEN` in the cookie. `POST /api/admin/screen/logout` clears the
   session. The optional opaque screen token must never be sent in a URL. Verify
   that an expired screen cookie alone receives 403 and that the same route can
   still be reached through an independently valid administrator session.
9. An unauthenticated JSON request larger than 1 MiB returns HTTP 413 before the
   route handler, while the same route with a small JSON body reaches its normal
   authentication or business response. Repeat through Nginx, not only against
   the loopback Node port. A valid multipart upload below 10 MiB must still reach
   its route, and a file above 10 MiB must be rejected by Multer.
10. Send both `SIGTERM` and `SIGINT` in separate restart checks. New HTTP work is
    refused, active HTTP and Socket work receives the configured drain window,
    Mongoose disconnects after both listeners close, and the process exits once.

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
| MongoDB unavailable | Public `/api/geosync/health` and `/api/geosync/health/ready` return HTTP 503; signed user and administrator sessions fail closed because revocation state and principals cannot be verified | Use the independent opaque `ADMIN_TOKEN` for protected diagnostics, restore database connectivity, then recheck |
| Graph or POI index startup pending/failed | Protected detailed health returns HTTP 503; host-aware `/api/geosync/health/ready` returns only `{"state":"degraded","ready":true}` | Keep host POI traffic available while repairing database/index data or startup configuration |
| Jobs requested but scheduler failed | Protected detailed health returns HTTP 503 with `jobs.state=failed`; host-aware readiness remains HTTP 200 degraded while MongoDB is online | Repair scheduler startup; non-primary/background-disabled states are intentional and named |
| Initial MongoDB connection fails in production | Process exits with code 1 after a sanitized `MONGO_STARTUP_FAILED` log | Restore MongoDB connectivity or configuration, then let the service manager restart the process; do not disable fail-fast as a permanent workaround |
| Graceful shutdown exceeds its total deadline | Process exits with code 1 after sanitized `SHUTDOWN_TIMEOUT` diagnostics | Inspect only the named drain phase, correct the stuck dependency, and keep PM2 `kill_timeout` above the application deadline |
| `ADMIN_PASSWORD_HASH` missing/malformed, or legacy `ADMIN_PASSWORD` still populated | Browser administrator login returns HTTP 503 and startup logs only a sanitized configuration code; opaque `ADMIN_TOKEN` remains independent | Generate a new hash through stdin, remove the plaintext variable everywhere, restart, and verify wrong/new/retired password behavior |
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
- Barrier event ownership and completion records in `barrier_event_records`.

Barrier events use a Mongo-backed state machine. A unique `eventId` record stores
the normalized payload hash, `processing/completed/failed` state, owner, attempt
count, and expiry. One instance owns a 60-second lease and renews it every 20
seconds. Concurrent instances return a persisted duplicate/in-progress result
without running cache, graph, itinerary, proposal, or notification side effects.
Completed records remain for seven days and are then removed by the TTL index.
Reusing an `eventId` with a different scenic area, edge, operation, or
`cacheInvalidated` value is rejected as a contract conflict.

An exception marks the owned record `failed` and makes it reclaimable by the next
replay. A `processing` record whose lease expired is also reclaimable. Recovery
may repeat idempotent cache invalidation and graph reload work. Before writing an
itinerary, a new owner checks both `pendingProposal.payload.eventId` and durable
`rerouteLog.eventId`; work already committed by the previous owner is counted as
replayed and is not written or published again. If MongoDB cannot claim or renew
the lease, processing fails closed before further itinerary writes. Do not delete
an active lease to force a retry; replay the original, byte-equivalent event after
the lease expires or after the record enters `failed`.

The event bus, per-scenic in-process ordering queues, Socket delivery, SSE client
set, and pending OAuth/QR state remain process-local. There is no transactional
outbox, durable message queue, or cross-process Redis event bus. A process crash
can still lose an `ops:impact`, `ops:proposal-status`, or graph notification after
the database write. Operations clients must continue to reload MongoDB-backed
state after reconnect; persisted event ownership prevents duplicate barrier
proposal side effects but does not provide guaranteed message delivery.

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
- Confirmation whether any authoritative geometry may contain
  `[lng,lat,z]`; the current public contract intentionally accepts two-dimensional
  coordinates only.

Production acceptance also requires evidence outside this repository:

- The AMap owner must rotate any previously exposed jscode, apply the exact Web
  JS key domain allowlist, and supply the root-only Nginx snippet. Operations must
  apply the CDN no-cache rule, pass `nginx -t`, reload, and complete a real-browser
  map smoke test.
- Staging MongoDB must prove TTL cleanup, user and administrator revocation,
  cross-instance logout, barrier-event lease/heartbeat recovery, and
  cross-instance single ownership under the deployed
  topology. The historical `adminusers` cleanup remains a backup-protected
  operator action; its command is dry-run by default and has not dropped data.
- Linux/PM2 must prove graceful restart with in-flight HTTP and Socket work.
- Real OCR, SMTP, AMap, tourist, and operations-screen end-to-end flows must pass
  with deployment-managed credentials and without printing them.

GitHub Pull Request #1 is the review and merge boundary from `LZY` to `main`.
P3 audit closure is complete only after the final `npm ci`, syntax, full test,
production audit, diff, and staged-file gates pass and the resulting commit is
non-force-pushed to `origin/LZY`. Do not push or merge `main` directly.
