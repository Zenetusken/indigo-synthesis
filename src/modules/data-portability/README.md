# Data portability

Coordinates versioned export and explicitly confirmed deletion. It owns workflow order,
archive format, omission reporting, and the non-personal deletion tombstone. Subject export now
uses a read-only, repeatable-read `UnitOfWork` with a subject-scoped temporary cross-owner
projection; published module export ports remain the intended boundary as modules mature.

Deletion plans are previewable and their creation/current-plan reads remain direct. Protected
execution captures actor/session/epoch authority before queueing, rechecks Identity first, and uses
an exact table/verb-scoped temporary adapter inside a serializable `UnitOfWork`; public module
deletion ports remain architecture debt. Deletion is the explicit destruction exception to
immutable training history. Exact preview counts cover every affected live table, including the
preview row itself, while excluding retained non-personal tombstones. Short-lived signed result
notices are nonce-bearing and actor-bound on authenticated surfaces; they report the outcome after
redirect and never authorize deletion or reset.
