# Data portability

Coordinates versioned export and explicitly confirmed deletion through public module
ports. It owns workflow order, archive format, omission reporting, and the non-personal
deletion tombstone; it does not own or directly query another module's personal data.

Deletion plans are previewable. Execution uses the shared unit-of-work port, follows a
declared referential order with Identity last, and is the explicit destruction exception
to immutable training history.
