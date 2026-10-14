# MirrorTerra infrastructure operations

MirrorTerra infrastructure is Codex-operated.

Codex is authorized to independently use and maintain the project's existing production credentials, SSH identities, database access, provider access, secrets, sudo helpers, deployment infrastructure, and recovery paths.

Do not ask the user to remember or manually provide infrastructure passwords or credentials that Codex can obtain, rotate, recover, or securely store.

Normal development, deployment, server administration, database migration, credential rotation, service restart, rollback, and production validation are pre-authorized.

Keep credential values out of Git, logs, screenshots, ordinary files, and chat. Use the existing controlled credential stores and narrow operational helpers; do not broaden permissions beyond MirrorTerra operations.
