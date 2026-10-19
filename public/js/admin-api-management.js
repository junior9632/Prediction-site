/* GoalPredict — admin console: API Management view (vanilla JS).
 *
 * WHAT THIS SCREEN DOES
 *   Lets an administrator configure, test and activate the football data API
 *   credential without editing any source file or environment variable.
 *
 * WHAT IT NEVER DOES
 *   * it never receives a full API key — the server only ever returns a masked
 *     form ("********abcd"), and the key typed here is sent once, over POST,
 *     to be encrypted at rest on the server;
 *   * it keeps no copy of a credential in the browser at all;
 *   * it never generates, publishes or replaces a prediction ticket. Testing a
 *     credential only asks the provider "is this key valid, and how much quota
 *     is left?".
 *
 * The provider list and the host allowlist come from the server
 * (GET /api/admin/api-management) — the browser never invents an API host.
 */
'use strict';

(function () {
  const { API, fmt, escapeHtml, icons } = App;
  const $ = (selector) => document.querySelector(selector);

  /** Filled in by admin.js when the view is opened. */
  let ui = null;
  let current = null;

  // The provider request is bounded server-side too; a stalled proxy/status
  // refresh must not leave every button and input disabled indefinitely.
  const REQUEST_OPTIONS = { timeoutMs: 45000 };

  const STATE_TONE = {
    CONNECTED: 'green',
    ENVIRONMENT: 'cyan',
    NOT_TESTED: 'amber',
    DISABLED: 'slate',
    INVALID_KEY: 'red',
    QUOTA_EXCEEDED: 'amber',
    RATE_LIMITED: 'amber',
    NETWORK_ERROR: 'red',
    TIMEOUT: 'red',
    PROVIDER_UNAVAILABLE: 'red',
    CONFIG_INCOMPLETE: 'amber',
    REQUEST_REJECTED: 'red',
    SUBSCRIPTION_INACTIVE: 'amber',
    CREDENTIAL_UNREADABLE: 'red',
    ENCRYPTION_KEY_MISSING: 'red',
  };

  function badge(state) {
    const tone = STATE_TONE[state] || 'slate';
    return `<span class="badge badge-${tone}">${escapeHtml(state)}</span>`;
  }

  function timeOrDash(value) {
    if (!value) return '<span class="muted">never</span>';
    return `${escapeHtml(fmt.dateTimeLabel(value))} <span class="tiny muted">(${escapeHtml(fmt.ago(value))})</span>`;
  }

  /* ----------------------------- markup ------------------------------ */

  function storageNotice(status) {
    const storage = status.storage;
    if (!storage) {
      // Backward-compatible payload: an older server only has degradedReason.
      return status.degradedReason
        ? '<div class="alert warn">Credential storage is unavailable. Ask the host to run npm run db:migrate and verify the database connection. Environment-based testing remains available.</div>'
        : '';
    }
    if (storage.ready && storage.state === 'READY') return '';
    const issues = (storage.issues || []).slice(0, 3)
      .map((issue) => `<li><b>${escapeHtml(issue.area)}</b>: ${escapeHtml(issue.message)}${issue.fix ? `<div class="tiny muted">${escapeHtml(issue.fix)}</div>` : ''}</li>`)
      .join('');
    const cls = storage.state === 'HISTORY_DEGRADED' ? 'warn' : 'error';
    return `<div class="alert ${cls}"><div><b>${escapeHtml(storage.summary || 'Credential storage is not ready.')}</b>
      ${issues ? `<ul class="small" style="margin:8px 0 0 18px;padding:0;">${issues}</ul>` : ''}
      <div class="tiny" style="margin-top:8px;">Credential storage and provider connectivity are separate checks: a successful Test Connection does not prove that a key can be stored.</div></div></div>`;
  }

  function hostHelp(provider, hostId) {
    const host = (provider.hosts || []).find((h) => h.id === hostId) || {};
    return `${escapeHtml(host.credentialHelp || 'Choose the host that issued your key: the direct provider and the marketplace use different credentials.')}
      ${host.accountUrl ? `<a href="${escapeHtml(host.accountUrl)}" target="_blank" rel="noopener noreferrer">Manage API account / subscription ↗</a>` : ''}`;
  }

  function configurationCard(status) {
    const providers = status.providers || [];
    const implemented = providers.filter((p) => p.implemented);
    const notImplemented = providers.filter((p) => !p.implemented);
    const selected = status.provider || (implemented[0] && implemented[0].id) || '';

    const providerOptions = implemented
      .map((p) => `<option value="${escapeHtml(p.id)}" ${p.id === selected ? 'selected' : ''}>${escapeHtml(p.label)}</option>`)
      .concat(
        notImplemented.map(
          (p) => `<option value="${escapeHtml(p.id)}" disabled>${escapeHtml(p.label)} — not available in this build</option>`
        )
      )
      .join('');

    const current = implemented.find((p) => p.id === selected) || implemented[0] || { hosts: [] };
    const hostOptions = (current.hosts || [])
      .map(
        (h) =>
          `<option value="${escapeHtml(h.id)}" ${
            h.id === configuredHost(status) ? 'selected' : ''
          }>${escapeHtml(h.label)}</option>`
      )
      .join('');

    const stored = status.credential;
    const masked = stored ? stored.maskedKey : status.environment.maskedKey || null;
    const sourceLabel = status.credentialSource === 'database'
      ? 'Saved credential (active)'
      : status.credentialSource === 'environment' ? 'Environment credential (active)' : 'No active credential';

    const notice = notImplemented.length
      ? `<p class="tiny muted" style="margin:10px 0 0;">${escapeHtml(
          notImplemented.map((p) => p.label).join(', ')
        )} are declared for future extension only: this build ships no verified client for them, so they cannot be saved or activated.</p>`
      : '';

    const encryptionNotice = status.encryption.configured
      ? ''
      : `<div class="alert warn" style="margin-top:12px;">${icons.alert}<div><b>Credential encryption is not configured.</b> ${escapeHtml(
          status.encryption.message
        )}<div class="tiny" style="margin-top:6px;">Set <code>${escapeHtml(
          status.encryption.keyEnvVar
        )}</code> in the cPanel Node.js application environment, then restart the application. Generate one with: <code>${escapeHtml(
          status.encryption.generate || ''
        )}</code></div></div></div>`;

    return ui.card(
      'API configuration',
      `<div class="card-body">
        <p class="small muted" style="margin:0 0 16px;">1. Choose your key’s host. 2. Paste and test the key. 3. Save configuration. 4. Activate the saved credential.
        ${current.docsUrl ? `<a href="${escapeHtml(current.docsUrl)}" target="_blank" rel="noopener noreferrer">Provider documentation ↗</a>` : ''}</p>
        ${storageNotice(status)}
        <div class="row wrap" style="gap:16px;align-items:flex-start;">
          <div class="field" style="min-width:0;flex:1 1 240px;">
            <label for="apiProvider">Provider</label>
            <select class="input" id="apiProvider">${providerOptions}</select>
            <div class="hint">Only providers implemented and verified in this build can be configured.</div>
          </div>
          <div class="field" style="min-width:0;flex:1 1 240px;">
            <label for="apiHost">API host</label>
            <select class="input" id="apiHost">${hostOptions}</select>
            <div class="hint" id="apiHostHelp">${hostHelp(current, configuredHost(status))}</div>
          </div>
        </div>
        <div class="field" style="margin-top:12px;">
          <label for="apiKey">API key</label>
          <input class="input" id="apiKey" type="password" autocomplete="off" spellcheck="false"
                 placeholder="Paste the new API key — it is encrypted on the server and never sent back">
          <div class="hint">Leave empty to test the saved credential. A typed key is tested without saving; it stays in this field until you save or leave the page.</div>
        </div>
        <div class="row wrap" style="margin-top:14px;gap:10px;">
          <button type="button" class="btn btn-primary" id="apiSaveBtn">${icons.check} Save configuration</button>
          <button type="button" class="btn btn-ghost" id="apiTestBtn">${icons.bolt} Test connection</button>
          <button type="button" class="btn btn-outline" id="apiActivateBtn">Activate provider</button>
          <button type="button" class="btn btn-ghost" id="apiDisableBtn">Disable saved credential</button>
          <button type="button" class="btn btn-ghost" id="apiRefreshBtn">${icons.refresh} Refresh API status</button>
        </div>
        <p class="hint" id="apiControlHint" style="margin-top:10px;"></p>
        <div class="section" id="apiActionBox" role="status" aria-live="polite" aria-atomic="true"></div>
        <div class="divider" style="margin:16px 0;"></div>
        <div class="diag-grid api-config-details">
          <div class="diag-cell"><div class="k">Credential in use</div><div class="v">${escapeHtml(sourceLabel)}</div></div>
          <div class="diag-cell"><div class="k">Saved / configured key (masked)</div><div class="v">${escapeHtml(masked || 'not saved')}</div></div>
          <div class="diag-cell"><div class="k">Host</div><div class="v">${escapeHtml((status.effectiveCredential && status.effectiveCredential.host) || status.connection.host || '—')}</div></div>
          <div class="diag-cell"><div class="k">Encryption</div><div class="v ${status.encryption.configured ? 'good' : 'warn'}">${escapeHtml(
            status.encryption.configured ? (status.encryption.pending ? 'AES-256-GCM ready (server key created on first save)' : 'AES-256-GCM ready') : 'not configured'
          )}</div></div>
        </div>
        ${notice}
        ${encryptionNotice}
        <p class="tiny muted" style="margin:12px 0 0;">
          Saving, testing or switching a credential never generates, publishes or replaces a prediction ticket.
          Tickets stay manual: ${escapeHtml(status.predictionRules.market)}, combined odds ${status.predictionRules.oddsWindow[0].toFixed(
            2
          )}–${status.predictionRules.oddsWindow[1].toFixed(2)}, confidence ${status.predictionRules.confidenceMode === 'fixed' ? 'minimum ' + status.predictionRules.minConfidence : 'auto-detected (floor ' + status.predictionRules.minConfidence + ')'}.
        </p>
      </div>`
    );
  }

  function storageCard(status) {
    const storage = status.storage;
    if (!storage) return '';
    const tone = storage.ready ? 'good' : storage.state === 'HISTORY_DEGRADED' ? 'warn' : 'warn';
    const issueRows = (storage.issues || [])
      .map((issue) => `<li><b>${escapeHtml(issue.area)}</b>: ${escapeHtml(issue.message)}${issue.fix ? `<div class="tiny muted">${escapeHtml(issue.fix)}</div>` : ''}</li>`)
      .join('');
    const permission = storage.permissions && storage.permissions.checked
      ? [storage.permissions.select ? 'SELECT' : null, storage.permissions.insert ? 'INSERT' : null, storage.permissions.update ? 'UPDATE' : null].filter(Boolean).join(', ') || 'none reported'
      : 'not verified';
    const saveStatus = storage.canSave === true ? 'save yes' : storage.canSave === false ? 'save no' : 'save unknown';
    return ui.card(
      'Credential storage — admin-only read-only check',
      `<div class="card-body">
        <div class="row wrap" style="gap:12px;align-items:center;">
          <span class="badge badge-${tone}">${escapeHtml(storage.state)}</span>
          <b>${escapeHtml(storage.summary || '')}</b>
          <span class="tiny muted">checked ${storage.checkedAt ? escapeHtml(fmt.dateTimeLabel(storage.checkedAt)) : 'just now'} · nothing was written</span>
        </div>
        <div class="diag-grid section">
          <div class="diag-cell"><div class="k">Database</div><div class="v ${storage.database.reachable ? 'good' : 'warn'}">${storage.database.reachable ? 'reachable' : 'unreachable'}</div><div class="tiny muted">${escapeHtml(storage.database.message || '')}</div></div>
          <div class="diag-cell"><div class="k">Credential tables</div><div class="v ${storage.schema.ready ? 'good' : 'warn'}">${storage.schema.ready ? 'present' : 'missing / incomplete'}</div><div class="tiny muted">${escapeHtml(storage.schema.migration && storage.schema.migration.required ? `apply ${storage.schema.migration.file}` : 'migration 003')}</div></div>
          <div class="diag-cell"><div class="k">Database privileges</div><div class="v ${storage.permissions.checked && storage.permissions.select ? 'good' : 'warn'}">${escapeHtml(permission)}</div><div class="tiny muted">${storage.permissions.checked ? 'from SHOW GRANTS (booleans only)' : escapeHtml(storage.permissions.message || 'not readable')}</div></div>
          <div class="diag-cell"><div class="k">Encryption key</div><div class="v ${storage.encryption.canEncrypt ? 'good' : 'warn'}">${escapeHtml(storage.encryption.state || (storage.encryption.configured ? 'READY' : 'MISSING'))}</div><div class="tiny muted">${escapeHtml(storage.encryption.message || '')}</div></div>
          <div class="diag-cell"><div class="k">Diagnostics history</div><div class="v ${storage.history.ready ? 'good' : 'warn'}">${storage.history.ready ? 'readable' : 'unavailable'}</div><div class="tiny muted">${storage.history.ready ? 'recent API events and sync times' : escapeHtml(storage.history.error || '')}</div></div>
          <div class="diag-cell"><div class="k">Read / save</div><div class="v">${storage.canRead ? 'read yes' : 'read no'} · ${saveStatus}</div><div class="tiny muted">a provider connection test does not change this</div></div>
        </div>
        ${issueRows ? `<div class="alert warn section"><div><b>What to fix</b><ul class="small" style="margin:8px 0 0 18px;padding:0;">${issueRows}</ul></div></div>` : ''}
        <p class="tiny muted" style="margin:12px 0 0;">This check runs SELECT/SHOW statements only. It never creates an encryption key, changes a table or returns a key, password, cookie or grant text.</p>
      </div>`
    );
  }

  function statusCard(status) {
    const connection = status.connection;
    return ui.card(
      connection.inUse === false ? 'Saved credential test — not active' : 'Connection status',
      `<div class="card-body">
        <div class="row wrap" style="gap:12px;align-items:center;">
          ${badge(connection.state)}
          <b>${escapeHtml(connection.label || '')}</b>
          <span class="tiny muted">${escapeHtml(connection.message || '')}</span>
          ${
            connection.lastTestState && connection.lastTestState !== connection.state
              ? `<span class="tiny muted">· last test: ${escapeHtml(connection.lastTestState)}</span>`
              : ''
          }
        </div>
        ${connection.hint ? `<div class="alert warn" style="margin-top:12px;"><div><b>Next step</b><div>${escapeHtml(connection.hint)}</div></div></div>` : ''}
        <div class="stat-cards section">
          ${ui.mini('Last successful connection', connection.lastSuccessAt ? fmt.dateTimeLabel(connection.lastSuccessAt) : 'never', connection.lastSuccessAt ? fmt.ago(connection.lastSuccessAt) : 'no successful test recorded yet', connection.lastSuccessAt ? 'green' : '')}
          ${ui.mini('Last API request', status.lastRequestAt ? fmt.dateTimeLabel(status.lastRequestAt) : 'never', 'upstream call made by the server')}
          ${ui.mini('Last test', connection.testedAt ? fmt.dateTimeLabel(connection.testedAt) : 'never', connection.latencyMs === null ? 'latency unknown' : `${connection.latencyMs} ms round trip`)}
          ${ui.mini('Test latency', connection.latencyMs === null ? '—' : `${connection.latencyMs} ms`, 'provider /status response time')}
        </div>
        <div class="diag-grid section">
          <div class="diag-cell"><div class="k">Last successful fixtures sync</div><div class="v ${status.lastSuccessfulSyncs.fixtures.lastSuccessAt ? 'good' : ''}">${timeOrDash(
            status.lastSuccessfulSyncs.fixtures.lastSuccessAt
          )}</div></div>
          <div class="diag-cell"><div class="k">Last successful odds sync</div><div class="v ${status.lastSuccessfulSyncs.odds.lastSuccessAt ? 'good' : ''}">${timeOrDash(
            status.lastSuccessfulSyncs.odds.lastSuccessAt
          )}</div></div>
          <div class="diag-cell"><div class="k">Last successful results sync</div><div class="v">${timeOrDash(
            status.lastSuccessfulSyncs.results.lastSuccessAt
          )}</div></div>
          <div class="diag-cell"><div class="k">Last error</div><div class="v ${connection.lastErrorCode ? 'warn' : ''}">${escapeHtml(
            connection.lastErrorCode || 'none recorded'
          )}</div><div class="tiny muted">${escapeHtml(connection.lastErrorMessage || '')}</div></div>
        </div>
      </div>`
    );
  }

  function quotaCard(status) {
    const quota = status.quota;
    const limits = status.rateLimits || {};
    return ui.card(
      'Quota and rate limits',
      `<div class="card-body">
        <div class="stat-cards">
          ${ui.mini(
            'Remaining daily quota',
            quota && quota.current !== null && quota.limitDay ? `${Math.max(0, quota.limitDay - quota.current)} / ${quota.limitDay}` : 'not reported',
            quota ? `used ${quota.current} today · checked ${quota.checkedAt ? fmt.dateTimeLabel(quota.checkedAt) : 'unknown'}` : 'only shown when the provider reports it',
            quota && quota.limitDay ? 'cyan' : ''
          )}
          ${ui.mini(
            'Requests per minute',
            limits.requestsPerMinute ? String(limits.requestsPerMinute) : 'not reported',
            limits.source === 'server configuration' ? 'server request budget (configuration)' : 'provider budget'
          )}
          ${ui.mini('Plan', status.plan && status.plan.name ? status.plan.name : 'not reported', 'subscription reported by the provider')}
          ${ui.mini(
            status.client.breakerState === 'QUOTA_EXHAUSTED' ? 'Daily request budget' : 'Circuit breaker',
            status.client.breakerState,
            status.client.available
              ? 'requests allowed (not a connection test)'
              : status.client.breakerState === 'QUOTA_EXHAUSTED'
                ? `0 requests left today${status.client.resetsAt ? ` · resumes ${fmt.dateTimeLabel(status.client.resetsAt)}` : ''}`
                : status.client.label || 'paused after consecutive failures',
            status.client.available ? 'green' : 'red'
          )}
        </div>
        <p class="tiny muted" style="margin:12px 0 0;">
          Quota figures come from provider response headers or a real <code>/status</code> response. When the provider does not report
          a daily limit, this screen shows “not reported” instead of a made-up number.
        </p>
      </div>`
    );
  }

  function eventsCard(title, events, emptyMessage) {
    const rows = (events || [])
      .map(
        (e) =>
          `<tr><td class="tiny">${escapeHtml(fmt.dateTimeLabel(e.createdAt))}</td><td>${escapeHtml(e.event)}</td><td>${badge(
            e.outcome
          )}</td><td class="tiny">${e.httpStatus ? escapeHtml(String(e.httpStatus)) : '—'}</td><td class="tiny">${escapeHtml(
            e.endpoint || '—'
          )}</td><td class="tiny">${e.latencyMs === null ? '—' : escapeHtml(String(e.latencyMs)) + ' ms'}</td><td class="tiny muted">${escapeHtml(
            e.message || ''
          )}</td></tr>`
      )
      .join('');
    return ui.card(title, ui.table(['Time', 'Event', 'Outcome', 'HTTP', 'Endpoint', 'Latency', 'Message'], rows, emptyMessage));
  }

  function rulesCard(status) {
    const rules = status.predictionRules;
    return ui.card(
      'Prediction rules in force (unchanged by API configuration)',
      `<div class="card-body"><div class="diag-grid">
        <div class="diag-cell"><div class="k">Market</div><div class="v good">${escapeHtml(rules.market)} ONLY</div></div>
        <div class="diag-cell"><div class="k">Combined ticket odds</div><div class="v">${rules.oddsWindow[0].toFixed(2)}–${rules.oddsWindow[1].toFixed(2)}</div></div>
        <div class="diag-cell"><div class="k">Confidence</div><div class="v">${rules.confidenceMode === 'fixed' ? 'min ' + Number(rules.minConfidence) : 'auto (floor ' + Number(rules.minConfidence) + ')'}</div></div>
        <div class="diag-cell"><div class="k">Maximum risk</div><div class="v">${Number(rules.maxRisk)}</div></div>
        <div class="diag-cell"><div class="k">Minimum data quality</div><div class="v">${Number(rules.minDataQuality)}</div></div>
        <div class="diag-cell"><div class="k">Maximum selections</div><div class="v">${Number(rules.maxSelections)}</div></div>
        <div class="diag-cell"><div class="k">Odds freshness</div><div class="v">${Number(rules.oddsFreshnessMinutes)} min</div></div>
        <div class="diag-cell"><div class="k">Ticket generation</div><div class="v good">MANUAL ONLY</div></div>
      </div></div>`
    );
  }

  /* ----------------------------- actions ----------------------------- */

  function configuredHost(status) {
    return (status.credential && status.credential.host) || (status.environment && status.environment.host) ||
      (status.providers.find((p) => p.id === status.provider) || {}).defaultHostId || '';
  }

  function active(ctx) { return current === ctx && (!ctx.ui.isCurrent || ctx.ui.isCurrent()); }

  function actionBox(ctx, kind, message, details) {
    if (!active(ctx)) return;
    ctx.feedback = { kind, message, details };
    const box = $('#apiActionBox');
    if (!box) return;
    const cls = kind === 'error' ? 'error' : kind === 'warn' ? 'warn' : 'ok';
    const icon = kind === 'error' ? icons.alert : kind === 'warn' ? icons.info : icons.checkCircle;
    box.innerHTML = `<div class="alert ${cls}">${icon}<div><b>${escapeHtml(message)}</b>${
      details ? `<div class="small" style="margin-top:6px;">${escapeHtml(details)}</div>` : ''
    }</div></div>`;
  }

  function selectedForm() {
    return { provider: $('#apiProvider').value, host: $('#apiHost').value, key: $('#apiKey').value.trim() };
  }

  function blockedAction(status, id) {
    if (id === 'apiSaveBtn') {
      const canSave = status.storage
        ? Boolean(status.storage.canSave)
        : Boolean(status.databaseManaged && status.encryption && status.encryption.configured);
      if (!canSave) {
        const details = status.storage
          ? [status.storage.summary, ...(status.storage.issues || []).map((issue) => issue.fix || issue.message)].filter(Boolean).join(' ')
          : [status.degradedReason ? 'Run npm run db:migrate and verify database access.' : '',
            status.encryption && !status.encryption.configured ? status.encryption.message : ''].filter(Boolean).join(' ');
        return { message: 'Credential storage needs attention', details: `${details} Test connection is still available without saving.`.trim() };
      }
    }
    if (id === 'apiActivateBtn' && !status.credential) {
      return { message: 'Save the configuration first', details: 'Paste your key, test it, then Save configuration before activating the saved provider.' };
    }
    if (id === 'apiDisableBtn' && !status.credential) {
      return { message: 'No saved credential to disable', details: 'This action only disables a saved credential, not a server environment key.' };
    }
    return null;
  }

  function explainBlocked(ctx, id) {
    const blocked = blockedAction(ctx.status, id);
    if (blocked) actionBox(ctx, 'warn', blocked.message, blocked.details);
    return Boolean(blocked);
  }

  const controlIds = ['apiSaveBtn', 'apiTestBtn', 'apiActivateBtn', 'apiDisableBtn', 'apiRefreshBtn', 'apiProvider', 'apiHost', 'apiKey'];
  function controls(ctx) {
    if (!active(ctx)) return;
    controlIds.forEach((id) => {
      const el = $('#' + id);
      if (!el) return;
      // Missing prerequisites must explain themselves on click, not leave a
      // permanently greyed-out API button. The server still enforces them.
      el.disabled = ctx.busy;
      const blocked = blockedAction(ctx.status, id);
      el.title = ctx.busy ? 'A request is in progress.' : blocked ? blocked.details : '';
    });
    const hint = $('#apiControlHint');
    const blocked = ['apiSaveBtn', 'apiActivateBtn'].map((id) => blockedAction(ctx.status, id)).filter(Boolean);
    if (hint) hint.textContent = ctx.busy
      ? 'Request in progress. Controls become available when it finishes or times out.'
      : blocked.length ? blocked.map((item) => item.message + '.').join(' ') + ' Click the action for details. Test connection remains available.' : '';
  }

  async function busy(ctx, id, label, fn) {
    if (!active(ctx) || ctx.busy) return;
    ctx.busy = true;
    ctx.actionVersion += 1;
    const button = $('#' + id);
    const original = button.innerHTML;
    controls(ctx);
    button.innerHTML = `<span class="spinner"></span>&nbsp;${escapeHtml(label)}`;
    try { await fn(); }
    catch (err) { actionBox(ctx, 'error', 'Request failed', err.message); }
    finally {
      ctx.busy = false;
      if (active(ctx)) {
        // A successful save can replace the controls; do not mutate old nodes.
        if ($('#' + id) === button) button.innerHTML = original;
        controls(ctx);
      }
    }
  }

  function panels(status) {
    return `<section class="section">${storageCard(status)}</section>
      <section class="section">${statusCard(status)}</section>
      <section class="section">${quotaCard(status)}</section>
      <section class="section">${eventsCard('Recent API errors', status.recentErrors, 'No API errors recorded')}</section>
      <section class="section">${eventsCard('Recent API activity', status.recentEvents, 'No API activity recorded yet')}</section>
      <section class="section">${rulesCard(status)}</section>`;
  }

  function summary(status) {
    return `<b>${status.connection.inUse === false ? 'Saved credential' : 'Provider'}</b> ${badge(status.connection.state)}
      <span class="tiny muted">${escapeHtml(status.connection.label || '')}</span>
      <span class="tiny muted">· active source: ${escapeHtml(status.credentialSource)}</span>
      <span class="tiny muted">· credential storage: ${escapeHtml(status.storage ? status.storage.state : (status.degradedReason || 'unknown'))}</span>`;
  }

  function renderAll(ctx) {
    if (!active(ctx)) return;
    ui = ctx.ui;
    const status = ctx.status;
    ui.render(`<div id="apiConnectionSummary" class="row wrap" style="margin-bottom:12px;gap:10px;align-items:center;">${summary(status)}</div>
      <section class="section">${configurationCard(status)}</section><div id="apiStatusPanels">${panels(status)}</div>`);
    bindActions(ctx);
    controls(ctx);
    if (ctx.feedback) actionBox(ctx, ctx.feedback.kind, ctx.feedback.message, ctx.feedback.details);
  }

  async function refresh(ctx, status, replaceForm = false) {
    const version = ctx.actionVersion;
    try {
      const next = status || await API.get('/admin/api-management', REQUEST_OPTIONS);
      if (!active(ctx) || version !== ctx.actionVersion) return;
      ctx.status = next;
      if (replaceForm) renderAll(ctx);
      else {
        $('#apiConnectionSummary').innerHTML = summary(next);
        $('#apiStatusPanels').innerHTML = panels(next);
        controls(ctx);
      }
      const realtime = $('#serverTime');
      if (realtime && next.serverTime) realtime.textContent = `server ${fmt.dateTimeLabel(next.serverTime)}`;
    } catch (err) {
      if (!active(ctx) || version !== ctx.actionVersion) return;
      const previous = ctx.feedback;
      actionBox(ctx, 'warn', previous ? previous.message : 'Status could not be refreshed',
        `${previous && previous.details ? previous.details + ' ' : ''}Status refresh failed: ${err.message}. Reload the page to check the current server state.`);
    }
  }

  function bindActions(ctx) {
    $('#apiProvider').onchange = () => {
      if (!active(ctx) || ctx.busy) return;
      const provider = (ctx.status.providers || []).find((p) => p.id === $('#apiProvider').value);
      $('#apiHost').innerHTML = (provider && provider.hosts || [])
        .map((h) => `<option value="${escapeHtml(h.id)}">${escapeHtml(h.label)}</option>`).join('');
      $('#apiHost').onchange();
    };
    $('#apiHost').onchange = () => {
      if (!active(ctx) || ctx.busy) return;
      const provider = (ctx.status.providers || []).find((p) => p.id === $('#apiProvider').value) || {};
      $('#apiHostHelp').innerHTML = hostHelp(provider, $('#apiHost').value);
    };
    $('#apiSaveBtn').onclick = () => busy(ctx, 'apiSaveBtn', 'Saving…', async () => {
      if (explainBlocked(ctx, 'apiSaveBtn')) return;
      const form = selectedForm();
      if (!form.key) { actionBox(ctx, 'warn', 'Enter an API key first', 'There is nothing to encrypt and save. Test connection can use the saved key.'); return; }
      if (ctx.status.credential && ctx.status.credential.isActive && !window.confirm('This replaces the ACTIVE credential immediately. Continue?')) return;
      try {
        const result = await API.put('/admin/api-management/credentials', form, REQUEST_OPTIONS);
        if (!active(ctx)) return;
        $('#apiKey').value = '';
        actionBox(ctx, 'ok', result.replaced ? 'API key replaced (encrypted at rest)' : 'API key saved (encrypted at rest)',
          `Saved key: ${result.maskedKey}. ${result.note || 'Activate the saved credential to use it.'}`);
        await refresh(ctx, result.status, true);
      } catch (err) { actionBox(ctx, 'error', 'Could not save the API key', err.message); }
    });
    $('#apiTestBtn').onclick = () => busy(ctx, 'apiTestBtn', 'Testing…', async () => {
      const form = selectedForm();
      try {
        const result = await API.post('/admin/api-management/test', { provider: form.provider, host: form.host, ...(form.key ? { key: form.key } : {}) }, REQUEST_OPTIONS);
        actionBox(ctx, result.ok ? 'ok' : 'error', result.label || result.state,
          `${result.message}${result.hint ? ' Next step: ' + result.hint : ''}${result.quota ? ` · quota ${result.quota.current}/${result.quota.limitDay || '?'}` : ''}` +
          `${result.httpStatus ? ' · HTTP ' + result.httpStatus : ''}${result.reused ? ' · reused a recent result (no extra API call)' : ' · ' + result.latencyMs + ' ms'}` +
          (form.key ? ' This typed key has not been saved by this test. Save configuration to keep it.' : ''));
        // A read-only diagnostics refresh must not keep the form locked after
        // the test has already answered. A newer action invalidates this read.
        // Update panels only; Test-before-save keeps the typed key and host.
        refresh(ctx);
      } catch (err) { actionBox(ctx, 'error', 'Connection test failed', err.message); }
    });
    $('#apiActivateBtn').onclick = () => busy(ctx, 'apiActivateBtn', 'Activating…', async () => {
      if (explainBlocked(ctx, 'apiActivateBtn')) return;
      const form = selectedForm();
      if (form.key || form.host !== configuredHost(ctx.status)) {
        actionBox(ctx, 'warn', 'Save the configuration first', 'Activation uses the saved key and host, not an unsaved draft.'); return;
      }
      try {
        const result = await API.post('/admin/api-management/activate', { provider: form.provider }, REQUEST_OPTIONS);
        actionBox(ctx, 'ok', 'Provider activated', 'The server now uses the saved credential. Activation is not a connection test.');
        await refresh(ctx, result.status, true);
      } catch (err) { actionBox(ctx, 'error', 'Could not activate the provider', err.message); }
    });
    $('#apiDisableBtn').onclick = () => busy(ctx, 'apiDisableBtn', 'Disabling…', async () => {
      if (explainBlocked(ctx, 'apiDisableBtn')) return;
      const form = selectedForm();
      if (!window.confirm('Stop using the saved credential? It stays encrypted. If an environment credential is configured, the server falls back to it; this is not a global API shutdown.')) return;
      try {
        const result = await API.post('/admin/api-management/disable', { provider: form.provider }, REQUEST_OPTIONS);
        actionBox(ctx, 'ok', 'Provider disabled', `Active credential source is now: ${result.credentialSource}. The saved key remains encrypted.`);
        await refresh(ctx, result.status, !hasUnsavedChanges());
      } catch (err) { actionBox(ctx, 'error', 'Could not disable the provider', err.message); }
    });
    $('#apiRefreshBtn').onclick = () => busy(ctx, 'apiRefreshBtn', 'Refreshing…', async () => {
      try {
        const diagnostics = await API.get('/admin/api-management/diagnostics?probe=1', REQUEST_OPTIONS);
        const probe = diagnostics.liveProbe;
        actionBox(ctx, probe && probe.ok ? 'ok' : 'warn', probe ? probe.label || probe.state : 'Status refreshed',
          `${probe && probe.message || 'No usable active credential is configured.'}${probe && probe.hint ? ' Next step: ' + probe.hint : ''}` +
          (probe && probe.reused ? ' · reused a recent result (no extra API call)' : '') + ' This checks the active credential, not an unsaved draft.');
        await refresh(ctx, diagnostics.status, !hasUnsavedChanges());
      } catch (err) { actionBox(ctx, 'error', 'Could not refresh the API status', err.message); }
    });
  }

  async function load(helpers) {
    const ctx = { ui: helpers, status: null, feedback: null, busy: false, actionVersion: 0 };
    current = ctx;
    ui = helpers;
    ui.render('<div class="skeleton block"></div><div class="skeleton line"></div>');
    const status = await API.get('/admin/api-management', REQUEST_OPTIONS);
    if (!active(ctx)) return;
    ctx.status = status;
    renderAll(ctx);
  }

  function hasUnsavedChanges() {
    if (!current || !current.status || !active(current)) return false;
    const key = $('#apiKey');
    const host = $('#apiHost');
    return Boolean((key && key.value) || (host && host.value !== configuredHost(current.status)));
  }

  if (window.addEventListener) window.addEventListener('beforeunload', (event) => {
    if (!hasUnsavedChanges() && !(current && active(current) && current.busy)) return;
    event.preventDefault(); event.returnValue = '';
  });
  window.AdminApiManagement = { load, hasUnsavedChanges, isBusy: () => Boolean(current && active(current) && current.busy) };
})();
