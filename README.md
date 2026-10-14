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

Install and start [Docker Desktop](https://docs.docker.com/get-docker/) on Windows or macOS. On Windows, use Linux containers. On Linux, use Docker Desktop or Docker Engine with the [Compose plugin](https://docs.docker.com/compose/install/linux/). Allow at least 4 GB of memory for Docker.

Open a terminal in the folder where you want to keep Sydekyks, then copy the commands for your operating system. No repository checkout or manual configuration is needed.

### Windows (PowerShell)

```powershell
Invoke-WebRequest -UseBasicParsing https://docs.sydekyks.com/resources/operators/install-sydekyks.ps1 -OutFile install-sydekyks.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-sydekyks.ps1
```

### macOS and Linux

```sh
curl -fsSL https://docs.sydekyks.com/resources/operators/install-sydekyks.sh -o install-sydekyks.sh && sh install-sydekyks.sh
```

The installer generates private secrets and starts the Sydekyks app and worker together, with PostgreSQL and Redis. The first run can take several minutes. When it reports **Sydekyks is running**, open **[http://localhost:8080](http://localhost:8080)** and create your first administrator account.

Your configuration is saved in `sydekyks/deployment`; your data is kept in Docker volumes. Rerun from the same parent folder to reuse your settings, secrets and data. Keep your `.env` file and volumes for backups and upgrades.

The quick start and repository setup use `ibassoftware/sydekyks:1.0.8`, available for Linux AMD64 and ARM64. Existing installations keep their selected version until you explicitly upgrade.

See the [installation guide](https://docs.sydekyks.com/install/options/docker-compose/) for server access, HTTPS, email, maintenance and troubleshooting.

<details>
<summary>Install release 1.0.8 from a repository checkout</summary>

From the repository root, use a macOS/Linux terminal or Bash with OpenSSL installed:

```sh
bash tools/deploy.sh
docker compose config --quiet
docker compose up -d --wait
```

This generates a private `.env` from the repository's `.env.example` and starts `ibassoftware/sydekyks:1.0.8`. If a `.env` already exists, `tools/deploy.sh` preserves it and exits; review it, then run the two Docker Compose commands directly. Open [http://localhost:8080](http://localhost:8080).

Review your private `.env` before deploying to a server. Keep the encryption key and database volumes when upgrading an existing installation.

</details>

## Upgrade an existing installation

Read the [release log](https://www.sydekyks.com/releases/#v1.0.8), pause incoming and scheduled work, and follow the [backup procedure](https://docs.sydekyks.com/install/configure-operate/rollback/) before upgrading. Keep the original installation folder, Compose project, volumes and encryption/JWT keys. Do not rerun `tools/deploy.sh` or replace your environment file.

Change only `SYDEKYKS_IMAGE` in your existing `deployment/.env` (downloadable quick start) or `.env` (repository checkout):

```text
SYDEKYKS_IMAGE=ibassoftware/sydekyks:1.0.8
```

Both command blocks below work in Windows PowerShell and macOS/Linux terminals. Run each step only after the previous one succeeds.

<details open>
<summary>Upgrade a downloadable quick-start installation</summary>

From your existing `sydekyks` folder:

```sh
docker compose --env-file deployment/.env -f deployment/compose.yaml config --quiet
docker compose --env-file deployment/.env -f deployment/compose.yaml pull app
docker compose --env-file deployment/.env -f deployment/compose.yaml stop app
docker compose --env-file deployment/.env -f deployment/compose.yaml up -d --no-deps --wait --wait-timeout 300 app
docker compose --env-file deployment/.env -f deployment/compose.yaml ps
```

</details>

<details>
<summary>Upgrade a repository checkout installation</summary>

From the repository root:

```sh
docker compose config --quiet
docker compose pull app
docker compose stop app
docker compose up -d --no-deps --wait --wait-timeout 300 app
docker compose ps
```

</details>

These commands replace the app and its included worker, preserving PostgreSQL, Redis and application volumes. Wait for health checks, sign in with your existing account, check saved data and Connected Accounts, and run a harmless Mission before resuming work.

Do not use `docker compose down --volumes`. If an upgrade fails after migrations, changing the image back alone may be unsafe; use the matching pre-upgrade data, image, files and keys from your rehearsed recovery plan. See the [complete upgrade guide](https://docs.sydekyks.com/install/reference/breaking-changes/).

## Documentation

Visit [docs.sydekyks.com](https://docs.sydekyks.com) for setup instructions and product guides.

## Hosting and support

Self-hosting is free. Optional managed hosting and support, including workflow implementation, are available through [Sydekyks](https://www.sydekyks.com).

Authorized partners may provide hosting and support under their written partner agreements. Installation, customization, training, and support on customer-owned infrastructure are permitted. Competing hosting and software resale of code covered by the Sustainable Use License require written authorization.

Connected services and AI providers may charge their own fees.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and validation commands. Build the application image with `Dockerfile.release`; this rebuilds the API, worker, engine and web application and checks the distribution boundary.

See [Docker release automation](docs/docker-releases.md) for the GitHub Actions publishing workflow, release triggers, and required registry secrets.

## Licensing and attribution

Sydekyks builds on Activepieces and other third-party components. Upstream copyright and license notices are retained.

The [Sydekyks Sustainable Use License](LICENSE.sydekyks.txt) keeps every available feature free for personal use and internal business self-hosting, with restrictions on competing hosting and software resale. There is no separate paid feature edition or activation requirement.

The existing MIT source baseline and published `1.0.6` image retain their original permissions, including commercial hosting and redistribution. The new restrictions apply to future covered contributions; this change adds no new functional application code. Read [license scope and transition](LICENSE_SCOPE.md) before relying on those restrictions.

See [LICENSE](LICENSE), [LICENSE.activepieces.txt](LICENSE.activepieces.txt), and [NOTICE.sydekyks.txt](NOTICE.sydekyks.txt) for all applicable licensing and attribution notices.
