# Upstream integration — 29 October 2026

This integration starts from updated main `592ac91c3de7fc5303828538bafb3d9782253377` and imports the applicable upstream delta from `8ee9d9677b91b13b1f8d8c08ed7967df7b7d4965` through `bfc310001ca4de3efe2e15d4ad827b8593dc2b14` (172 commits). SaaS starts at `5c76c635e1f8d2b85ff848fbf1d5bdcea8de27e3`.

The fork intentionally has separate Git ancestry. As in the 21 October sync, this is a three-way source integration onto existing Sydekyks history, followed by a normal merge of the integrated main into the SaaS branch. Published history is not rewritten and excluded upstream Enterprise sources and vendor deployment workflows are not restored.

## Conflict and preservation inventory

- `main-conflicts.json`: all 58 upstream-to-main index conflicts, resolution decisions and follow-up assertions.
- `preservation-decisions.json`: files retained for independently implemented licensing, authentication, membership, worker routing, provider behavior, SDK compatibility and billing. Later compilation repairs keep dependent contracts aligned.
- `excluded-paths.json`: filtered upstream paths, including pre-existing distribution exclusions and explicit macOS case-only renames. The EmailOctopus renames were applied manually; they are not omitted integrations.
- `saas-conflicts.json`: populated during the main-to-SaaS merge, including the final handling of hosted overrides.
- `validation.json`: actual checks completed and outstanding validation. A merge is not production deployment or certification of every connector.

The immutable Node image is updated to 24.22.1; Sydekyks packaging, image destinations and existing application version are retained. The upstream webhook sanitizer is applied at the controller and Gadget layers. Locked external Gadget versions require an explicit version update to obtain Gadget-only fixes; the controller protects old webhook versions too. Keep the hosted reviewed AI/manual-trigger/MCP-client Gadgets pinned until independently reviewed.

## Required follow-up acceptance

1. Run the source and built-artifact distribution audits; frozen dependency install and API/worker/engine/frontend builds; non-piece lint; meaningful tests for changed Gadgets (especially GitHub optional privacy and other tri-state updates).
2. Re-run builder save/publish/discard/reconnect tests and a multi-tab browser journey. Confirm Copilot updates remount the open step, preserve pending edits and do not publish stale input. Inspect History output Friendly/Raw/paged preview, scoped downloads and mobile controls.
3. Exercise worker disconnect races, server-side fan-out, cancellation and parent/child retries against disposable PostgreSQL/Redis. Verify each child follows normal hosted admission, no duplicate dispatch or charge, and correct barrier settlement on failures.
4. Run the complete API release/authorization regression manifest and fresh-install/upgrade/background-migration checks against isolated data. Do not use production or rehearsal databases. Preserve initial schema identities and require zero metadata drift.
5. On SaaS, verify managed/BYOK isolation, funded reservations, unknown-outcome holds, integer ledger units, 1,048,576-token context, bounded 16 MiB transport, 20 workspace executions, 20/20/20 worker lanes, manual provisioning and client-only billing. Review all SaaS conflicts individually.
6. Browser-check the established Sydekyks branding, client/Partner/Trainer/Learner access and connector selection. Test real supplier behavior only with explicit task authorization. No historical failed run should be replayed as a test.
7. Before any deployment, perform the existing backup/isolated-restore, protected-row and queue-preservation process. This source merge neither publishes an image nor deploys it.

## SaaS integration decisions

The main-to-SaaS merge has **40 Git-conflicted paths**, listed exactly in `saas-conflict-paths.json`. `saas-conflicts.json` records each conflict plus additional preservation decisions and tests. `wasGitConflict` distinguishes explicit Git conflicts from semantic adaptations of cleanly merged files.

The hosted native AI/manual-trigger/MCP-client Gadgets retain their reviewed accounting and provider contracts. The upstream v28 model-picker rewrite and server-side background fan-out are deferred on this branch: the former targets different saved Gadget fields; the latter does not provide the authenticated parent provenance required by hosted execution admission. Existing hosted batch/checkpoint behavior stays in place. Self-hosted main includes the applicable upstream implementations.

Hosted worker dispatch retains its pre-existing lifetime AbortSignal cancellation, admission IDs, authenticated RPC and 20/20/20 lanes. Added reconnect regressions exercise that API rather than replacing it with the upstream socket-only interface. Hosted palette generation and CSS remain aligned. The complete `hosting/` production source subtree is compared with the pre-merge SaaS reference; no business-policy change is intended by this integration.

## Completed local checks and next-agent entry point

Main: 19 production build tasks, frontend type-check, 36 non-piece lint tasks and 995 distinct selected assertions passed. SaaS: 19 build tasks, frontend type-check, 36 lint tasks, 499 frontend assertions, 392 worker assertions, 780 API assertions and five distribution assertions passed across the broad runs and affected-file reruns; four pre-existing API tests remain skipped. The API suite uses documented test settings, in-memory migration-backed database fixtures and synthetic supplier/Stripe clients. Full PostgreSQL/Redis races, browser acceptance and image/deployment checks remain open in `validation.json`.

Start with the 58-entry `main-conflicts.json`, the exact 40-path `saas-conflict-paths.json`, and each `saas-conflicts.json` follow-up. Use `.github/workflows/validate.yml` for executable baseline commands. Enable the documented `.env.tests.example` settings before API tests so PGlite stays in memory; give any additional test config a new private path. Do not point test runs at rehearsal or production data. Run the full release API manifest with the disposable PostgreSQL/Redis setup and `tools/prepare-release-test-db.cjs` / `tools/run-release-api-regressions.cjs`; inspect their isolation requirements before execution.

Old assertions for the public catalogue predated the already-deployed 28 October offers. Those fixtures now expect 30,000/120,000/400,000 ledger units, while explicit custom allowances and historical funded-term checks retain their original values. This changes tests only. The complete hosted accounting source subtree is unchanged from the pre-merge SaaS commit.

Main was published through PR #17 as `101eb4a606821b3c61e5fbe9abe68c9aabeb0351`. The final published-main ancestry merge into SaaS had zero additional conflicts and changed no production source. GitHub validation was still running when the source merge was recorded; inspect the live PR/Actions status before release.

PR #18 follow-up: see [pr18-merge-conflicts.json](pr18-merge-conflicts.json) for five Git conflicts and the semantic worker-fixture preservation decision, and [followup.md](followup.md) for validation and hosted acceptance.
