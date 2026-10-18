# Frontend error diagnosis and regression coverage

## Observed failure

The local Central was reached through an HTTPS reverse proxy while its private
profile had an empty `server.publicUrl`. Authentication correctly returned
`403 origin_denied`. The Web login dialog replaced every 403 with “Upgrade the
central node before signing in.” The node already supported the current protocol.

The operator-authorized local configuration repair sets the actual public origin
and restarts the selected dev profile. It is an ignored deployment configuration,
not a repository change. An empty JSON request through the public HTTPS endpoint
then reached request validation (`400 invalid_request`) instead of origin denial.
This probe does not verify a user's password, Cookie storage or full browser login.

## Audit and handling

The audit follows the shared Web request renderer and public authentication path,
page-specific status overrides, configuration editors, query/file/archive failures,
software update status, desktop login/pairing transport, Android central transport,
record reading and release downloads. It does not promise a localized description
for every internal or future provider code; unknown validated codes remain visible
for diagnosis without interpreting raw provider text.

| Evidence | Previous misleading behavior | Current presentation |
| --- | --- | --- |
| `origin_denied`, 403 | Upgrade required | Check public origin and reverse proxy |
| `invalid_login`, 401 | Every login-stage 401 blamed the password | Password advice only for this code; failed session discovery reports an unverified session, and actual identity changes remain distinct |
| `invalid_identity`, 401/403 | Missing/unlocalized reason; Android did not retire the rejected Central identity | Expired credential or denied permission according to HTTP context; external-provider 401 keeps Central login |
| `session_changed`, 409 | Configuration changed by another editor | Sign in again; draft remains intact |
| `config_conflict`, 409 | Assumed another session modified the file | Configuration or related operation state changed; reload before confirming |
| `invalid_cursor` | Every browsing 409 treated as pagination change | Restart pagination only for the cursor reason |
| `incompatible_protocol`, 426 | Generic HTTP failure | Explain incompatible client/Central protocols without guessing which component is older |
| `login_throttled` / `login_busy`, 429 | Raw code or generic failure | Distinguish repeated attempts from concurrent login capacity |
| Proxy HTML / uncoded JSON message | Public auth defaulted to unauthorized; other paths could render raw text | Localized HTTP fallback; do not display response bodies |
| External work outcome / file processing / archive / conversation state | Technical code without recovery context | Authored advice for the explicit state; do not suggest blindly repeating uncertain work |
| Update download 403 | Always GitHub throttling | Access denied unless rate-limit headers establish throttling; 429 remains throttling |
| Update check result | Raw server error string | Localized release code or safe unknown-code fallback |
| Record-read 404 | Suggested unsupported old Central | Missing endpoint/resource; no version inference |
| Pairing 400/409/410 | Assumed invitation expiry or an existing device | Preserve explicit device, expired invitation and invitation mismatch reasons; unknown conflicts do not guess device ownership |

No authentication origin allowlist, protocol version, retention, data collection,
operation admission or retry policy is relaxed by these presentation changes.
The Android Central transport now recognizes the current invalid-identity codes
when retiring a rejected Central session; provider authorization failures remain
separate. English translations and the Android catalog are synchronized.

## Validation entry points

- `packages/shared/test/http-failure.test.mjs`: malformed optional fields, reason
  precedence, distinct bilingual recovery messages and safe unknown codes.
- `packages/shared/test/release.test.mjs`: public release access refusals versus
  actual rate-limit evidence, using generated network responses.
- `apps/web/test/login-errors.test.ts`: the rendered login form's origin refusal,
  retry after failed session discovery, matching-account success, structured
  authentication refusals and proxy HTML. The DOM and accounts are generated.
- `apps/web/test/api.test.ts`: provider-code handling, correlation IDs, retry
  metadata, raw-body exclusion and transport timeout advice.
- `apps/web/test/configuration-ui.test.ts`: draft/revision retention, real
  configuration conflict codes and session change without false conflict advice.
- `apps/server/test/multiuser-auth.test.ts`: configured HTTPS origin accepted
  through an internal HTTP listener; another origin still refused. The positive
  probe reaches input validation without authenticating a real account.
- Desktop `connection.test.ts` and `login-session.test.ts`: structured connection
  and login reasons without response-body disclosure or assumed upgrades.
- Android `CentralFailureTest`: matching central reasons, private-detail exclusion,
  update access classification and Central/provider authentication separation.

The required release gate is `npm run check:affected`; shared translations select
all TypeScript consumers and Android debug unit tests. Physical devices, a real
model, a packaged desktop installation and full login with a user's password are
separate checks and are not implied by the generated fixtures.

## Executed local checks

The Node 26.11.1 aggregate `check:affected` run returned a nonzero result: the
server runner reported 2,983 passing tests, no assertion failures, two skips and
24 cancelled test files with “Promise resolution is still pending but the event
loop has already resolved.” This is not recorded as a passing aggregate run.
Every cancelled file was rerun using the CI major, Node 24.22.0: all 97 tests
passed with no cancellations. The precise cause of the aggregate Node 26
cancellation has not been established by this change.

Other completed workspace results were Desktop 599 passed, Web 598 passed,
Agent 327 passed / one optional skip, diagnostics five passed, and shared 198
passed. Translation validation and all workspace type checks passed. Android
debug unit tests passed 366 cases with no skips. The separate root/release/media
batch passed 83 cases, CLI passed five, and the generated central supervisor
checks passed. The media-worker fixture now writes its argument snapshot before
publishing the startup marker consumed by the parent, removing a file-readiness
race encountered during validation.

Independent Central/Web and macOS Desktop builds passed, including the Swift
helper/updater compilation and a pinned SQLite binding check. Generated DOM
checks cover the actual login-dialog error/retry transitions; they do not prove
Cookie behavior in the user's live browser. GitHub CI results belong to the PR;
the local cancellation and its successful narrower rerun are reported separately.
