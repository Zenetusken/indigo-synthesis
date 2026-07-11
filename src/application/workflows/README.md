# Cross-module workflows

This composition layer will coordinate accepted multi-module use cases without owning
domain entities or tables. It receives public module gateways scoped to one `UnitOfWork`
transaction. Repositories remain private to modules and never escape the transaction
callback.

The first concrete workflows are program instantiation and data portability. No generic
orchestration framework belongs here.
