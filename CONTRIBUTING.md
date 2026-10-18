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
docker buildx build --platform linux/amd64,linux/arm64 --build-arg SYDEKYKS_RELEASE_VERSION=1.0.9 --build-arg SYDEKYKS_SOURCE_REVISION="$(git rev-parse HEAD)" --tag sydekyks:local --output type=oci,dest=sydekyks-local.oci.tar --file Dockerfile.release .
```

Submit a pull request describing the behavior changed, validation performed, and any upgrade impact. Preserve authentication, workspace isolation, retained notices, and unrestricted access to implemented features. Never introduce imports from the excluded upstream enterprise directories.

Report security issues privately using [SECURITY.md](SECURITY.md).

## Contribution licensing

Read [LICENSE_SCOPE.md](LICENSE_SCOPE.md) before contributing. New original contributions are offered under the [Sydekyks Sustainable Use License](LICENSE.sydekyks.txt), unless an explicit license or written contribution agreement states otherwise. Existing MIT code and third-party components retain their licenses and notices.

When submitting an original contribution under these terms, you confirm that you have authority to license it and grant the project maintainers a perpetual, worldwide, non-exclusive, royalty-free right to use, modify, distribute, and sublicense that contribution under the Sustainable Use License and written authorizations for partner hosting, support, and resale. You retain your copyright. Identify any third-party material and its license in your pull request; this grant does not apply to rights you do not own or control. Unclear ownership or incompatible third-party terms must be resolved before a contribution is accepted.
