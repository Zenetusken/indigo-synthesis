# Product modules

Modules are business boundaries inside one application. They are not services.

Target Part B shape—sequenced by roadmap Stages 3/4 and not live at this checkpoint:

```text
Application workflows / UnitOfWork
  ├─ identity/account: identity
  ├─ initial plan: identity lifecycle fence -> athletes + exercises + methodology + calibration -> programs
  ├─ train/learn: identity lifecycle fence -> athletes + exercises + training + calibration + programs
  ├─ history: training -> progress (target extraction)
  └─ subject controls: module ports -> data portability
```

Under that target, every subject workflow captures Identity epoch/generation before queueing and acquires its session-
level locks before `BEGIN`. Identity's transactional epoch/actor/session/role check is always the
first authoritative product check. Ordinary workflows next check subject generation before owner
reads. Root setup alone may ask Athletes to classify the exact setup receipt first: replay must match
its current stored result generation, and a new command still passes Identity's generation gate
before any owner mutation.

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
Calibration is also an accepted target module, sequenced by
`docs/architecture/DEVELOPMENT_ROADMAP.md`; no executable Calibration module exists at this
checkpoint.
