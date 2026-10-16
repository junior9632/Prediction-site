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
            h.id === (status.credential && status.credential.host) || (!status.credential && h.recommended) ? 'selected' : ''
          }>${escapeHtml(h.label)}</option>`
      )
      .join('');

    const stored = status.credential;
    const masked = stored ? stored.maskedKey : status.environment.maskedKey || null;
    const sourceLabel = stored
      ? stored.isActive
        ? 'Database credential (ACTIVE)'
        : 'Database credential (saved, not active)'
      : status.environment.keyConfigured
        ? 'Environment configuration (server side)'
        : 'Not configured';

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
        <div class="row wrap" style="gap:16px;align-items:flex-start;">
          <div class="field" style="min-width:240px;flex:1;">
            <label for="apiProvider">Provider</label>
            <select class="input" id="apiProvider">${providerOptions}</select>
            <div class="hint">Only providers implemented and verified in this build can be configured.</div>
          </div>
          <div class="field" style="min-width:240px;flex:1;">
            <label for="apiHost">API host</label>
            <select class="input" id="apiHost">${hostOptions}</select>
            <div class="hint">Approved hosts only — the server refuses any other host (SSRF protection).</div>
          </div>
        </div>
        <div class="field" style="margin-top:12px;">
          <label for="apiKey">API key</label>
          <input class="input" id="apiKey" type="password" autocomplete="off" spellcheck="false"
                 placeholder="Paste the new API key — it is encrypted on the server and never sent back">
          <div class="hint">The saved key is only ever shown masked. Leave empty to keep the current credential.</div>
        </div>
        <div class="row wrap" style="margin-top:14px;gap:10px;">
          <button class="btn btn-primary" id="apiSaveBtn">${icons.check} Save configuration</button>
          <button class="btn btn-ghost" id="apiTestBtn">${icons.bolt} Test connection</button>
          <button class="btn btn-outline" id="apiActivateBtn">Activate provider</button>
          <button class="btn btn-ghost" id="apiDisableBtn">Disconnect / disable provider</button>
          <button class="btn btn-ghost" id="apiRefreshBtn">${icons.refresh} Refresh API status</button>
        </div>
        <div class="section" id="apiActionBox"></div>
        <div class="divider" style="margin:16px 0;"></div>
        <div class="diag-grid">
          <div class="diag-cell"><div class="k">Credential in use</div><div class="v">${escapeHtml(sourceLabel)}</div></div>
          <div class="diag-cell"><div class="k">Masked API key</div><div class="v">${escapeHtml(masked || 'not saved')}</div></div>
          <div class="diag-cell"><div class="k">Host</div><div class="v">${escapeHtml(status.connection.host || '—')}</div></div>
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
          )}–${status.predictionRules.oddsWindow[1].toFixed(2)}, minimum confidence ${status.predictionRules.minConfidence}.
        </p>
      </div>`
    );
  }

  function statusCard(status) {
    const connection = status.connection;
    return ui.card(
      'Connection status',
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
            quota && quota.limitDay ? `${Math.max(0, quota.limitDay - quota.current)} / ${quota.limitDay}` : 'not reported',
            quota ? `used ${quota.current} today · checked ${quota.checkedAt ? fmt.dateTimeLabel(quota.checkedAt) : 'unknown'}` : 'only shown when the provider reports it',
            quota && quota.limitDay ? 'cyan' : ''
          )}
          ${ui.mini(
            'Requests per minute',
            limits.requestsPerMinute ? String(limits.requestsPerMinute) : 'not reported',
            limits.source === 'server configuration' ? 'server request budget (configuration)' : 'provider budget'
          )}
          ${ui.mini('Plan', status.plan && status.plan.name ? status.plan.name : 'not reported', 'subscription reported by the provider')}
          ${ui.mini('Circuit breaker', status.client.breakerState, status.client.available ? 'requests allowed' : 'paused after consecutive failures', status.client.available ? 'green' : 'red')}
        </div>
        <p class="tiny muted" style="margin:12px 0 0;">
          Quota figures come from a real provider <code>/status</code> response only. When the provider does not report
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
        <div class="diag-cell"><div class="k">Minimum confidence</div><div class="v">${Number(rules.minConfidence)}</div></div>
        <div class="diag-cell"><div class="k">Maximum risk</div><div class="v">${Number(rules.maxRisk)}</div></div>
        <div class="diag-cell"><div class="k">Minimum data quality</div><div class="v">${Number(rules.minDataQuality)}</div></div>
        <div class="diag-cell"><div class="k">Maximum selections</div><div class="v">${Number(rules.maxSelections)}</div></div>
        <div class="diag-cell"><div class="k">Odds freshness</div><div class="v">${Number(rules.oddsFreshnessMinutes)} min</div></div>
        <div class="diag-cell"><div class="k">Ticket generation</div><div class="v good">MANUAL ONLY</div></div>
      </div></div>`
    );
  }

  /* ----------------------------- actions ----------------------------- */

  function actionBox(kind, message, details) {
    const box = $('#apiActionBox');
    if (!box) return;
    const cls = kind === 'error' ? 'error' : kind === 'warn' ? 'warn' : 'ok';
    const icon = kind === 'error' ? icons.alert : kind === 'warn' ? icons.info : icons.checkCircle;
    box.innerHTML = `<div class="alert ${cls}">${icon}<div><b>${escapeHtml(message)}</b>${
      details ? `<div class="small" style="margin-top:6px;">${escapeHtml(details)}</div>` : ''
    }</div></div>`;
  }

  function selectedForm() {
    const provider = $('#apiProvider');
    const host = $('#apiHost');
    const key = $('#apiKey');
    return {
      provider: provider ? provider.value : null,
      host: host ? host.value : null,
      key: key ? key.value.trim() : '',
      keyInput: key,
    };
  }

  function busy(button, label, fn) {
    const original = button ? button.innerHTML : null;
    if (button) {
      button.disabled = true;
      button.innerHTML = `<span class="spinner"></span>&nbsp;${escapeHtml(label)}`;
    }
    return Promise.resolve()
      .then(fn)
      .finally(() => {
        if (button) {
          button.disabled = false;
          button.innerHTML = original;
        }
      });
  }

  function bindActions(load) {
    const saveBtn = $('#apiSaveBtn');
    const testBtn = $('#apiTestBtn');
    const activateBtn = $('#apiActivateBtn');
    const disableBtn = $('#apiDisableBtn');
    const refreshBtn = $('#apiRefreshBtn');
    const providerSelect = $('#apiProvider');

    // the host list follows the selected provider (allowlist comes from the server)
    if (providerSelect) {
      providerSelect.onchange = async () => {
        const status = await API.get('/admin/api-management');
        const provider = (status.providers || []).find((p) => p.id === providerSelect.value);
        const hostSelect = $('#apiHost');
        if (hostSelect && provider) {
          hostSelect.innerHTML = (provider.hosts || [])
            .map((h) => `<option value="${escapeHtml(h.id)}">${escapeHtml(h.label)}</option>`)
            .join('');
        }
      };
    }

    if (saveBtn) {
      saveBtn.onclick = () =>
        busy(saveBtn, 'Saving…', async () => {
          const form = selectedForm();
          if (!form.key) {
            actionBox('warn', 'Enter an API key first', 'The field is empty, so there is nothing to encrypt and save.');
            return;
          }
          try {
            const result = await API.put('/admin/api-management/credentials', {
              provider: form.provider,
              key: form.key,
              host: form.host,
            });
            form.keyInput.value = '';
            actionBox(
              'ok',
              result.replaced ? 'API key replaced (encrypted at rest)' : 'API key saved (encrypted at rest)',
              `Saved key: ${result.maskedKey} · ${result.note}`
            );
            await load();
          } catch (err) {
            actionBox('error', 'Could not save the API key', err.message);
          }
        });
    }

    if (testBtn) {
      testBtn.onclick = () =>
        busy(testBtn, 'Testing…', async () => {
          const form = selectedForm();
          try {
            const result = await API.post('/admin/api-management/test', {
              provider: form.provider,
              host: form.host,
              ...(form.key ? { key: form.key } : {}),
            });
            actionBox(
              result.ok ? 'ok' : 'error',
              result.label || result.state,
              `${result.message}${result.quota ? ` · quota ${result.quota.current}/${result.quota.limitDay || '?'}` : ''}${
                result.reused ? ' · reused a recent result (no extra API call)' : ` · ${result.latencyMs} ms`
              }`
            );
            await load();
          } catch (err) {
            actionBox('error', 'Connection test failed', err.message);
          }
        });
    }

    if (activateBtn) {
      activateBtn.onclick = () =>
        busy(activateBtn, 'Activating…', async () => {
          const form = selectedForm();
          try {
            await API.post('/admin/api-management/activate', { provider: form.provider });
            actionBox('ok', 'Provider activated', 'The server now uses the saved (encrypted) credential for this provider.');
            await load();
          } catch (err) {
            actionBox('error', 'Could not activate the provider', err.message);
          }
        });
    }

    if (disableBtn) {
      disableBtn.onclick = () =>
        busy(disableBtn, 'Disabling…', async () => {
          const form = selectedForm();
          if (!window.confirm('Stop using the saved credential? The stored key stays encrypted and can be re-activated.')) return;
          try {
            const result = await API.post('/admin/api-management/disable', { provider: form.provider });
            actionBox('ok', 'Provider disabled', `Active credential source is now: ${result.credentialSource}.`);
            await load();
          } catch (err) {
            actionBox('error', 'Could not disable the provider', err.message);
          }
        });
    }

    if (refreshBtn) {
      refreshBtn.onclick = () =>
        busy(refreshBtn, 'Refreshing…', async () => {
          try {
            const diagnostics = await API.get('/admin/api-management/diagnostics?probe=1');
            const probe = diagnostics.liveProbe;
            actionBox(
              probe && probe.ok ? 'ok' : 'warn',
              probe ? probe.label || probe.state : 'Status refreshed',
              probe && probe.message
                ? probe.message
                : 'Status re-read. A live probe is skipped when no usable credential is configured.'
            );
            await load();
          } catch (err) {
            actionBox('error', 'Could not refresh the API status', err.message);
          }
        });
    }
  }

  /* ------------------------------ entry ------------------------------ */

  async function load(helpers) {
    if (helpers) ui = helpers;
    if (!ui) throw new Error('API Management view was not initialised');
    ui.render('<div class="skeleton block"></div><div class="skeleton line"></div>');
    const status = await API.get('/admin/api-management');
    const realtime = $('#serverTime');
    if (realtime && status.serverTime) realtime.textContent = `server ${fmt.dateTimeLabel(status.serverTime)}`;

    ui.render(
      `<div class="row wrap" style="margin-bottom:12px;gap:10px;align-items:center;">
        <b>Provider</b> ${badge(status.connection.state)}
        <span class="tiny muted">${escapeHtml(status.connection.label || '')}</span>
        <span class="tiny muted">· source: ${escapeHtml(status.credentialSource)}</span>
        ${
          status.degradedReason
            ? `<span class="badge badge-amber">${escapeHtml(status.degradedReason)}</span>`
            : ''
        }
      </div>
      <section class="section">${configurationCard(status)}</section>
      <section class="section">${statusCard(status)}</section>
      <section class="section">${quotaCard(status)}</section>
      <section class="section">${eventsCard('Recent API errors', status.recentErrors, 'No API errors recorded')}</section>
      <section class="section">${eventsCard('Recent API activity', status.recentEvents, 'No API activity recorded yet')}</section>
      <section class="section">${rulesCard(status)}</section>`
    );

    bindActions(() => load());
  }

  window.AdminApiManagement = { load };
})();
