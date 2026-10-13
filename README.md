# Sydekyks

Build visual workflows, connect your tools, and automate routine work with help from Syd.

Sydekyks is source available. New original project contributions use the Sydekyks Sustainable Use License; upstream components and the previously published MIT version retain their existing licenses.

All available features are free. No license key, activation, trial period, or expiry is required.

## What you can do

- Build workflows with triggers, actions, and connected services.
- Use Syd to help create and improve workflows.
- Create and manage saved AI agents.
- Self-host the platform on your own infrastructure.

## Get started

Follow the [Docker Compose installation guide](https://docs.sydekyks.com/install/options/docker-compose).

The published image is `ibassoftware/sydekyks:1.0.6`, available for Linux AMD64 and ARM64. Installation requires PostgreSQL with pgvector and Redis.

The root Compose file matches the reviewed installation guide. For a fresh local installation:

```sh
bash tools/deploy.sh
docker compose config --quiet
docker compose up -d --wait
```

Open `http://localhost:8080`. Review your private `.env` before deploying to a server. Keep the generated encryption key and database volumes when upgrading an existing installation. The supported installation runs the application and worker together with separate PostgreSQL and Redis services.

## Documentation

Visit [docs.sydekyks.com](https://docs.sydekyks.com) for setup instructions and product guides.

## Hosting and support

Self-hosting is free. Optional managed hosting and support, including workflow implementation, are available through [Sydekyks](https://www.sydekyks.com).

Authorized partners may provide hosting and support under their written partner agreements. Installation, customization, training, and support on customer-owned infrastructure are permitted. Competing hosting and software resale of code covered by the Sustainable Use License require written authorization.

Connected services and AI providers may charge their own fees.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and validation commands. Build the application image with `Dockerfile.release`; this rebuilds the API, worker, engine and web application and checks the distribution boundary.

## Licensing and attribution

Sydekyks builds on Activepieces and other third-party components. Upstream copyright and license notices are retained.

The [Sydekyks Sustainable Use License](LICENSE.sydekyks.txt) keeps every available feature free for personal use and internal business self-hosting, with restrictions on competing hosting and software resale. There is no separate paid feature edition or activation requirement.

The existing MIT source baseline and published `1.0.6` image retain their original permissions, including commercial hosting and redistribution. The new restrictions apply to future covered contributions; this change adds no new functional application code. Read [license scope and transition](LICENSE_SCOPE.md) before relying on those restrictions.

See [LICENSE](LICENSE), [LICENSE.activepieces.txt](LICENSE.activepieces.txt), and [NOTICE.sydekyks.txt](NOTICE.sydekyks.txt) for all applicable licensing and attribution notices.
