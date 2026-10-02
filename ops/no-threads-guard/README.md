# Permanent Agentbox policy: no people-first Threads

Sam requires the removed Threads product feature to remain absent after updates.
Normal agent sessions and provider conversation IDs are unaffected.

Host installation (outside the replaceable OMG release):
- `~/.local/lib/omg-no-threads/check.py`
- `~/.config/omg/no-threads-required` (safe updater policy marker)
- `~/.config/systemd/user/omg.service.d/99-no-threads.conf`
- `~/bin/omg-safe-update` calls the checker before updating and after replacement,
  before restart. A failure rolls back software using the existing backup path.

The startup guard runs after the private and isolation overlays. The version-pinned
private layer remains required: an unsupported release is refused in archive
preflight before live dependencies or source are replaced. Do not remove that
version gate, the host policy marker, checker or systemd hook to force an update.

For every future port: retain the Threads deletions, verify source/API/MCP and
desktop/mobile UI, build the web bundle, run this guard, and regenerate the private
manifest with deletion tombstones. Then test the normal safe update and rollback.
The guard follows Vite's active JavaScript graph, ignoring retained inactive hashes
needed by existing tabs; a new bundler/layout requires explicit guard review.
It detects the known feature entrypoints, not every imaginable renamed implementation.
Keep end-to-end review as part of release approval.

Official 0.6.157 is not approved: it restores the feature in server, MCP and web.
The release notification may remain visible; availability is not local approval.
