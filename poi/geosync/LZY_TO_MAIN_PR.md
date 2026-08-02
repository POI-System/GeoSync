# Pull Request: Complete GeoSync Backend and SuperMap Integration

Base branch: `main`

Head branch: `LZY`

## Summary

This PR integrates GeoSync into the existing POI Node.js process and completes
the Li Ziya backend boundary for SuperMap access, itinerary routing, barrier
rerouting, operations events, migration tooling, and degradation handling.

The production process continues to use one Express application, one HTTP/
Socket.io server, one Mongoose connection, and the existing POI identity/models.
GeoSync is attached through dependency injection before static files and before
`server.listen(...)`.

## Main Changes

- Attach `poi/geosync` to `poi/server.js` as the single production service.
- Reuse the host POI/User models, Mongoose connection, authentication identity,
  Socket.io instance, mail/template helpers, OCR helper, uploads, and static host.
- Add a dependency-injected `SuperMapGateway` as the only business-layer iServer
  access boundary.
- Add manifest validation, safe public configuration, Mock transport fixtures,
  request IDs, timeout/retry limits, credential handling, and sanitized errors.
- Normalize public geometry to WGS84/EPSG:4326 GeoJSON `LineString` with
  `[lng,lat]` ordering while retaining legacy `pathGeometry`.
- Support `normal`, `accessible`, and `shade` routing with canonical distance,
  duration, segments, snap data, GIS provenance, and accessibility verification.
- Add canonical route caching, directional keys, sorted barriers, TTL handling,
  manifest-version invalidation, and cache diagnostics.
- Implement the documented `8201` through `8206` route error contracts.
- Route itinerary planning and proposal acceptance through the injected Gateway
  adapter while preserving route, ETA, timetable, version, and legacy fields.
- Add full closed-edge snapshots, barrier fingerprints, per-scenic serialization,
  idempotent graph-event handling, reroute proposals, and operations impact/status
  contracts.
- Add authenticated GIS status and route-test administration endpoints.
- Persist closure metadata, route provenance, barrier proposal metadata, and
  proposal lifecycle records.
- Add a dry-run-first, conditional, idempotent SuperMap WalkEdge `sourceRef`
  migration using explicit authoritative mappings only.
- Preserve the existing POI endpoints and single-process startup behavior.

## API and Event Contracts

Updated or added HTTP surfaces include:

- `GET /api/geosync/client-config`
- `GET /api/geosync/health`
- `POST /api/itinerary/plan`
- `POST /api/admin/geosync/graph/edge/:edgeId/close`
- `POST /api/admin/geosync/graph/edge/:edgeId/open`
- `GET /api/admin/geosync/gis/status`
- `POST /api/admin/geosync/gis/route-test`
- `POST /api/admin/screen/session`
- `POST /api/admin/screen/logout`

Operations event contracts include:

- `ops:impact`
- `ops:proposal-status`

Allowed proposal lifecycle statuses are `shown`, `accepted`, `rejected`,
`expired`, and `failed`.

## Data and Configuration Changes

- Route and stop schemas persist geometry, distance, duration, GIS provenance,
  segments, snap metadata, accessibility verification, and `pathGeometry`.
- WalkEdge persists `sourceRef`, `closedReason`, and `closedAt`.
- Barrier proposals and reroute log entries persist proposal/event IDs, edge ID,
  barrier fingerprint, lifecycle status, and decision metadata.
- `.env.example` contains placeholder-only SuperMap configuration; blank
  server-side credentials and reviewer identities; signed-session settings; and
  bounded user, administrator, and screen session lifetimes.
- `poi/config/supermap-manifest.example.json` is a placeholder contract only.

The migration mapping format is an explicit JSON array of:

```text
{edgeId, datasetName, smId, sourceId?, dataVersion}
```

Dry-run is the default. Apply mode requires both `--apply` and an explicitly
configured `MONGO_URI`. No GIS identifiers or versions are derived from edge IDs.

## Verification Commands

Run from `D:\poi项目\poi` after all changes are stable:

```powershell
& 'D:\nodejs\npm.cmd' run check:syntax
& 'D:\nodejs\npm.cmd' run test:geosync
& 'D:\nodejs\npm.cmd' run test:integration
& 'D:\nodejs\npm.cmd' test
& 'D:\nodejs\npm.cmd' run audit:prod
```

Evidence captured on August 2, 2026:

- `check:syntax`: passed.
- GeoSync unit suite: 302 passed, 0 failed.
- Single-service integration suite: 3 passed, 0 failed.
- Combined unit and integration suite: 305 passed, 0 failed.
- Production dependency audit: failed with 14 package findings, including 4
  high, 10 moderate, 0 low, and 0 critical.

## Security Review

- No default administrator token remains.
- Production requires signed user identity; legacy `X-Open-Id` compatibility is
  available only when explicitly enabled outside production.
- User and administrator sessions are signed, expiring, and transported through
  HttpOnly SameSite cookies or explicitly supported authorization headers.
- Administrator GIS endpoints reject missing, malformed, query/body, or invalid
  credentials and accept only a signed administrator session or configured
  Bearer token.
- Reviewer entitlement is granted only through the server-side
  `REVIEWER_OPENIDS` allowlist; a historical database reviewer role or subscription
  flag alone is downgraded to collector authority. The database role remains the
  allowlisted user's current UI mode and is never accepted from the client as an
  authorization claim.
- Screen credentials are rejected in query strings. The administrator bootstrap
  endpoint issues a bounded signed `screen` cookie and never stores the raw
  `SCREEN_TOKEN` in it; the optional strong opaque token remains header-only.
  Signed screen expiry is enforced server-side: an expired screen cookie alone
  is rejected, while an independently valid signed administrator cookie remains
  an authorized fallback for screen-protected routes and fresh-session bootstrap.
- Browser OAuth state is random, short-lived, cookie-bound, and reserved before
  the upstream exchange. It is committed exactly once only after the returned
  OpenID is validated and the user is resolved; a failed or aborted exchange
  releases the still-valid reservation so a later retry can reserve it. QR OAuth
  state is `sid`-bound, while `/auth/status` also requires the separate HttpOnly
  SameSite=Strict `poi_qr_login_claim` cookie, preventing a scanning device or
  bare-`sid` caller from claiming the desktop session.
- Administrator login and browser/QR OAuth issuance use bounded fixed-window
  throttles and return HTTP 429 with `Retry-After` when limits are exceeded.
- Authentication throttles key `req.ip` through the explicit Express proxy trust
  policy. `TRUST_PROXY=loopback` is the safe default; non-loopback deployments
  must use a reviewed hop count from 0 through 10 or name exact trusted proxy
  IPs/CIDRs/lists. Unsafe `true`, `*`, and out-of-range counts fall back to
  `loopback` rather than enabling blanket trust.
- Socket handshakes accept only signed session auth/cookies in production, reload
  current user roles server-side, reject query-only or mismatched identities, and
  derive user/admin room membership without trusting client-declared roles. Host
  and GeoSync identities revalidate every 60 seconds even while idle.
- iServer and MongoDB credentials remain server-side.
- Client configuration excludes private service paths, datasets, credentials,
  administrator tokens, and MongoDB URI.
- Dataset/field allowlists and bounded feature counts are manifest-controlled.
- Request IDs and GIS logs are sanitized; raw upstream responses are not logged.
- Accessible routing cannot use unverified local fallback.
- Migration output omits credentials, MongoDB URI, and raw database errors.

## Degradation and Recovery

- Missing or incompatible manifest: main service starts, GIS is `offline`.
- Partial GIS service availability: health remains HTTP 200 with GIS `degraded`
  when MongoDB is online.
- Timeout with route cache: `source=cache`, `degraded=true`.
- Trusted normal/shade local route: `source=local-fallback`, `degraded=true`.
- Unverified accessible local route: explicit `8204` failure.
- No usable source: explicit `8201` failure.
- Edge transitions invalidate route cache and evaluate the complete closed-edge
  barrier set.

See `poi/geosync/DEPLOYMENT_RECOVERY.md` for deployment gates, migration recovery,
health interpretation, error handling, and application rollback.

## Residual Risks and External Blockers

- This is a backend-only authentication rollout. Existing portal code may retain
  an OpenID in `localStorage` after the signed HttpOnly `poi_user_session` cookie
  is missing or expires. The stored OpenID no longer grants authority, but the
  portal may still render authenticated state while protected requests return
  HTTP 401. Deployed users must re-authorize after rollout and whenever the
  cookie is lost.
- Portal user logout/session-expiry recovery is absent. The current logout
  handler changes only browser-visible role/UI state and does not call
  `POST /api/auth/logout`; on a shared device, clearing or changing visible state
  can leave the signed HttpOnly user cookie active. The frontend follow-up must
  bootstrap through `GET /api/auth/session`, recover from HTTP 401, clear stale
  display state, and call `POST /api/auth/logout` for sign-out.
- Administrator cleanup is also absent. The non-credential `cookie-session`
  marker stored in `sessionStorage` can remain after the signed
  `poi_admin_session` cookie expires, while clearing or abandoning the marker
  does not clear a still-valid HttpOnly administrator cookie. The frontend must
  recover from stale session state and HTTP 401/403 responses, close stale
  administrator UI, and call `POST /api/admin/logout` for explicit sign-out.
- Full OpenID transport remains a privacy and logging risk. Complete OpenIDs
  still cross OAuth redirect URLs, the `/auth/status` QR polling response,
  localStorage, portal navigation and POI/notification/chat request URLs, form
  fields, and Socket query strings. The backend no longer trusts those values as
  authority, but the transport and storage exposure remains. Frontend follow-up
  should derive identity from `GET /api/auth/session` and remove these identity
  transports. Until that work lands, operators must communicate re-authorization
  and monitor authentication failures without logging full OpenIDs.
- Reviewer rollout requires an authoritative identity inventory before
  `REVIEWER_OPENIDS` is populated. Historical `role='reviewer'` and
  `reviewerSubscribed=true` rows are not trusted and must be cleaned through a
  reviewed conditional database change. An allowlisted reviewer may temporarily
  choose collector UI mode without losing the persisted subscription flag, then
  return to reviewer mode because entitlement remains allowlist-controlled.
- No real iServer integration has been executed. Unit and integration coverage
  uses Mock/internal contracts only.
- Real validation still requires the actual base, published service paths,
  validated manifest, account permissions, representative raw responses, and an
  authoritative WalkEdge mapping with matching `dataVersion`.
- The currently seeded graph has no proven authoritative sourceRef mapping.
  Local fallback must not be described as deployable until migration dry-run and
  apply succeed against real data.
- Event delivery and barrier dedupe queues are process-local. MongoDB route and
  lifecycle state is durable, but there is no transactional outbox or shared
  message broker. Operators and clients must reload authoritative state after
  reconnect or restart.
- Production dependencies contain 14 package findings: 4 high, 10 moderate, 0
  low, and 0 critical. The remaining high findings are `nodemailer` plus the
  legacy AliCloud `@alicloud/oss-baseclient`, nested `@alicloud/credentials`, and
  `json-bigint` chain. Available audit remediation crosses reviewed major-version
  boundaries, so remediation or an approved time-bounded exception is required
  before production release. Do not apply forced or major upgrades without
  focused compatibility work and the full regression.
- `git ls-remote` and `git push --dry-run origin LZY` succeeded on August 2, 2026.
  The `gh` executable is unavailable, so automated PR creation remains blocked;
  use an approved GitHub web/API workflow if it is not installed before delivery.

## Rollback Plan

1. Remove traffic and capture sanitized health/GIS diagnostics and request IDs.
2. Stop the single POI process.
3. Restore the last approved `LZY` release commit without modifying `main`.
4. Run `npm ci`, syntax checks, and the full regression on the rollback commit.
5. Restore MongoDB only from the approved snapshot or an explicit authoritative
   reverse mapping; never infer previous sourceRef values.
6. Restore the manifest, network publication, graph mapping, and `dataVersion` as
   one aligned set.
7. Restart and repeat legacy POI, health, client-config, admin GIS, route, Socket,
   and SSE smoke checks.

## Reviewer Focus

- Verify no business route constructs iServer URLs or Axios parameters directly.
- Verify close/open handlers accept only real state transitions and invalidate
  cache once.
- Verify reroute processing uses the full current barrier set and avoids stale
  proposals through version/proposal CAS filters.
- Verify accessible fallback requires explicit verification.
- Verify client configuration and logs contain no private values.
- Verify signed session expiry, legacy-header production rejection, server-side
  reviewer authorization, query/body credential rejection, and signed Socket
  room derivation without query-only identity fallback.
- Verify migration apply remains explicit, conditional, idempotent, and sanitized.
- Verify the final combined regression is green after all concurrent edits stop.
