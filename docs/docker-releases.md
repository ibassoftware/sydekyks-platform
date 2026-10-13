# Docker releases with GitHub Actions

The private platform repository validates every pull request and push to `main`.
The **Release Docker image** workflow publishes binaries to the existing public
Docker Hub repository, `ibassoftware/sydekyks`. Source remains private.

To publish a release, push a stable version tag on a commit from `main`:

```sh
git tag v1.0.7
git push origin v1.0.7
```

Alternatively, run **Release Docker image** from the GitHub Actions interface,
select `main`, and enter a stable version such as `1.0.7`. Published version tags
are not overwritten. Future releases should increment the platform version in
`package.json` as well as selecting a new public image version.

The workflow runs the complete platform validation, then builds independently on
native AMD64 and ARM64 runners. Each image must pass disposable PostgreSQL/Redis
tests for a fresh installation and an upgrade from the pinned 1.0.6 release.
Checks cover community edition, owner bootstrap and login, a saved Mission,
closed registration, image provenance and license notices, and the branded
Gadget registry request. No provider keys or live business data are used.

Only successful candidates are pushed. Both architectures must pass before the
version tag and `latest` are published. The run summary and `published-release`
artifact record the image digest. Installations should pin that digest.

The repository requires encrypted Actions secrets `DOCKERHUB_USERNAME` and
`DOCKERHUB_TOKEN`; the token must have write access to the image repository.
Credentials are only used after validation and smoke tests. A publishing failure
can be rerun before the version has been promoted. If the version was published
but updating `latest` failed, inspect the published digest and promote it rather
than rebuilding or overwriting the released version.

This workflow publishes images; server upgrades remain a separate operation.
Back up the target database and preserve its encryption/JWT keys before upgrading.
The release workflow has no server SSH credentials or deployment access.
