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

The downloadable quick start currently installs `ibassoftware/sydekyks:1.0.6`, as pinned in the [public installation template](https://docs.sydekyks.com/resources/operators/sydekyks-env.example.txt). This repository's current release is `1.0.8`; use the repository setup below to install that version. Both releases support Linux AMD64 and ARM64.

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
