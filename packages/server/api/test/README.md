# API testing

Sydekyks uses the Community runtime (`AP_EDITION=ce`). Copy `.env.tests.example` to `.env.tests` in this API workspace before testing. The template contains synthetic local values; keep provider credentials and actual environment files outside Git.

From the repository root, the focused release checks are:

```sh
node --test scripts/audit-distribution-boundaries.test.mjs
bun x vitest run --config packages/server/api/vitest.config.ts packages/server/api/test/integration/ce/sydekyks-free/free-access.test.ts
```

These verify the distribution boundary, unrestricted feature access with old license states, authentication, workspace isolation and worker assignment ownership. They do not call AI providers or send customer messages.

The broader Community integration suite is available through `npm run test-api` at the repository root or `npm run test-ce` in this workspace. Unit tests use `npm run test-unit` in this workspace. The broader suites are separate from the focused release checks above.

The inherited Enterprise/Cloud suites and broken Docker test recipe are excluded from this platform repository. `docker-compose.dev.yml` supplies local development infrastructure; it is separate from the supported release installation in the root `docker-compose.yml`.
