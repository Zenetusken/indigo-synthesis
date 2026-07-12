# Data portability

Coordinates versioned export and explicitly confirmed deletion. It owns workflow order,
archive format, omission reporting, and the non-personal deletion tombstone. The current
vertical slice uses a read-only, repeatable-read export projection over the shared schema;
published module export ports remain the intended boundary as modules mature.

Deletion plans are previewable. Current execution uses one direct serializable,
referentially ordered transaction with Identity last; public module deletion ports and a
shared unit-of-work adapter remain architecture debt. Deletion is the explicit
destruction exception to immutable training history. Exact preview counts cover every
affected live table, including the preview row itself, while excluding retained
non-personal tombstones.
