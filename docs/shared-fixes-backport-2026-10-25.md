# Shared fixes backport — 25 October 2026

Branch: `codex/main-shared-fixes-20261025`, based on main `8ccf792a42be1be3087749221ac2dc798c88a36b`.

This branch selectively extracts shared fixes from the SaaS development branch. It does not merge that branch or add hosted billing, paid admission, managed provider credentials, tenant programmes or hosted database migrations. Standard self-hosted model/connection configuration and public webhook authentication behavior remain in place. Production is not changed.

## Included changes

| Item | Shared behavior | Source commits |
| --- | --- | --- |
| B01 | Unknown API routes preserve 404; registered routes still enforce authorization | `1afadc7ec15` |
| B02 | Bearer credentials are restricted to the configured API origin and path boundary | `46cea94f26f` (selected helper only) |
| B03 | MCP registration avoids the metadata/queue-recovery initialization cycle | `5e9f495eadf` (production imports only) |
| B04 | Engine DNS overloads, connection-type narrowing, scoped flow summaries and stream typing | `77fc652a92a` |
| B05 | Agent save acknowledgements, stable JSONB comparisons and cache/conflict guards preserve edits | `f9c98b84e52`, `9be635bb435` |
| B06 | Unified Agent configuration, name/sharing controls, Publish & test and mobile history | `f9c98b84e52`, `9be635bb435` |
| B07 | Local first-message chat titles and visible manual rename, with generic session guards | `9944fb3b379` |
| B08 | Mobile sidebar trigger/focus behavior and distinguishable project names | `f92be6db01b`, plus the missing production trigger identified during review |
| B09 | Reject unsupported router edits without writing; validate conditions and verify branch-editor persistence | New shared regression fix |

The webhook body memoization fix is already on main. Hosted transport, provider masking, Credit accounting and draft-webhook admission changes were deliberately excluded. The public password-reset and form-upload-to-private-AI adapter gaps are not completed by this backport.

## Verification

The verification uses the backport checkout's source. Existing installed dependency directories are reused locally, while source aliases and bundle input inventories point to this checkout. No dependency manifests or lockfiles are changed.

- Agent regressions: 91 tests across 11 suites passed.
- Chat rename, project labels/collection, sidebar focus and API credential-boundary regressions: 36 tests passed. The actual mobile PlatformLayout consumer adds 4 passing regressions.
- Engine DNS/SSRF regressions: 48 tests passed, including numeric family overloads and private-address rejection.
- Engine scoped flow-context regressions: 3 tests passed.
- API not-found and conversation-title unit regressions: 4 tests passed.
- Conversation-storage integration suite: 14 tests passed against a separate migrated PostgreSQL database, including ownership restrictions, persistence and schema drift.
- Worker first-turn/tool execution and failure regressions: 38 tests passed, including no title-generation model call or title event. Worker TypeScript checks passed.
- Distribution boundary audit passed; its 5 fixture tests passed.
- Web application and engine library TypeScript checks passed; frontend production build and engine build passed.
- The full frontend suite passed: 183 files, 1,602 tests. Obsolete fixtures now target the actual sidebar, SSO dialogs and current main behavior. No tests were skipped. The SSO replacement verifies current supported behavior; it does not establish last-working-auth-method or Google-credential safety guards absent from inherited main source.
- Full frontend application and spec TypeScript checks passed. SSO mocks use the redacted public configuration shape rather than exposing supplier/identity-provider secrets.
- Full lint passed all 36 tasks, with existing warnings and no errors.
- The release API gate passed all 24 files / 194 tests against an isolated migrated PostgreSQL database and Redis, with no failed, pending or todo tests. Schema validation reported no drift.
- Worker regressions passed 315 tests; provider utility regressions passed 92; engine regressions passed 84. Shared request and skill contracts, free access and piece compatibility also passed.
- Router draft/validation regressions passed 27 tests. Empty router conditions fail validation, incomplete drafts remain editable, unsupported generic edits fail before a write, and the dedicated branch editor persists real conditions.
- The pinned Node 24 / Bun 1.4 release build covers web, API, worker and engine. GitHub validation on the final PR head is required before merging.

Reproducible focused commands from repository root:

```sh
node node_modules/vitest/vitest.mjs run --config packages/server/api/vitest.config.ts packages/server/api/test/unit/authorization-not-found.test.ts packages/server/api/test/unit/conversation-title.test.ts --maxWorkers 1
node node_modules/vitest/vitest.mjs run --config packages/server/engine/vitest.config.ts packages/server/engine/test/network/ssrf-guard.test.ts packages/server/engine/test/piece-context/flows-context.test.ts --maxWorkers 1
node node_modules/vitest/vitest.mjs run --config packages/web/vitest.config.ts packages/web/test/app/routes/agents packages/web/test/app/routes/chat-with-ai/conversation-list.test.tsx packages/web/src/components/ui/sidebar-focus.test.tsx packages/web/src/features/projects/lib/project-label.test.ts packages/web/src/features/projects/stores/projects-collection.test.ts packages/web/test/lib/api-credential-boundary.test.ts
node node_modules/typescript/bin/tsc --noEmit -p packages/web/tsconfig.app.json
node node_modules/typescript/bin/tsc --noEmit -p packages/server/engine/tsconfig.lib.json
node scripts/audit-distribution-boundaries.mjs .
node scripts/audit-distribution-boundaries.test.mjs
node packages/server/engine/esbuild.config.mjs
```

The integration suite needs an isolated PostgreSQL database initialized with the release schema. It must not be run against production or a populated rehearsal database.

## Self-hosted runtime and review

A fresh Community Edition/prod-mode source runtime passed real PostgreSQL migrations, queue migration/startup, sign-in and API authorization checks. It uses a new database and a previously empty Redis database in existing local test containers, with unique config/cache directories and disposable credentials. That initial runtime reused isolated local services. The later complete CI gate used two dedicated, labelled PostgreSQL/Redis containers with tmpfs storage; unrelated services and volumes were preserved.

Agent create → edit → publish and chat rename/readback passed against actual API endpoints. Browser review uses a local deterministic CUSTOM provider; this tests application behavior without using real supplier credentials or representing a live-provider certification.

Astra identified a missing mobile platform-menu opener in the first browser pass. The reusable sidebar test alone did not prove the platform layout exposed it. Commit `abee68b6941` mounts the real trigger and closes the drawer on navigation/viewport changes. The rebuilt 390px browser check passed: Enter opens the menu, Escape restores trigger focus, selecting Users closes the drawer, and Back to app is available.

Private local harnesses, credentials, screenshots and logs are kept outside Git under the workspace's ignored `output/private/main-backport-20261025/`. Source commits use directly run validation because this new worktree lacks the generated `.husky/_/husky.sh` helper.

## Final review status

The mobile navigation issue found during browser QA is fixed and verified. The end-to-end test also exposed a legacy worker title-generation call that overwrote API/user titles; commit `84a0259f531` removes that extra call, ignores legacy title fields during transcript persistence and drops legacy title events while preserving normal chunk/completion forwarding. First-turn/tool and real PostgreSQL regressions pass. Astra independently reviewed this completion fix and confirmed it in the rebuilt browser. The local title appeared on admission; a rename while the response was held survived completion and full refresh, using one model request and no title-generation request.

A published native Agent also completed cold MCP discovery → tool call → answer, with both response and local title preserved after reload. It used two normal model steps around the tool call, with no title request. The MCP client separately discovered 45 schemas and successfully listed workflows. Duplicate Command Center labels were also verified in the browser.

No remaining blocking finding was reported at `84a0259f531`. Production, main, the SaaS source branch and rehearsal data were untouched. The later full CI gate used disposable, owned tmpfs services, without changing rehearsal or unrelated databases. The temporary source API/worker/provider services are stopped after QA; private test data and evidence are preserved.

During the initial worker replacement, an existing stale long-poll connection briefly delayed the original CHAT job. Normal recovery completed the same job/run without replay or duplicate provider dispatch. The relevant runtime files were verified identical to main; that broader worker-disconnect race is not changed here.

The final fixture, router and error-handling review reported no blocking findings. Router core contracts are included in the PR workflow and the API gate manifest. GitHub PR status is the source of truth for publication and merge; merge requires successful validation on the reviewed final head. This PR does not deploy, publish a release image, bump a version or modify SaaS billing/provider controls.

The separately investigated hosted chat failure and hosted branch-tool allowlist fixes live on `codex/saas-router-budget-fixes-20261025`, outside this main PR. Production runs, pending work, supplier holds and balances remain unchanged.
