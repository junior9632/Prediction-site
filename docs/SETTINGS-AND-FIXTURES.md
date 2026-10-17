# Admin settings & fixtures — 2026-10-16 repair

This change repairs the repository and the cPanel upload package. It does **not** authenticate to,
change settings on, or deploy to `goalpredict.windelsai.com`. The linked admin URL requires an
administrator session. No production credentials or football data were used for testing.

## What changed

### All 54 settings (50 editable, 4 locked)

- Save sends **only changed, editable fields**. Locked product rules are no longer posted on
  every save, eliminating the permanent “rejected locked settings” warning.
- Toggle tracks no longer intercept touches/clicks. Toggles have associated labels and visible
  keyboard focus. Numeric counts use whole-number controls; decimals retain their precision.
- Empty/null numeric inputs, fractional counts, unrecognised booleans, invalid timezones,
  malformed league IDs, overlong text, and invalid scoring JSON are rejected explicitly.
  JSON objects are stored as JSON, not the string `[object Object]`.
- Scoring JSON accepts known numeric components only, with nonnegative bounds and a nonzero
  effective weight total. Partial objects retain the engine's documented defaults for omitted keys.
- Cross-field validation covers odds/selection ranges, candidate-pool capacity, form windows and
  nonzero model weights. Validation uses the **locked current database rows**, then the accepted
  subset is upserted in one transaction. Missing/new settings are inserted correctly; failed
  transactions do not leave a half-saved range.
- Invalid legacy rows fall back to the same safe defaults in the editor and engine. The editor
  flags them for repair. Locked values always display the code-enforced values, even if someone
  tampered with the database.
- Save failures preserve drafts; rejected fields show their own errors; double submissions are
  blocked. Discard, unsaved-change warnings and hash navigation work without late responses or
  generation polling replacing the editor.
- Public branding reads `/api/meta`. Site name/tagline update the header and page title, and
  `display_timezone` controls kickoff timestamps. A date-only ticket day never shifts to the
  previous day in another timezone. The admin “Admin Console” label is not replaced by branding.

### Fixtures and synchronisation

- **Fixtures → Sync selected date** refreshes one UTC date using the existing protected sync API.
  It does not backfill the entire history or create a ticket. It still respects tracked leagues,
  enrichment settings and the request reserve.
- Search, status filters, pagination, last-sync times, meaningful empty/error states and retry
  controls let an operator inspect every stored fixture. Slow responses from an old date/view
  cannot replace newer content. Mobile tables scroll without an unrelated sticky column hiding
  match information, and the header keeps sign-out controls on-screen.
- API-Football UNIX timestamps are parsed as **seconds**. Invalid IDs/dates are skipped rather
  than inserted as corrupt fixtures. Fetch timestamps and playability use the **real current
  instant**, not the midnight date anchor used to select API calendar days.
- Playability is recomputed when fixtures are read, so an old `NS`/`is_playable=1` row is not shown
  as available after kickoff. Fixture list/detail odds use the configured freshness, price band
  and bookmaker preference, and both revalidate stored prices.
- The 90-minute score takes precedence over total goals. AET/PEN matches without a full-time
  score remain unavailable/pending; extra-time goals cannot turn a losing Over 1.5 pick into a win.
- `h2h_sync_max_calls=0` means zero requests. Failed attempts count toward the cap; larger minimum
  meeting samples are requested; H2H calls are included in sync-log call totals.
- `api_quota_reserve` is rechecked **between requests**, including fixture dates, history days,
  H2H calls, odds pages and result batches. Partially completed work is kept and reported as
  `SKIPPED / QUOTA_RESERVED`, not green success. Authentication/quota/network failures on a later
  odds page are not silently treated as the end of pagination.

## Verify after deployment

1. Upload the rebuilt `GoalPredict-cPanel-deployment.zip` following
   [the existing cPanel guide](DEPLOYMENT-CPANEL.md), preserve the host's `.env` and credential
   vault, and restart the Node application. No new schema migration is required by this repair;
   older installations must still apply the repository's existing migrations.
2. Sign in normally and open `/admin.html#settings`. Existing valid values are preserved. Review
   any repair warnings. Save a deliberate change, reload, and confirm it persists.
3. For all leagues, leave **Tracked League IDs** empty; otherwise use comma-separated positive
   API-Football IDs. Use `UTC` or an IANA zone such as `Africa/Lagos`. Do not weaken prediction
   thresholds just to force a ticket.
4. Check **API Management** for a working provider connection and available quota. Open
   **Fixtures**, choose the required UTC date, and click **Sync selected date**. Check the returned
   status and **API Status → Recent sync logs**. No fixtures may legitimately be available for a
   date/league/plan; the system never manufactures matches to fill the screen.
5. Review affected historical AET/PEN fixtures after a real data refresh. This patch does not
   rewrite already-published ticket snapshots or previously settled ticket history.
6. Ticket generation is still a separate, explicit administrator action. Over 1.5 only,
   full-time settlement and automatic generation OFF remain locked.

## Verification in this checkout

- `npm test`: server/service, real HTTP (with in-memory database/API doubles), and executed
  browser-script regression suites. All 50 editable defaults are saved and read back.
- `npm run lint:js`, `npm run lint:syntax`, `npm run test:sql`, `npm run lint:secrets`.
- `npm run build:zip` and `node scripts/build-deployment-zip.js --check` keep the upload package
  byte-for-byte aligned with source.
- Headless Chromium smoke checks at desktop and 390px mobile sizes: login back to Settings,
  touch toggles, changed-only saves, reload persistence, invalid-timezone feedback, branding,
  unsaved navigation, selected-date refresh, search and no JavaScript exceptions.
- `npm run preview:ui` runs a **fictional sample-data** preview without a production API key or
  MySQL. Preview-only iframe support does not change production CSP/frame protection.
