'use strict';

/**
 * ADMIN controller — dashboard, manual ticket generation, settings, sync,
 * logs and analytics. Every handler runs behind requireAdmin +
 * requireActiveAdmin + requireCsrf.
 *
 * The generator NEVER accepts odds, confidence, picks or totals from the
 * request body: the payload may only contain an optional date.
 */

const db = require('../database/queries');
const time = require('../utils/time');
const decimal = require('../utils/decimal');
const config = require('../config');
const { assertValid } = require('../utils/validate');
const { asyncHandler } = require('../utils/asyncHandler');
const { AppError } = require('../utils/errors');
const ticketService = require('../services/ticketService');
const settingsService = require('../services/settingsService');
const syncService = require('../services/syncService');
const analyticsService = require('../services/analyticsService');
const oddsService = require('../services/oddsService');
const logService = require('../services/logService');
const { apiFootball } = require('../services/apiFootball');

/* ---------------------------------------------------------------------- */
/* dashboard                                                               */
/* ---------------------------------------------------------------------- */

/** GET /api/admin/overview */
const overview = asyncHandler(async (_req, res) => {
  const now = new Date();
  const [ticket, settings, analytics, lastGeneration, syncs, fixtureCounts, oddsCounts] = await Promise.all([
    ticketService.getTicketForDate(now),
    settingsService.getEngineSettings(),
    analyticsService.getOverview(),
    db.listGenerationLogs(1).then((rows) => rows[0] || null),
    logService.recentSyncs(8),
    db.countFixturesBetween(time.startOfUtcDay(now), time.addDays(time.startOfUtcDay(now), 1)),
    oddsService
      ? db.countVerifiedOver15Odds(time.startOfUtcDay(now), time.addDays(time.startOfUtcDay(now), 1))
      : { fixturesWithOdds: 0, oddsRows: 0 },
  ]);

  res.json({
    ok: true,
    data: {
      today: ticket,
      generationRunning: ticketService.isRunning(),
      lastGeneration: lastGeneration
        ? {
            runId: Number(lastGeneration.id),
            date: time.toMysqlDate(lastGeneration.ticket_date),
            status: lastGeneration.status,
            triggerSource: lastGeneration.trigger_source,
            startedAt: time.toIso(lastGeneration.started_at),
            finishedAt: time.toIso(lastGeneration.finished_at),
            durationMs: lastGeneration.duration_ms === null ? null : Number(lastGeneration.duration_ms),
            selectedPicks: Number(lastGeneration.selected_picks),
            totalOdds: lastGeneration.total_odds === null ? null : decimal.format(decimal.toScaled(lastGeneration.total_odds), 2),
          }
        : null,
      dataToday: {
        fixtures: fixtureCounts.total,
        playableFixtures: fixtureCounts.playable,
        fixturesWithVerifiedOdds: oddsCounts.fixturesWithOdds,
        verifiedOddsRows: oddsCounts.oddsRows,
      },
      settings: {
        market: { key: settings.marketKey, label: settings.marketLabel },
        oddsWindow: { min: Number(settings.minTotalOdds), max: Number(settings.maxTotalOdds) },
        thresholds: {
          minConfidence: Number(settings.minConfidence),
          maxRisk: Number(settings.maxRisk),
          minDataQuality: Number(settings.minDataQuality),
          minSelections: Number(settings.minSelections),
          maxSelections: Number(settings.maxSelections),
        },
        correlationProtection: Boolean(settings.correlationProtection),
        autoTicketGeneration: false,
        oddsFreshnessMinutes: Number(settings.oddsFreshnessMinutes),
      },
      dataSource: apiFootball.breakerState(),
      analytics: {
        tickets: analytics.tickets,
        selections: analytics.selections,
        streaks: analytics.streaks,
      },
      recentSyncs: syncs.map((s) => ({
        id: Number(s.id),
        job: s.job,
        status: s.status,
        trigger: s.trigger_source,
        message: s.message,
        startedAt: time.toIso(s.started_at),
      })),
      serverTime: now.toISOString(),
    },
  });
});

/* ---------------------------------------------------------------------- */
/* manual ticket generation                                                */
/* ---------------------------------------------------------------------- */

/**
 * POST /api/admin/generate-ticket
 * Body may ONLY contain { date }. Any odds/picks/totals sent by a client are
 * ignored — the server recomputes everything from verified data.
 */
const generateTicket = asyncHandler(async (req, res) => {
  const params = assertValid({ date: { type: 'date' } }, req.body || {});
  const ignoredClientFields = Object.keys(req.body || {}).filter(
    (k) => !['date'].includes(k)
  );

  const started = await ticketService.startGeneration({
    adminId: req.admin.id,
    source: 'admin_ui',
    date: params.date || null,
  });

  await logService.audit(
    req,
    'TICKET_GENERATION_STARTED',
    { runId: started.runId, ticketDate: started.ticketDate, ignoredClientFields },
    'info'
  );

  res.status(202).json({
    ok: true,
    data: {
      ...started,
      ignoredClientFields,
      note: 'Odds, picks and totals are always computed on the server from verified API data.',
      progressUrl: `/api/admin/generation-progress?run_id=${started.runId}`,
    },
  });
});

/** GET /api/admin/generation-progress?run_id= */
const generationProgress = asyncHandler(async (req, res) => {
  const { run_id: runId } = assertValid({ run_id: { type: 'int', required: true, min: 1 } }, req.query);
  const progress = await ticketService.getGenerationProgress(runId);
  if (!progress) throw AppError.notFound('Generation run not found', 'GENERATION_NOT_FOUND');
  res.json({ ok: true, data: progress });
});

/** GET /api/admin/generation-report?run_id=|date= */
const generationReport = asyncHandler(async (req, res) => {
  const params = assertValid({ run_id: { type: 'int', min: 1 }, date: { type: 'date' } }, req.query);
  const report = await ticketService.getGenerationReport({ runId: params.run_id || null, date: params.date || null });
  if (!report) throw AppError.notFound('No generation report found', 'REPORT_NOT_FOUND');
  res.json({ ok: true, data: report });
});

/** GET /api/admin/generations?limit= */
const generations = asyncHandler(async (req, res) => {
  const { limit } = assertValid({ limit: { type: 'int', default: 25, min: 1, max: 200 } }, req.query);
  const rows = await db.listGenerationLogs(limit);
  res.json({
    ok: true,
    data: rows.map((r) => ({
      runId: Number(r.id),
      ticketId: r.ticket_id === null ? null : Number(r.ticket_id),
      date: time.toMysqlDate(r.ticket_date),
      status: r.status,
      triggerSource: r.trigger_source,
      adminId: r.admin_id === null ? null : Number(r.admin_id),
      startedAt: time.toIso(r.started_at),
      finishedAt: time.toIso(r.finished_at),
      durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
      fixturesScanned: Number(r.fixtures_scanned),
      over15Candidates: Number(r.over15_candidates),
      verifiedOdds: Number(r.verified_odds),
      finalCandidates: Number(r.final_candidates),
      combinationsTested: Number(r.combinations_tested),
      qualifiedCombinations: Number(r.qualified_combinations),
      selectedPicks: Number(r.selected_picks),
      totalOdds: r.total_odds === null ? null : decimal.format(decimal.toScaled(r.total_odds), 2),
      error: r.error_detail || null,
    })),
  });
});

/* ---------------------------------------------------------------------- */
/* settings                                                                */
/* ---------------------------------------------------------------------- */

/** GET /api/admin/settings */
const getSettings = asyncHandler(async (_req, res) => {
  const [items, effective] = await Promise.all([settingsService.listSettingsForAdmin(), settingsService.getEngineSettings()]);
  res.json({
    ok: true,
    data: {
      items,
      effective,
      locked: settingsService.LOCKED_KEYS,
      notice: 'market_key, market_label, auto_ticket_generation and results_settle_mode are locked and cannot be changed.',
    },
  });
});

/** PUT /api/admin/settings */
const updateSettings = asyncHandler(async (req, res) => {
  const patch = req.body && typeof req.body === 'object' ? req.body : {};
  if (!Object.keys(patch).length) throw AppError.badRequest('No settings supplied', 'EMPTY_PATCH');
  const result = await settingsService.updateSettings(patch, req.admin.id);
  await logService.audit(req, 'SETTINGS_UPDATED', { applied: result.applied, rejected: result.rejected }, result.rejected.length ? 'warn' : 'info');
  res.json({ ok: true, data: result });
});

/* ---------------------------------------------------------------------- */
/* data screens                                                            */
/* ---------------------------------------------------------------------- */

/** GET /api/admin/fixtures?date= */
const fixtures = asyncHandler(async (req, res) => {
  const { date } = assertValid({ date: { type: 'date' } }, req.query);
  const day = date || time.toMysqlDate(new Date());
  const start = time.startOfUtcDay(day);
  const end = time.addDays(start, 1);
  const rows = await db.getFixturesBetween(start, end);
  res.json({
    ok: true,
    data: {
      date: day,
      total: rows.length,
      items: rows.map((r) => ({
        id: Number(r.id),
        kickoffAt: time.toIso(r.kickoff_at),
        league: r.league_name,
        country: r.league_country,
        home: r.home_team_name,
        away: r.away_team_name,
        status: r.status_short,
        playable: Number(r.is_playable) === 1,
        finished: Number(r.is_finished) === 1,
        score: r.goals_home === null || r.goals_away === null ? null : `${Number(r.goals_home)}-${Number(r.goals_away)}`,
        fetchedAt: time.toIso(r.fetched_at),
      })),
    },
  });
});

/** GET /api/admin/odds?date= — includes rejected rows for audit */
const odds = asyncHandler(async (req, res) => {
  const { date } = assertValid({ date: { type: 'date' } }, req.query);
  const day = date || time.toMysqlDate(new Date());
  const start = time.startOfUtcDay(day);
  const end = time.addDays(start, 1);
  const fixtures = await db.getFixturesBetween(start, end);
  const ids = fixtures.map((f) => Number(f.id));
  const rows = await db.getOddsForFixtures(ids);
  const fixtureById = new Map(fixtures.map((f) => [Number(f.id), f]));

  res.json({
    ok: true,
    data: {
      date: day,
      total: rows.length,
      verified: rows.filter((r) => Number(r.is_verified) === 1).length,
      items: rows.map((r) => {
        const fixture = fixtureById.get(Number(r.fixture_id));
        return {
          id: Number(r.id),
          fixtureId: Number(r.fixture_id),
          match: fixture ? `${fixture.home_team_name} vs ${fixture.away_team_name}` : null,
          kickoffAt: fixture ? time.toIso(fixture.kickoff_at) : null,
          marketKey: r.market_key,
          marketLabel: r.market_label,
          goalLine: Number(r.goal_line),
          betName: r.bet_name,
          valueName: r.value_name,
          bookmaker: r.bookmaker_name,
          bookmakerId: Number(r.bookmaker_id),
          odds: String(r.odd_raw),
          verified: Number(r.is_verified) === 1,
          validationState: r.validation_state,
          rejectReason: r.reject_reason,
          oddsUpdatedAt: time.toIso(r.odds_updated_at),
          fetchedAt: time.toIso(r.fetched_at),
        };
      }),
    },
  });
});

/** GET /api/admin/predictions?date=&eligible= */
const predictions = asyncHandler(async (req, res) => {
  const params = assertValid(
    { date: { type: 'date' }, eligible: { type: 'boolean', default: false }, limit: { type: 'int', default: 100, min: 1, max: 500 } },
    req.query
  );
  const day = params.date || time.toMysqlDate(new Date());
  const start = time.startOfUtcDay(day);
  const end = time.addDays(start, 1);
  const rows = await db.getPredictionsByDateRange(start, end, { eligibleOnly: params.eligible, limit: params.limit });
  const breakdown = await db.getRejectionBreakdown(start, end);
  const { formatPrediction } = require('./predictionController');
  res.json({
    ok: true,
    data: { date: day, total: rows.length, rejectionBreakdown: breakdown, items: rows.map(formatPrediction) },
  });
});

/** GET /api/admin/analytics */
const analytics = asyncHandler(async (_req, res) => {
  const [overviewData, flatStake] = await Promise.all([
    analyticsService.getOverview(),
    analyticsService.computeFlatStake().catch(() => null),
  ]);
  res.json({ ok: true, data: { ...overviewData, flatStake } });
});

/** GET /api/admin/tickets/history */
const ticketsHistory = asyncHandler(async (req, res) => {
  const params = assertValid(
    { page: { type: 'int', default: 1, min: 1 }, limit: { type: 'int', default: 30, min: 1, max: 100 }, result: { type: 'string', maxLength: 20 } },
    req.query
  );
  const data = await ticketService.getHistory(params);
  res.json({ ok: true, data });
});

/* ---------------------------------------------------------------------- */
/* operations                                                              */
/* ---------------------------------------------------------------------- */

/** POST /api/admin/sync {job: fixtures|odds|results|all} */
const sync = asyncHandler(async (req, res) => {
  const { job } = assertValid(
    { job: { type: 'enum', values: ['fixtures', 'odds', 'results', 'all'], default: 'all' } },
    req.body || {}
  );
  await logService.audit(req, 'SYNC_TRIGGERED', { job });

  if (!apiFootball.configured) {
    throw AppError.upstream('API-Football key is not configured on the server', 'NO_API_KEY');
  }

  const result = job === 'all' ? await syncService.syncAll({ trigger: 'manual' }) : await syncService[`sync${job[0].toUpperCase()}${job.slice(1)}`]({ trigger: 'manual' });
  res.json({ ok: true, data: { job, result } });
});

/** GET /api/admin/api-status */
const apiStatus = asyncHandler(async (_req, res) => {
  const status = await syncService.getApiStatus();
  res.json({
    ok: true,
    data: {
      ...status,
      // the key itself is never returned
      keyPreview: config.apiFootball.key ? `${'*'.repeat(8)}${config.apiFootball.key.slice(-4)}` : null,
      keyConfigured: Boolean(config.apiFootball.key),
      baseUrl: apiFootball.baseUrl,
      ratePerMinute: config.apiFootball.ratePerMinute,
    },
  });
});

/** GET /api/admin/system-logs */
const systemLogs = asyncHandler(async (req, res) => {
  const params = assertValid(
    {
      level: { type: 'enum', values: logService.LEVELS },
      channel: { type: 'string', maxLength: 40 },
      event: { type: 'string', maxLength: 80 },
      page: { type: 'int', default: 1, min: 1, max: 1000 },
      limit: { type: 'int', default: 50, min: 1, max: 200 },
    },
    req.query
  );
  const filters = { level: params.level || null, channel: params.channel || null, event: params.event || null };
  const { rows, total } = await logService.list({
    ...filters,
    limit: params.limit,
    offset: (params.page - 1) * params.limit,
  });
  res.json({
    ok: true,
    data: {
      page: params.page,
      limit: params.limit,
      total,
      items: rows.map((r) => ({
        id: Number(r.id),
        level: r.level,
        channel: r.channel,
        event: r.event,
        message: r.message,
        actorType: r.actor_type,
        actorId: r.actor_id === null ? null : Number(r.actor_id),
        ipAddress: r.ip_address,
        context: r.context_json ? (typeof r.context_json === 'object' ? r.context_json : null) : null,
        createdAt: time.toIso(r.created_at),
      })),
    },
  });
});

/** GET /api/admin/sync-logs */
const syncLogs = asyncHandler(async (req, res) => {
  const { limit, job } = assertValid(
    { limit: { type: 'int', default: 40, min: 1, max: 200 }, job: { type: 'enum', values: ['fixtures', 'odds', 'results'] } },
    req.query
  );
  const rows = await logService.recentSyncs(limit, job || null);
  res.json({
    ok: true,
    data: rows.map((r) => ({
      id: Number(r.id),
      job: r.job,
      status: r.status,
      trigger: r.trigger_source,
      endpointCalls: Number(r.endpoint_calls),
      rowsWritten: Number(r.rows_written),
      message: r.message,
      error: r.error_detail,
      durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
      startedAt: time.toIso(r.started_at),
      finishedAt: time.toIso(r.finished_at),
    })),
  });
});

/** GET /api/admin/admins (superadmin) */
const admins = asyncHandler(async (_req, res) => {
  const rows = await db.listAdmins();
  res.json({
    ok: true,
    data: rows.map((r) => ({
      id: Number(r.id),
      username: r.username,
      email: r.email,
      role: r.role,
      active: Number(r.is_active) === 1,
      mustChangePassword: Number(r.must_change_password) === 1,
      lastLoginAt: time.toIso(r.last_login_at),
      lastLoginIp: r.last_login_ip,
      createdAt: time.toIso(r.created_at),
    })),
  });
});

module.exports = {
  overview,
  generateTicket,
  generationProgress,
  generationReport,
  generations,
  getSettings,
  updateSettings,
  fixtures,
  odds,
  predictions,
  analytics,
  ticketsHistory,
  sync,
  apiStatus,
  systemLogs,
  syncLogs,
  admins,
};
