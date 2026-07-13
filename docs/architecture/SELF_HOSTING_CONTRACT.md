# Self-hosting contract

Status: accepted product requirement

Self-hosting is not merely a future deployment option. It constrains application design
now.

## Required runtime

Core product operation requires only:

1. one supported Node.js process;
2. one PostgreSQL database; and
3. one writable data directory if local media uploads are enabled.

No other service is authoritative or mandatory.

The optional grounded-language path is outside that core topology. When explicitly
enabled, it adds one host-local, loopback-only llama.cpp HTTP process; PostgreSQL and the
Node.js application remain authoritative, and every core journey continues to work when
that process is absent.

## Network trust boundary

There are two distinct access modes:

- **Loopback-local use:** plain HTTP is supported only through a loopback origin such as
  `http://127.0.0.1:3000`. Both checked-in runtime commands bind that address explicitly.
- **Network use:** a phone, LAN client, public hostname, or any non-loopback client must
  use an externally visible HTTPS origin. Cookies for an HTTPS origin are `Secure`;
  loopback-HTTP cookies remain `HttpOnly` and `SameSite=Lax` but cannot carry `Secure`.

Network use therefore has an environmental ingress prerequisite: the operator supplies a
TLS terminator in front of the Node process (or an equivalent HTTPS-capable host layer).
It holds no product data and is not another application authority. The repository does
not yet provide reverse-proxy configuration or certificate automation, but TLS itself is
not deferred or optional for non-loopback use.

The supported proxy runs on the same host and reaches the application through loopback.
Authentication reads client addresses only from `X-Forwarded-For`, strips trusted
loopback proxy hops from right to left, and rejects malformed chains. The ingress must
overwrite any client-supplied forwarding header or append its verified peer address
safely; it must never preserve an arbitrary client header as the sole trusted value.
Production HTTPS authentication fails closed when no trustworthy client address can be
resolved, avoiding a spoofable or globally shared rate-limit bucket.

## No mandatory outbound network

After installation, the complete core journey is designed to work with outbound network
access blocked. Source guards and browser request observation cover the normal suite. A
checked-in Linux namespace runner additionally removes every non-loopback interface and
default route while exposing PostgreSQL through a private Unix-socket bridge. That runner
has passed the preceding 15-test default tree; retaining a rerun of the current 19-test
suite from the final clean commit remains the open release-evidence step.

Therefore:

- authentication is local;
- fonts, icons, and core imagery are bundled;
- no CDN is required;
- no cloud object store is required;
- no email provider is required for normal sign-in;
- no analytics, telemetry, error-reporting, or model API is required;
- no social OAuth provider is required; and
- no remote exercise/content API is called at runtime.

Optional outbound adapters must be disabled by default and fail without breaking core
use.

Optional **local** language inference is implemented for grounded History explanation
prose but remains non-mandatory and disabled by default. Enabling the supported product
path currently requires the exact digest-locked Qwen3.5-9B Q4_K_M artifact and the
pinned/attested CUDA llama.cpp runtime on loopback; alternate operator stacks are
diagnostic only. Inference must never become required for J1–J6. See
[ADR 0006](adr/0006-optional-local-grounded-language.md) and the
[explanation generation contract](EXPLANATION_GENERATION_CONTRACT.md).

## Configuration surface

The current required configuration is:

- database URL;
- application origin;
- authentication secret.

Content mode defaults to `reviewed`. The unreviewed technical fixture is available only
when an operator explicitly selects `development`.

A local data directory becomes optional configuration only if media uploads are enabled;
the current slice has no upload path.

SMTP, S3-compatible storage, external identity, and other potential future adapters are
explicitly non-mandatory; none is implemented in the engineering MVP.

Runtime configuration is validated at process use. The supported production command
also runs schema/database preflight before listening and fails with a specific corrective
message. Local development follows the documented explicit `pnpm db:preflight` step; it
does not silently substitute plausible fake data.

Startup rejects every non-loopback plain-HTTP application origin.

`pnpm db:preflight` verifies PostgreSQL 18 or newer, all 17 current committed migration
hashes including the exact canonical 0004 program-ordinal provenance, owner-bootstrap
enforcement, current snapshot/revision and correction/invalidation structures,
append-only content-release revocations, the access/recovery persistence and HMAC-keyed
admission contract, the explanation-cache contract, and all 28 required enabled
trigger/table/function bindings. `pnpm start` runs this preflight before starting the
production server. Both
supported runtime commands bind `127.0.0.1` explicitly. A network-facing HTTPS ingress
runs on the same trusted host and forwards to that loopback listener; the application
process does not expose a plain-HTTP LAN socket.

Development content is never a production fallback: a production process rejects
`INDIGO_CONTENT_MODE=development`, and no reviewed program release is bundled yet.

## Accounts

- A fresh installation accepts first-owner creation only with a host-issued, expiring,
  one-use capability; generic signup is disabled even before the first owner exists.
- A singleton installation row and capability row are locked while credential creation,
  capability consumption, and bootstrap closure commit atomically; concurrent attempts
  cannot create a second first owner.
- Database user insertion requires an explicit transaction-local `bootstrap-owner` or
  `owner-admin` creation mode. Missing and unknown modes fail closed.
- Public signup remains off after bootstrap.
- The owner can create local users only after current-password reauthentication; the
  initial password is shared out of band. No invitation or email-delivery flow exists.
- A reauthenticated owner may issue an expiring, one-use reset code for a non-owner
  account. The trainee redeems it through `/reset` and chooses the final password. The
  owner account cannot be a member-reset target.
- If the only owner is locked out, a host-local administrative command with database
  access issues an expiring, one-use recovery code. Redemption is available through
  protected CLI files or `/recover`; the latter is never a browser-only recovery path
  because issuance remains host-anchored.
- Both recovery flows replace the credential, revoke every affected PostgreSQL session,
  and append a redacted audit event. Web recovery uses HMAC-keyed fixed-window admission,
  minimized client-address audit data, and bounded cleanup; raw identifiers and secrets
  do not enter throttle or audit rows.
- Session reads disable cookie caching. Core credential auth exposes no bearer, JWT, or
  refresh-token path to browser JavaScript, so database session revocation takes effect
  on the next request.
- The current slice has no SMTP/self-service email reset, public signup, role mutation,
  standalone session-management UI, or security-events view.

## Data ownership

The complete backup boundary is:

- PostgreSQL; and
- the configured media directory, if enabled.

Export is a product feature, not a database-admin substitute. It includes a schema
version and enough provenance to interpret programs, sessions, and recommendations.

Deletion is an explicit destruction exception to immutable history. The current Data
Portability workflow directly deletes or redacts scoped personal records in referential
order inside one serializable transaction; Identity is last. Subject deletion retains a
non-personal completion tombstone. Instance reset also retains the cleared singleton
installation record and any earlier non-personal tombstones, then appends its own
tombstone. Tombstones contain only event metadata, aggregate row counts, schema version,
and a completion digest. Subject deletion and instance reset are tested. A guarded
manual PostgreSQL backup/restore procedure and disposable-database drill now exercise
logical archive, full schema wipe/restore, exact marker recovery, append-only trigger
behavior, and startup preflight. Operators still own encryption, off-host retention,
runtime-secret custody, deployment-specific restore practice, recovery objectives, and
any future media boundary. See [the runbook](../operations/BACKUP_RESTORE.md).

## Privacy and telemetry

- Application telemetry is off by default.
- Build/CLI telemetry is disabled where supported.
- Logs avoid secrets, auth tokens, raw health context, and unnecessary personal data.
- The product collects only data required by an accepted use case.
- Optional integrations document every outbound field and destination.

## Supported baseline

The first supported core topology is one application instance and one PostgreSQL
instance. An explicitly enabled local-language path may add the non-authoritative
loopback inference process described above.
Multi-instance cache coordination, HA databases, replicas, failover, and multi-region
operation are not implicit requirements.

## Deferred packaging

This contract does not prescribe installation packaging yet. The following are deferred:

- Docker/Compose
- reverse proxy configuration and TLS/certificate automation
- systemd or other service unit
- CI/CD
- monitoring stack
- backup automation
- high availability

When packaging work begins, it must satisfy this contract rather than expand the runtime
without need.

## Verification

The first release gate includes a test environment where outbound network is denied and
only the application, PostgreSQL, and optional media directory are available.

`scripts/e2e/run-network-denied.sh` now supplies that runtime boundary and has passed the
preceding 15-test default tree. The current branch adds four access/recovery cases, so the
final release record still requires a clean-commit 19/19 rerun. See the
[acceptance runbook](../operations/OUTBOUND_NETWORK_BLOCKED_ACCEPTANCE.md) and
[MVP status](../MVP_STATUS.md). Independent methodology, security/privacy, WCAG,
physical-device, cold-install, HTTPS-ingress, and off-host-retention gates remain
separate.
