# Hosted SaaS MVP deployment

This opt-in deployment is separate from the default free self-hosted Compose file. Never enable hosted mode on an existing unmarked self-hosted database.

MVP policy: manual billing, manual account provisioning, no Stripe keys or automatic public signup. The website sends access requests to the team. Production starts with a new PostgreSQL database; local rehearsal accounts remain local. Platform admins configure the managed provider and approve pricing through the admin UI. Client/Partner BYOK is tenant-scoped; assigned Partners cannot access Sydekyks-wide supplier credentials or client billing.

Copy `compose.yaml`, a private `production.env`, and Caddy configuration to the server. `production.env` must be root-owned 0600, outside public assets/source archives. Set a reviewed immutable `SYDEKYKS_IMAGE`, fresh encryption/JWT/database secrets, `AP_SERVICE_MODE=hosted`, `AP_HOSTED_BILLING_MODE=manual`, explicit `AP_HOSTED_OPERATOR_IDENTITY_IDS`, public frontend URL, PostgreSQL/Redis, SANDBOX_CODE_ONLY, DB storage, and conservative worker concurrency. Never copy test Stripe keys or development supplier credentials by default.

Build with `docker build --build-arg SYDEKYKS_RELEASE_VERSION=1.1.0 --build-arg SYDEKYKS_SOURCE_REVISION=<commit> -t <immutable-image> .`. The release argument is required by runtime staging. Use BuildKit. Verify distribution boundaries and runtime resolution during the build.

Run `docker compose --env-file production.env up -d` from this directory. PostgreSQL and Redis have no published host ports. Only the app's loopback port 8080 is exposed; Caddy terminates public HTTPS on ports 80/443 and supports streaming/WebSockets. Keep 22/tcp for authorized SSH. Block public signup paths at ingress for this manual MVP. Password/setup-link authentication remains available.

Initialize only the nominated platform administrator after normal migrations. Use the application's password hasher and a verified identity matching the explicit operator allowlist. Never bypass accounting/bootstrap guards or seed paid grants. Provision clients/Partners with normal audited admin APIs/UI after payment is recorded.

Acceptance: HTTPS validity, sign-in, operator authorization, manual billing, no public signup, installed accounting/LMS migrations, catalogue availability, online worker with the current hosted accounting capabilities, and a real bounded run after production managed AI is configured. A successful HTTP health check alone is insufficient.

Back up PostgreSQL with `pg_dump -Fc`, Redis with a coordinated persistence snapshot, app assets, production.env and encryption keys. Backups are private; restore to a separate database and verify before switching. Do not delete volumes or replace encryption keys during upgrades. Keep the previous image/config and take a backup before migrations; reverse migrations are not assumed safe. An off-server encrypted backup destination and a restore drill remain explicit operational requirements.

Small servers: one worker is a starting setting, not a capacity promise. Measure API/worker RSS, swap and queue latency under the intended load. Recommend at least 4 GB RAM for the hosted stack; scale only after measuring catalogue, files, concurrent chats and workflow runs.
