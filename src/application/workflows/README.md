# Cross-module workflows

This is the target composition layer for multi-module use cases. It will receive public
module gateways scoped to one `UnitOfWork` transaction without owning domain entities or
tables. No executable workflow or unit-of-work adapter exists here yet.

The live program/training and data-portability workflows currently coordinate directly
through Drizzle transactions, as recorded architecture debt. No generic orchestration
framework belongs here.
