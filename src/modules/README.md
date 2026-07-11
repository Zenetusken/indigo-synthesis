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
- Another module is visible only through its public `index.ts`.
- Multi-module operations are composed in `src/application/workflows/` through the shared
  transaction/unit-of-work contract.
- Do not create a folder or abstraction before its first accepted use case.

Current executable domain foundations:

- `methodology/domain/contracts.ts` — provenance/version contracts
- `training/domain/session.ts` — workout lifecycle invariant

The remaining directories document intended ownership but intentionally contain no
speculative implementation.
