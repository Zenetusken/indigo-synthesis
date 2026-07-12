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

## Network trust boundary

There are two distinct access modes:

- **Local development:** plain HTTP is supported only through the loopback origin
  `http://127.0.0.1:3000`. The checked-in development command binds that address
  explicitly.
- **Network use:** a phone, LAN client, public hostname, or any non-loopback client must
  use an externally visible HTTPS origin. Production authentication cookies are always
  `Secure`.

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

After installation, the complete core journey works with outbound network access blocked.

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

`pnpm db:preflight` verifies PostgreSQL 18, the committed migration ledger including the
exact canonical 0004 program-ordinal hash, owner bootstrap enforcement, current
snapshot/revision columns, and the required integrity triggers. `pnpm start` runs this
preflight before starting the production server. Both
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
- The owner can create or invite local users according to the approved user model.
- The current slice has no SMTP or browser password-reset adapter. If the only owner is
  locked out, a host-local administrative command with database access may issue an
  expiring one-use recovery code. Redemption revokes existing sessions and records a
  redacted audit event. Member self-service reset and optional SMTP remain future work.
- Core auth does not expose refresh tokens to browser JavaScript.

## Data ownership

The complete backup boundary is:

- PostgreSQL; and
- the configured media directory, if enabled.

Export is a product feature, not a database-admin substitute. It includes a schema
version and enough provenance to interpret programs, sessions, and recommendations.

Deletion is an explicit destruction exception to immutable history. Modules delete or
redact scoped personal records in referential order inside one transaction; Identity is
last. The retained system tombstone contains only event metadata, row counts, schema
version, and a completion digest. Deletion and restore behavior are tested in the first
release journey and drilled again before beta.

## Privacy and telemetry

- Application telemetry is off by default.
- Build/CLI telemetry is disabled where supported.
- Logs avoid secrets, auth tokens, raw health context, and unnecessary personal data.
- The product collects only data required by an accepted use case.
- Optional integrations document every outbound field and destination.

## Supported baseline

The first supported topology is one application instance and one PostgreSQL instance.
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

This remains an open release proof. The implementation has no mandatory runtime cloud
adapter, but the complete browser journey has not yet been retained from an
outbound-network-denied environment. See [MVP status](../MVP_STATUS.md).
