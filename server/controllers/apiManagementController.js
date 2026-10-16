'use strict';

/**
 * API MANAGEMENT controller — the admin "API Management" screen.
 *
 * Every handler runs behind the exact same chain as the rest of /api/admin:
 *
 *   adminLimiter -> requireAdmin -> requireActiveAdmin -> requireCsrf
 *
 * so a guest, a member account, a disabled administrator or a cross-site
 * request (cookie session without the double-submit token) cannot change a
 * credential. No handler ever returns a key: the payloads carry the masked
 * form only ("********abcd").
 *
 * NONE of these endpoints can create, publish or replace a prediction ticket:
 * they only ever touch provider credentials and the provider's own /status
 * endpoint. Tests assert that explicitly (no ticket row, no generation_log row
 * — see tests/api-management.test.js).
 */

const { asyncHandler } = require('../utils/asyncHandler');
const { assertValid } = require('../utils/validate');
const credentialService = require('../services/apiCredentialService');
const providers = require('../services/apiProviders');
const logService = require('../services/logService');

/** GET /api/admin/api-management — full status + configuration (masked key). */
const status = asyncHandler(async (_req, res) => {
  res.json({ ok: true, data: await credentialService.getStatus() });
});

/** GET /api/admin/api-management/diagnostics?probe=1 — quota + connection. */
const diagnostics = asyncHandler(async (req, res) => {
  const { probe } = assertValid({ probe: { type: 'boolean', default: false } }, req.query);
  res.json({ ok: true, data: await credentialService.getDiagnostics({ probe }) });
});

/** GET /api/admin/api-management/providers — the allowlisted registry. */
const listProviders = asyncHandler(async (_req, res) => {
  res.json({ ok: true, data: { providers: providers.list(), defaultProviderId: providers.DEFAULT_PROVIDER_ID } });
});

/**
 * PUT /api/admin/api-management/credentials
 * Body: { provider, key, host }
 * Stores the key encrypted (AES-256-GCM). It does NOT activate the provider
 * and does NOT test it — saving is never reported as "connected".
 */
const saveCredentials = asyncHandler(async (req, res) => {
  const params = assertValid(
    {
      provider: { type: 'string', required: true, maxLength: 40 },
      key: { type: 'string', required: true, minLength: 8, maxLength: 256 },
      host: { type: 'string', maxLength: 120 },
    },
    req.body || {},
    { strict: true }
  );

  const result = await credentialService.saveCredential(params, { adminId: req.admin.id, req });
  await logService.audit(
    req,
    'API_CREDENTIAL_SAVED',
    { provider: result.provider, host: result.host, replaced: result.replaced, maskedKey: result.maskedKey },
    'info'
  );
  res.json({
    ok: true,
    data: {
      saved: true,
      provider: result.provider,
      host: result.host,
      maskedKey: result.maskedKey,
      replaced: result.replaced,
      isActive: result.isActive,
      note: 'Saved encrypted. Saving does not mark the provider connected — run Test Connection, then Activate Provider.',
      status: result.status,
    },
  });
});

/**
 * POST /api/admin/api-management/test
 * Body: { provider, key?, host? }
 * Makes ONE real server-side request to the provider's official /status
 * endpoint. A key may be supplied to test before saving; otherwise the stored
 * or environment credential is used.
 */
const testConnection = asyncHandler(async (req, res) => {
  const params = assertValid(
    {
      provider: { type: 'string', required: true, maxLength: 40 },
      key: { type: 'string', maxLength: 256 },
      host: { type: 'string', maxLength: 120 },
    },
    req.body || {},
    { strict: true }
  );

  const result = await credentialService.testConnection(params, { adminId: req.admin.id, req });
  await logService.audit(
    req,
    'API_CONNECTION_TESTED',
    { provider: result.provider, host: result.host, state: result.state, ok: result.ok, reused: result.reused },
    result.ok ? 'info' : 'warn'
  );
  res.json({
    ok: true,
    data: {
      ...result,
      note: 'Test Connection never saves, activates or changes a prediction ticket.',
    },
  });
});

/** POST /api/admin/api-management/activate {provider} */
const activate = asyncHandler(async (req, res) => {
  const { provider } = assertValid(
    { provider: { type: 'string', required: true, maxLength: 40 } },
    req.body || {},
    { strict: true }
  );
  const result = await credentialService.activateProvider(provider, { adminId: req.admin.id, req });
  await logService.audit(req, 'API_PROVIDER_ACTIVATED', { provider: result.provider }, 'info');
  res.json({ ok: true, data: result });
});

/** POST /api/admin/api-management/disable {provider} */
const disable = asyncHandler(async (req, res) => {
  const { provider } = assertValid(
    { provider: { type: 'string', required: true, maxLength: 40 } },
    req.body || {},
    { strict: true }
  );
  const result = await credentialService.disableProvider(provider, { adminId: req.admin.id, req });
  await logService.audit(
    req,
    'API_PROVIDER_DISABLED',
    { provider: result.provider, credentialSource: result.credentialSource },
    'warn'
  );
  res.json({ ok: true, data: result });
});

module.exports = { status, diagnostics, listProviders, saveCredentials, testConnection, activate, disable };
