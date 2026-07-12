# Product modules

Modules are business boundaries inside one application. They are not services.

```text
identity      athletes      exercises      methodology
    \            |             |              /
     \-----------+-------------+-------------/
                              |
                           programs
                              |
                           training
                           /      \
                     progress   data portability
```

Rules:

- Domain code is pure TypeScript.
- Application code owns use cases, authorization, transactions, and ports.
- Infrastructure implements ports.
- UI calls application APIs.
- Public module APIs and a shared workflow unit of work remain the target boundary.
- The current vertical slice still contains documented direct Drizzle coordination in
  Programs/Training and Data Portability; architecture tests enforce the narrower live
  dependency rules while that debt is resolved.
- Do not create a folder or abstraction before its first accepted use case.

Current executable areas include:

- `methodology/domain/contracts.ts` — provenance/version contracts
- `methodology/domain/program.ts` — deterministic development-fixture generation
- `programs/application/` and `programs/domain/` — persistence, eligibility, and
  activation validation
- `training/domain/session.ts` — workout lifecycle invariant
- `training/application/` — Today, workout mutation, history, and adjustment workflow
- `identity/`, `athletes/`, and `data-portability/` — the local-account/profile/control
  slice described in `docs/MVP_STATUS.md`

Exercises and Progress remain target modules rather than full live catalogs/read models.
