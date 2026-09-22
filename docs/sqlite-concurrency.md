# SQLite process locks

The mixed-load release benchmark found a real native SIGBUS in SQLite's WAL header while another generated worker opened the same vault. A minimal cross-process lock probe isolated the cause: `privateFile` opened and closed an existing `mote.sqlite-shm` outside SQLite. On POSIX, that close releases the process's existing locks on the inode. SQLite's own connection sharing handles this rule; an unrelated file descriptor bypasses its coordination.

Database and sidecar permission validation now uses metadata checks and chmod without opening existing files. New database files use exclusive creation; all existing symbolic links, non-owned objects and multiple hard links still fail closed. The containing vault directory is private and owned. Ordinary asset files retain the existing descriptor-based validation.

The focused regression holds a write transaction, rechecks every database sidecar, and verifies a separate Node/SQLite process remains locked out until rollback. Existing permission/link tests also pass. A 4,000-catalog / 12-observation concurrent recovery run passes after this fix; the larger result is recorded separately. This applies to native macOS/Linux storage, not to a simulated application-level retry.

Primary reference: [SQLite's POSIX close locking caveat](https://www.sqlite.org/howtocorrupt.html#posix_close_bug).
