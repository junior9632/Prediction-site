# API-Football connection and API Management repair

Reviewed against the official v3 documentation on **2026-10-16**.

## What changed

- **Correct response contract:** `/status` returns an object in `response`, not a fixture-style array. Both that documented object and older array-shaped test/adaptor responses are supported. The dashboard reads the actual plan, quota, HTTP status and latency.
- **Correct endpoint parameters:** batch fixture refresh uses `ids=1-2-3` (maximum 20). Odds accepts one integer `fixture`, never a joined string. Odds requests select full-time Goals Over/Under (`bet=5`); only real Over 1.5 prices are eligible.
- **Network reliability:** a provider-only Undici dispatcher enables automatic IPv6/IPv4 fallback on supported Node versions. No global DNS change, insecure TLS setting, proxy bypass, or fabricated fallback data. Secret-bearing requests do not follow redirects.
- **Configuration normalization:** approved host URLs, version paths, trailing slashes and surrounding quotes are normalized. Bad hosts/keys fail as configuration errors before an upstream request, rather than looking like a network outage. Direct API-Sports and RapidAPI keys must still match their issuing host.
- **Useful failure diagnosis:** Node's nested fetch causes are classified into safe DNS, connection, TLS and timeout codes. API Management, logs and `npm run api:check` retain the diagnosis and next step, without credentials or raw headers.
- **Honest provider errors:** HTTP 200 with nonempty `errors` is a failure, not a successful zero-fixture sync. Authentication, request/season restrictions, inactive subscriptions, daily quota and per-minute rate limits remain distinct. Malformed payloads are not data.
- **Recovery:** a genuine explicit connection test bypasses stale response cache and can verify recovery from an open circuit. Daily quota expires at the next UTC day; fresh positive quota after a plan upgrade clears an old exhaustion. Refreshing the credential does not overwrite an advertised lower per-minute limit. Retry-After is not shortened to 15 seconds, and single-call tests do not sleep/retry after failure.
- **Credential lifecycle:** database-managed credentials work after restart without requiring an environment API key. Credentials are resolved before availability checks. Unknown live quota is checked with `/status` before a real background client reuses an older sync budget that might belong to another key.
- **Dashboard workflow:** Test before Save keeps the typed key/host in the form; Save clears the field only after success. Feedback survives a refresh. Actions are mutually disabled while busy, unsaved navigation warns, and stale responses cannot overwrite a different view.
- **Correct diagnostics ownership:** only matching key fingerprint **and** host can update a saved credential's verdict. A conditional SQL update protects key rotation during an in-flight test. Identical concurrent tests share one request; conflicting tests are throttled. Test and Refresh share the reuse window. Environment-only test results remain visible for the current process.
- **Current state:** Refresh persists failures as well as successes and rereads status after the probe. Successful checks clear obsolete error fields. Replacing a key clears the old key's diagnostics. The rules card uses saved settings, not hard-coded environment defaults.

## HTTP 403 “You are not subscribed” and unclickable controls (2026-10-19)

This explicit provider message is now reported as **API subscription required or inactive**
(`SUBSCRIPTION_INACTIVE`), not as proof that the key is invalid. HTTP status and the original
provider message are preserved. Generic invalid-key/unauthorized responses are still authentication
failures; subscription failures are not retried automatically and keys are never tried on a different host.

- For a **RapidAPI** key, open the selected host's **Manage API account / subscription** link and
  subscribe to API-Football using the same account/application that issued that key.
- For an **API-Sports dashboard** key, select the direct host, test, save, then activate it. A direct
  subscription and a marketplace subscription are separate; changing a host does not transfer either.
- After correcting the account, retry **Test connection**. Failed verdicts are reused only for the
  short anti-hammering interval (default three seconds), rather than hiding the repair behind the
  successful-test reuse window (default 60 seconds). Successful tests still share/reuse a single probe.
- API Management browser requests, including the follow-up status read, stop waiting after 45 seconds.
  Controls unlock on success, failure or timeout, and an unsaved key/host draft is retained. After Test
  answers, the read-only status refresh runs in the background without locking the form; late reads
  cannot overwrite a newer action. A timed-out write may still finish on the server: check status
  before resubmitting it.
- Save/Activate/Disable no longer silently grey out for missing prerequisites. Clicking explains
  what must be fixed. Unavailable encrypted storage **still blocks saving**, and activation **still
  requires a saved credential**. Controls remain disabled during an in-flight request to prevent
  duplicate actions. Test remains independent of storage.

This change cannot grant an API subscription or validate/replace a production key. Correct the
provider account/key pairing in the protected admin page, never in chat or a public source file.

## Safe dashboard workflow

1. Open **Admin → API Management**.
2. Select the host that issued your key:
   - API-Sports dashboard key: `v3.football.api-sports.io`.
   - RapidAPI marketplace key: `api-football-v1.p.rapidapi.com/v3`.
3. Paste the key **in that protected page**, not chat, a public file, a screenshot, or a support ticket.
4. Click **Test connection**. Read the verdict, HTTP status, quota and next-step text. A reused result is explicitly labelled; it is not another provider call.
5. Click **Save configuration**, then **Activate provider**. Saving a new inactive credential does not activate it. **Replacing an already-active credential takes effect immediately** and requires confirmation in the UI.
6. Use **Refresh API status** to check the *active* credential. Test uses the form's candidate/saved credential; Refresh does not test an unsaved draft.
7. Sync the selected UTC date in Fixtures, check verified odds, then generate manually only when the real data qualifies.

**Disable saved credential** leaves its encrypted record intact and falls back to the environment credential, if configured. It is not a global outbound-API off switch. A successful credential test does not guarantee coverage for every season, fixture or bookmaker.

## If “the server could not reach the provider” remains

Deploy first, then read the **new** Test/Refresh result or run on the hosting server:

```sh
npm run api:check
# Safe structured output (never includes the full key):
npm run api:check -- --json
```

| Diagnosis | Action |
| --- | --- |
| `CONFIG_INVALID` | Fix the key/approved host pairing; do not put an endpoint path such as `/fixtures` in the host. |
| `ENOTFOUND` / `EAI_AGAIN` | Have the host check DNS resolution for the chosen provider. |
| `ENETUNREACH` / `EHOSTUNREACH` | Allow outbound HTTPS on port 443. Automatic family fallback is enabled; on confirmed IPv4-only hosting, set `API_FOOTBALL_IP_FAMILY=4` and restart. |
| `ECONNREFUSED` / `ECONNRESET` | Ask the host/provider to check outbound firewall rules and shared-IP restrictions. Repeated blind retries can worsen a provider block. |
| Certificate / TLS error | Repair the CA trust store, clock or certificate chain. **Never disable TLS verification.** |
| `TIMEOUT` | Check routing/provider availability; adjust `API_FOOTBALL_TIMEOUT_MS` only if appropriate. |
| `AUTH_REJECTED` / `INVALID_KEY` | Use the key issued for the selected host; check revocation/account restrictions. |
| `SUBSCRIPTION_INACTIVE` | For “not subscribed”, subscribe to API-Football on the issuing RapidAPI account/app; for an expired plan, renew in its dashboard. API-Sports keys must use the direct host. |
| `REQUEST_REJECTED` | Read the provider's parameter/season/plan message. Do not replace missing data with guesses. |
| `QUOTA_EXCEEDED` / `RATE_LIMITED` | Wait for the advertised reset/backoff; reduce request frequency/range or change the plan. |

A hosting firewall, broken DNS, expired provider subscription or invalid production key cannot be repaired by changing a label. The application now reports these conditions honestly. `/api/health` is not a live probe: `available` means the local client permits a call; `verified` and `lastCheckedAt` describe the last observed provider result.

## Deploy without losing configuration

1. Back up the application/database and **preserve `.env`, `storage/`, and the encryption master key/key file**. Do not overwrite production secrets with example or preview values.
2. Upload/extract the rebuilt `GoalPredict-cPanel-deployment.zip` over the application files.
3. Run `npm ci` (or cPanel's **Run NPM Install**) to install the lockfile, including the Node 18.17-compatible Undici 6 dependency.
4. Run `npm run db:migrate` if the live database is behind. This repair adds **no new migration**; API Management still requires migration `003-api-credential-management.sql`.
5. Restart the Node/Passenger application. Reload the admin page so the versioned scripts update.
6. Perform the protected dashboard workflow above. Do not assume the preview or a green liveness endpoint proves production provider access.

## Verification boundaries

Automated tests cover official payload shapes, request/auth headers, native fetch/dispatcher integration, local IPv6-to-IPv4 failover, safe diagnostics/redaction, quota recovery, credential identity races, protected HTTP actions and frontend interactions. Browser checks use the fictional preview data only. They do **not** establish production DNS/firewall reachability, validate a production key, or replace a real MySQL/provider integration check.

No production credential, plan, firewall, database or configuration was changed by this repair. Real-data-only prices, Over 1.5, manual generation, odds bounds and full-time settlement remain enforced.

## References

- [1](https://www.api-football.com/documentation-v3) — authentication, `/status` object, fixture `ids` limit, odds parameters and pagination.
- [2](https://www.api-football.com/news/post/how-ratelimit-works) — daily/minute headers, backoff guidance and shared-IP/firewall risks.
- [3](https://www.api-football.com/news/post/how-to-get-started-with-api-football-the-complete-beginners-guide) — response envelope, errors, coverage and request patterns.
