# Outbound-network-blocked acceptance

Status: complete for code commit `6117fbe4f6ea363b8cf4553ed5c10eee51009ef6`;
rerun after any product/runtime or default-suite change

The core browser journey must work when the application cannot reach the public network.
The ordinary source guard and browser request observer remain useful regression checks,
but they do not prove the runtime boundary. This procedure supplies that proof without
changing host firewall rules.

## Boundary under test

`scripts/e2e/run-network-denied.sh` creates an unprivileged Linux user/network namespace
that has:

- one enabled interface: `lo`;
- no IPv4 or IPv6 default route;
- the application and Playwright browser on loopback;
- a private Unix-socket bridge to the configured loopback PostgreSQL port; and
- no route to a public IP, verified before and after the browser suite.

The socket bridge is deliberately narrower than sharing the host network. It exposes only
the PostgreSQL endpoint already required to pass the destructive E2E target guard. It is
created in a mode-0700 temporary directory and removed after the run. The script does not
use `sudo`, `iptables`, `nftables`, Docker networking, or persistent host configuration.

The default suite keeps `INDIGO_LLM_MODE=disabled`; optional local language generation is
not part of the core acceptance boundary.

## Retained evidence at this checkpoint

The complete 19-test default Playwright selection passed from clean committed product
tree `6117fbe4f6ea363b8cf4553ed5c10eee51009ef6`: the namespace had only loopback, no
IPv4/IPv6 default route, a public-IP connection failed, PostgreSQL was available only
through the private bridge, and the boundary was rechecked after the suite. The retained
[2026-07-16 acceptance record](evidence/2026-07-16-outbound-network-blocked.md) identifies
the tested commit, environment, command, result, and proof limits.

The recorded commit and complete test selection define which product tree was accepted.
Any later product/runtime change or default Playwright addition invalidates currency and
requires a new run; an evidence-only child commit does not change the tested tree.

## Prerequisites

- Linux with unprivileged user and network namespaces enabled;
- `unshare`, `ip`, `socat`, Node.js 24, pnpm dependencies, and Playwright Chromium;
- the repository's normal `.env.local` and `.env.e2e.local` configuration;
- `DATABASE_URL` and `E2E_DATABASE_URL` on the same literal loopback PostgreSQL host and
  port; and
- an E2E database name accepted by the existing reset guard.

This is a destructive E2E command. It recreates only the guarded disposable E2E database,
exactly like `pnpm test:e2e`; never point `E2E_DATABASE_URL` at retained data.

## Run

From the repository root:

```sh
bash scripts/e2e/run-network-denied.sh
```

A passing record must retain the command output showing all of the following:

1. `Network boundary verified: loopback available; no other interface or route.`
2. `PostgreSQL bridge verified ...`
3. `Fresh E2E database ready ...`
4. the complete default Playwright result with zero failures; and
5. `Outbound-network-denied acceptance run passed.`

Record the commit SHA, UTC time, kernel, Node/pnpm/Playwright/PostgreSQL versions, and the
complete test result alongside that output. A run from an uncommitted tree is useful while
developing but is not retained release evidence. The current retained record is linked
above.

## Failure interpretation

- `unshare: ... Operation not permitted` means the host disables unprivileged user/network
  namespaces. Run the same command on a compatible Linux host; do not substitute a
  source-only test and call the release gate closed.
- A missing bridge or connection failure means PostgreSQL is not listening on the
  configured loopback endpoint. The script intentionally does not widen the bridge.
- Any non-loopback interface, default route, or successful public-IP connection is a hard
  failure before Playwright starts.
- Browser-suite failures are product/acceptance failures even if the namespace assertions
  pass. Diagnose them through the retained Playwright trace and normal E2E logs.

This procedure proves the default J1–J9 browser suite and every other default Playwright
spec present at the recorded commit. Human methodology, security/privacy, WCAG,
physical-device, second-person cold-install, HTTPS-ingress, and off-host-retention gates
remain separate and cannot be inferred from this run.
