# Cross-module composition

This is the live product composition layer for multi-module use cases. It owns workflow
order and authorization but no domain entities or tables.

Stage 3 separates coordination into three layers:

- `src/application/coordination/` owns infrastructure-free `UnitOfWork`, lock, authority,
  content-plan, and scoped-gateway contracts;
- this directory composes product workflows against those contracts; and
- `src/platform/application-coordination/` implements the PostgreSQL transaction,
  prelocked-session, capability, and scoped-Drizzle mechanics.

Identity lifecycle mutations and Data Portability export/destructive execution use this
composition root today. The Data Portability gateways are deliberately temporary
cross-owner adapters; public per-module export/deletion ports remain Stage 9 work.
Programs/Training co-write retirement lands in Stage 6. No generic orchestration framework
or product DML belongs in this directory.
