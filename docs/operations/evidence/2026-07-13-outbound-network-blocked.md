# Outbound-network-blocked acceptance evidence — 2026-07-13

Scope: the complete default browser selection against committed code tree
`7c7ea334d4c88d9279abe574031881a23a15f32c` (`docs: synchronize access recovery
checkpoint`). This evidence-only document is the child change; the tested product tree
was clean.

Command:

```sh
bash scripts/e2e/run-network-denied.sh
```

Environment recorded immediately after completion at `2026-07-13T19:38:43Z`:

- kernel: Linux `7.0.11-76070011-generic`, x86_64;
- Node.js `v24.9.0`;
- pnpm `10.7.1`;
- Playwright `1.61.1`;
- PostgreSQL server/client `18.4`; and
- optional LLM mode disabled by the default E2E runner.

Retained boundary and result:

```text
Starting destructive, guarded default E2E reset/run in a loopback-only namespace.
Network boundary verified: loopback available; no other interface or route.
PostgreSQL bridge verified on 127.0.0.1:55432.
Fresh E2E database ready: indigo_synthesis_e2e
Running 19 tests using 1 worker
19 passed (5.8m)
Network boundary verified: loopback available; no other interface or route.
Outbound-network-denied acceptance run passed.
```

The passing selection covered J1–J9, destructive subject/instance workflows,
cross-user denial, safety holds/corrections, unit round-tripping, mobile keyboard/reflow,
J7 session revocation with exact committed-workout resume, J8 web recovery and
non-amplifying uniform throttling, J9 open/claimed-instance orientation, process
restart/replay, and E2E supervisor replacement.

This proves the checked-in runtime/test selection at the recorded code commit can execute
without a non-loopback interface or default route. It is not methodology approval, an
independent security/privacy or WCAG review, an HTTPS-ingress deployment test, a
second-person cold install, or off-host backup/retention evidence.
