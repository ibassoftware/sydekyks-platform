# Local follow-up — 31 October 2026

These changes are local only. The founder requires a new explicit instruction before any push, merge, package publication, or hosted deployment. Existing hosted source 50602655996 remains the live baseline; prior CI receipts validate that baseline only.

## Changes

- Reset links are checked before displaying a password input. Missing, malformed, expired, used and credential-revoked links show a clear recovery message and a link to request another email. A valid preflight does not consume the code; failed guesses use the existing redemption budget. Actual reset still checks and consumes the code atomically under its existing lock.
- Learning and training entry points are hidden from hosted global/account navigation. Learning records, direct routes and existing agreements remain intact. Ask Syd is removed from the main navigation; Sydekyks uses the existing Syd icon. Default landing routes prefer Sydekyks when capability and read permission allow it, preserving permission-based fallbacks.
- Gmail Find Email supports explicit Gmail queries and continuation tokens, exposes the applied search and page-count scope, and retains Gmail label IDs/read status. Missing label metadata produces unknown status, not a read assertion. Get Label describes the appropriate unread count fields. Configured Gadget input extraction includes the action's semantics and forbids invented optional filters.

## Validation and publication gates

49 targeted local tests cover reset UI/privacy, landing permissions, hosted navigation, non-consuming OTP preflight and shared failed-guess budgets, plus Gmail scope/read-status/pagination and configured Gadget regression contracts. Scoped lint and syntax checks are recorded privately; no full local build or production supplier call is used. Full PostgreSQL/Redis integration, type checks and full CI remain release gates before publication. The new tests are wired into the validation workflow.

Gmail source changes have not been packaged or published. A later approved release must version and publish the changed Gmail package, verify its served metadata, and explicitly review the two configured Gmail tools' pinned versions before claiming the existing hosted Sydekyk uses the new properties. Do not silently rewrite saved tools or rerun the old conversation.

Shared changes are prepared on the existing local main candidate branch; hosted-only navigation changes remain in the SaaS checkout. No remote PR or branch is updated by this local work.
