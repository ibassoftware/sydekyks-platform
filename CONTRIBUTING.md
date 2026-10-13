# Contributing

Use Node.js 24 and Bun 1.4.0, matching the release build and lockfile.

```sh
bun install --frozen-lockfile
cp .env.dev.example .env.dev
cp packages/server/api/.env.tests.example packages/server/api/.env.tests
cp packages/tests-e2e/.env.e2e.example packages/tests-e2e/.env.e2e
```

Configure your local environment before starting the application. Generate your own development secrets; never use test credentials for a shared deployment. Keep environment files and provider credentials outside Git.

```sh
npm start
```

Validate a change with the relevant tests and the required lint and distribution checks:

```sh
npm run lint-dev
npm run check:distribution:build
node --test scripts/audit-distribution-boundaries.test.mjs
```

The supported release installation uses the root `docker-compose.yml` and the [Docker Compose guide](https://docs.sydekyks.com/install/options/docker-compose). Generate a private deployment environment with `bash tools/deploy.sh`; the helper preserves an existing `.env`. Kubernetes and Pulumi deployment templates are outside the supported installation path.

Build the application with the pinned release recipe:

```sh
docker buildx build --platform linux/amd64,linux/arm64 --build-arg SYDEKYKS_SOURCE_REVISION="$(git rev-parse HEAD)" --tag sydekyks:local --output type=oci,dest=sydekyks-local.oci.tar --file Dockerfile.release .
```

Submit a pull request describing the behavior changed, validation performed, and any upgrade impact. Preserve authentication, workspace isolation, retained notices, and unrestricted access to implemented features. Never introduce imports from the excluded upstream enterprise directories.

Report security issues privately using [SECURITY.md](SECURITY.md).
