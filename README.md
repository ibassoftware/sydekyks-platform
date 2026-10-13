# Sydekyks

Build visual workflows, connect your tools, and automate routine work with help from Syd.

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

Self-hosting is free. Optional managed hosting, support, and workflow implementation are available through [Sydekyks](https://www.sydekyks.com).

Connected services and AI providers may charge their own fees.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and validation commands. Build the application image with `Dockerfile.release`; this rebuilds the API, worker, engine and web application and checks the distribution boundary.

## Licensing and attribution

Sydekyks builds on Activepieces and other third-party components. Upstream copyright and license notices are retained.

See [LICENSE](LICENSE) and [NOTICE.sydekyks.txt](NOTICE.sydekyks.txt) for licensing and attribution details.
