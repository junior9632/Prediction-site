'use strict';

/**
 * TICKET SERVICE — manual daily ticket generation.
 *
 * HARD RULES ENFORCED HERE
 *  - generation only runs when an authenticated administrator triggers it
 *    (admin_ui / admin_api) or an operator runs the CLI by hand (cli_manual).
 *    Cron / scheduler contexts are refused.
 *  - `auto_ticket_generation` is locked OFF and re-checked on every run.
 *  - only verified Over 1.5 prices are used, exactly as published.
 *  - if API-Football is unavailable the run ends as DATA_SOURCE_UNAVAILABLE
 *    and NO ticket is created.
 *  - if no combination lands inside the odds window the run ends as
 *    NO QUALIFYING TICKET. Nothing is forced.
 *  - the chosen prices are frozen into an immutable snapshot.
 */

const db = require('../database/queries');
const decimal = require('../utils/decimal');
const time = require('../utils/time');
const logger = require('../utils/logger');
const config = require('../config');
const { AppError } = require('../utils/errors');
const settingsService = require('./settingsService');
const oddsService = require('./oddsService');
const fixtureService = require('./fixtureService');
const contextService = require('./contextService');
const pipeline = require('../prediction/pipeline');
const logService = require('./logService');
const fixtureStatus = require('../utils/fixtureStatus');
const { ApiFootballUnavailable, apiFootball: defaultApi } = require('./apiFootball');

const log = logger.child('tickets');

const ALLOWED_SOURCES = new Set(['admin_ui', 'admin_api', 'cli_manual']);
const RUN_STATES = { RUNNING: 'RUNNING', QUALIFIED: 'QUALIFIED', NO_QUALIFYING_TICKET: 'NO_QUALIFYING_TICKET', DATA_SOURCE_UNAVAILABLE: 'DATA_SOURCE_UNAVAILABLE', ERROR: 'ERROR' };

/** in-memory registry so the dashboard can poll progress */
const runs = new Map();
let activeRunId = null;

/* ---------------------------------------------------------------------- */
/* guards                                                                  */
/* ---------------------------------------------------------------------- */

function assertManualTrigger({ source, adminId }) {
  if (process.env.CRON_CONTEXT === '1' || process.env.FP_CRON === '1') {
    throw AppError.forbidden('Ticket generation is disabled inside cron jobs', 'CRON_GENERATION_FORBIDDEN');
  }
  if (!ALLOWED_SOURCES.has(source)) {
    throw AppError.forbidden('Daily tickets are generated manually by an administrator only', 'AUTOMATIC_GENERATION_DISABLED');
  }
  if (source !== 'cli_manual' && !adminId) {
    throw AppError.forbidden('An authenticated administrator is required to generate a ticket', 'ADMIN_REQUIRED');
  }
}

function assertLockedRules(settings) {
  if (settings.marketKey !== 'over_1_5') {
    throw AppError.unprocessable('This platform only predicts Over 1.5 Goals', 'MARKET_LOCKED');
  }
  if (settings.autoTicketGeneration !== false) {
    throw AppError.unprocessable('Automatic ticket generation is permanently disabled', 'AUTO_GENERATION_LOCKED');
  }
  if (Number(settings.minTotalOdds) >= Number(settings.maxTotalOdds)) {
    throw AppError.unprocessable('The odds window is invalid (minimum must be lower than maximum)', 'ODDS_WINDOW_INVALID');
  }
}

/* ---------------------------------------------------------------------- */
/* progress                                                                */
/* ---------------------------------------------------------------------- */

function createProgressTracker(runId, store) {
  const seen = new Set();
  return async function step(key, label, detail) {
    const message = label || pipeline.PROGRESS_LABELS[key] || key;
    store.progress.push({ step: key, message, at: new Date().toISOString(), detail: detail || null });
    if (!seen.has(key)) {
      seen.add(key);
      store.currentStep = key;
      store.currentMessage = message;
      if (runId) {
        try {
          await db.updateGenerationLog(runId, { progressStep: key, progressJson: store.progress });
        } catch (err) {
          log.warn('progress persistence failed', { message: err.message });
        }
      }
    }
  };
}

/* ---------------------------------------------------------------------- */
/* generation                                                              */
/* ---------------------------------------------------------------------- */

/**
 * Start a generation run in the background and return its id immediately so
 * the dashboard can stream progress. Only one run at a time.
 */
async function startGeneration({ adminId = null, source = 'admin_api', date = null, api = defaultApi, now = new Date() } = {}) {
  assertManualTrigger({ source, adminId });
  if (activeRunId && runs.get(activeRunId) && runs.get(activeRunId).status === RUN_STATES.RUNNING) {
    throw AppError.conflict('A ticket generation is already running', 'GENERATION_IN_PROGRESS', { runId: activeRunId });
  }

  const settings = await settingsService.getEngineSettings(true);
  assertLockedRules(settings);

  const ticketDate = date ? time.toMysqlDate(date) : time.toMysqlDate(now);
  const startedAt = new Date();

  const runId = await db.insertGenerationLog({
    ticketDate,
    triggerSource: source,
    adminId,
    status: RUN_STATES.RUNNING,
    progressStep: 'LOADING_FIXTURES',
    progressJson: [{ step: 'START', message: 'Starting generation...', at: startedAt.toISOString() }],
    settingsSnapshot: sanitizeSettings(settings),
    startedAt,
  });

  const store = {
    runId,
    ticketDate,
    status: RUN_STATES.RUNNING,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    currentStep: 'LOADING_FIXTURES',
    currentMessage: 'Starting generation...',
    progress: [{ step: 'START', message: 'Starting generation...', at: startedAt.toISOString() }],
    report: null,
    ticket: null,
    error: null,
  };
  runs.set(runId, store);
  activeRunId = runId;

  // fire and forget: the HTTP response returns the run id right away
  runGeneration({ runId, adminId, source, date: ticketDate, api, now, settings, store })
    .catch((err) => {
      log.error('generation run crashed', { runId, message: err.message });
    })
    .finally(() => {
      if (activeRunId === runId) activeRunId = null;
    });

  return { runId, status: RUN_STATES.RUNNING, ticketDate };
}

/**
 * The complete generation pipeline. Also usable synchronously (CLI, tests).
 */
async function runGeneration(params = {}) {
  const {
    runId = null,
    adminId = null,
    source = 'admin_api',
    api = defaultApi,
    store = runs.get(runId) || null,
  } = params;

  assertManualTrigger({ source, adminId });

  const startedAt = Date.now();
  const now = params.now ? time.toDate(params.now) || new Date() : new Date();
  const settings = params.settings || (await settingsService.getEngineSettings(true));
  assertLockedRules(settings);

  const ticketDate = params.date ? time.toMysqlDate(params.date) : time.toMysqlDate(now);
  const localStore =
    store ||
    runs.get(runId) ||
    { runId, ticketDate, status: RUN_STATES.RUNNING, progress: [], report: null, ticket: null, error: null };
  if (!localStore.progress) localStore.progress = [];
  const step = createProgressTracker(runId, localStore);

  const finalize = async (status, payload = {}) => {
    const durationMs = Date.now() - startedAt;
    localStore.status = status;
    localStore.finishedAt = new Date().toISOString();
    localStore.report = payload.report || null;
    localStore.ticket = payload.ticket || null;
    localStore.counters = payload.counters || null;
    localStore.error = payload.error || null;

    if (runId) {
      try {
        await db.updateGenerationLog(runId, {
          status,
          ticketId: payload.ticketId || undefined,
          progressJson: localStore.progress,
          progressStep: status === RUN_STATES.QUALIFIED ? 'CREATING_TICKET' : status,
          durationMs,
          finishedAt: new Date(),
          reportJson: payload.report || undefined,
          ...(payload.counters ? counterPatch(payload.counters) : {}),
          totalOdds: payload.totalOdds !== undefined ? payload.totalOdds : undefined,
          selectedPicks: payload.selectedPicks !== undefined ? payload.selectedPicks : undefined,
          errorDetail: payload.error || undefined,
        });
      } catch (err) {
        log.error('unable to finalise generation log', { runId, message: err.message });
      }
    }
    return { runId, ticketDate, status, durationMs, ...payload };
  };

  try {
    /* -------- data source availability -------- */
    await step('LOADING_FIXTURES');
    if (!api.configured) {
      return await finalize(RUN_STATES.DATA_SOURCE_UNAVAILABLE, {
        error: 'API-Football key is not configured on the server',
        report: { reason: 'NO_API_KEY', message: 'DATA SOURCE TEMPORARILY UNAVAILABLE' },
      });
    }
    if (!api.isAvailable()) {
      return await finalize(RUN_STATES.DATA_SOURCE_UNAVAILABLE, {
        error: 'API-Football is unreachable (circuit breaker open)',
        report: { reason: 'CIRCUIT_OPEN', message: 'DATA SOURCE TEMPORARILY UNAVAILABLE', breaker: api.breakerState() },
      });
    }

    const start = time.startOfUtcDay(ticketDate);
    const end = time.addDays(start, 1);
    const leagueIds = settings.syncLeagues.length ? settings.syncLeagues : null;

    /* -------- fixtures -------- */
    let counts = await db.countFixturesBetween(start, end);
    if (counts.total === 0) {
      try {
        await fixtureService.syncDate(start, { api, leagueIds, now });
        counts = await db.countFixturesBetween(start, end);
      } catch (err) {
        if (err instanceof ApiFootballUnavailable) {
          return await finalize(RUN_STATES.DATA_SOURCE_UNAVAILABLE, {
            error: 'Fixtures could not be loaded from API-Football',
            report: { reason: 'FIXTURE_SYNC_UNAVAILABLE', message: 'DATA SOURCE TEMPORARILY UNAVAILABLE' },
          });
        }
        throw err;
      }
    }

    const rawRows = await db.getFixturesBetween(start, end);
    const playableRows = rawRows.filter((row) =>
      fixtureStatus.isPlayable(
        { statusShort: row.status_short, kickoffAt: row.kickoff_at },
        now
      )
    );

    await step('LOADING_FIXTURES', null, { fixtures: rawRows.length, playable: playableRows.length });

    /* -------- verified odds -------- */
    await step('LOADING_VERIFIED_ODDS');
    let bulkSync = null;
    try {
      bulkSync = await oddsService.syncOddsForDate(start, {
        api,
        settings,
        fixtures: rawRows,
        maxPages: Number(settings.oddsSyncMaxPages) || 12,
        now,
      });
    } catch (err) {
      if (err instanceof ApiFootballUnavailable) {
        return await finalize(RUN_STATES.DATA_SOURCE_UNAVAILABLE, {
          error: 'Odds could not be loaded from API-Football',
          report: { reason: 'ODDS_SYNC_UNAVAILABLE', message: 'DATA SOURCE TEMPORARILY UNAVAILABLE' },
        });
      }
      throw err;
    }

    const dbOdds = await oddsService.loadVerifiedPricesFromDb(playableRows, { settings, now });
    await step('LOADING_VERIFIED_ODDS', null, {
      fixturesWithVerifiedOdds: dbOdds.selected.size,
      oddsRows: bulkSync ? bulkSync.rowsWritten : 0,
    });

    /* -------- pass 1: full scan -------- */
    await step('FILTERING_OVER15_MARKETS');
    const deepIds = new Set([...dbOdds.selected.keys()]);
    const pass1Contexts = await contextService.buildContexts(
      playableRows.map((r) => pipeline.normalizeFixtureRow(r)),
      { settings, now, deepFixtureIds: deepIds }
    );

    const pass1 = await pipeline.runPipeline({
      fixtures: playableRows,
      oddsByFixture: dbOdds.selected,
      settings,
      now,
      loadContext: (fixture) => pass1Contexts.contexts.get(Number(fixture.id)) || {},
      onProgress: step,
    });

    await persistPredictions(pass1.predictions, { now });

    /* -------- shortlist + live re-verification -------- */
    await step('VALIDATING_FINAL_ODDS');
    const shortlist = [...pass1.candidates]
      .sort((a, b) => (b.strength || 0) - (a.strength || 0))
      .slice(0, Math.max(Number(settings.candidatePoolSize) || 16, (Number(settings.maxSelections) || 6) * 3));

    let finalOdds = dbOdds.selected;
    let reverify = { attempted: 0, refreshed: 0, dropped: 0, failures: [] };

    if (settings.reverifyOddsBeforeGeneration && shortlist.length) {
      try {
        const refreshed = await oddsService.refreshVerifiedPrices(
          shortlist.map((c) => c.fixtureId),
          { api, settings, now: new Date() }
        );
        finalOdds = refreshed.prices;
        reverify = {
          attempted: shortlist.length,
          refreshed: refreshed.prices.size,
          dropped: shortlist.length - refreshed.prices.size,
          failures: refreshed.failures,
        };
      } catch (err) {
        if (err instanceof ApiFootballUnavailable) {
          // The prices we hold can no longer be re-verified against the source.
          // Per the anti-fabrication rule: no new ticket.
          return await finalize(RUN_STATES.DATA_SOURCE_UNAVAILABLE, {
            error: 'Odds re-verification failed: API-Football unavailable',
            counters: pass1.counters,
            report: { reason: 'REVERIFY_UNAVAILABLE', message: 'DATA SOURCE TEMPORARILY UNAVAILABLE', reverify },
          });
        }
        throw err;
      }
    }

    /* -------- pass 2: final decision on the shortlist -------- */
    const shortlistRows = playableRows.filter((row) => finalOdds.has(Number(row.id)));
    const pass2Contexts = await contextService.buildContexts(
      shortlistRows.map((r) => pipeline.normalizeFixtureRow(r)),
      { settings, now, api, deepFixtureIds: new Set(shortlistRows.map((r) => Number(r.id))) }
    );

    const pass2 = await pipeline.runPipeline({
      fixtures: shortlistRows,
      oddsByFixture: finalOdds,
      settings,
      now,
      loadContext: (fixture) => pass2Contexts.contexts.get(Number(fixture.id)) || {},
      onProgress: step,
    });

    await persistPredictions(pass2.predictions, { now });

    const counters = mergeCounters(pass1.counters, pass2.counters, {
      fixturesScanned: rawRows.length,
      playableFixtures: playableRows.length,
      reverify,
      contextCounters: { ...pass1Contexts.counters, ...pass2Contexts.counters },
    });

    /* -------- persist the outcome -------- */
    if (pass2.status === 'QUALIFIED' && pass2.ticket) {
      await step('CREATING_TICKET');
      const persisted = await persistQualifiedTicket({
        ticketDate,
        result: pass2,
        settings,
        adminId,
        generationId: runId,
        now: new Date(),
      });

      const report = buildReport({ ticketDate, counters, result: pass2, settings, reverify, bulkSync, ticketId: persisted.ticketId });
      await logService.write({
        level: 'info',
        channel: 'tickets',
        event: 'TICKET_GENERATED',
        message: `Ticket for ${ticketDate}: ${report.selectedPicks} picks @ ${report.totalOdds}`,
        actorType: adminId ? 'admin' : 'system',
        actorId: adminId,
        context: { ticketId: persisted.ticketId, totalOdds: report.totalOdds, picks: report.selectedPicks },
      });
      return await finalize(RUN_STATES.QUALIFIED, {
        ticketId: persisted.ticketId,
        ticket: persisted.publicTicket,
        counters,
        report,
        totalOdds: decimal.format(pass2.ticket.totalOddsScaled, 6),
        selectedPicks: pass2.ticket.selections.length,
      });
    }

    await step('CREATING_TICKET');
    const persisted = await persistNoTicket({
      ticketDate,
      result: pass2,
      settings,
      adminId,
      generationId: runId,
      now: new Date(),
    });
    const report = buildReport({ ticketDate, counters, result: pass2, settings, reverify, bulkSync, ticketId: persisted.ticketId });
    await logService.write({
      level: 'warn',
      channel: 'tickets',
      event: 'NO_QUALIFYING_TICKET',
      message: `No qualifying ticket for ${ticketDate}: ${report.reason}`,
      actorType: adminId ? 'admin' : 'system',
      actorId: adminId,
      context: { reason: report.reason, candidates: counters.finalCandidates },
    });
    return await finalize(RUN_STATES.NO_QUALIFYING_TICKET, {
      ticketId: persisted.ticketId,
      ticket: persisted.publicTicket,
      counters,
      report,
      selectedPicks: 0,
    });
  } catch (err) {
    log.error('ticket generation failed', { runId, message: err.message, stack: err.stack });
    await logService.write({
      level: 'error',
      channel: 'tickets',
      event: 'GENERATION_ERROR',
      message: err.message,
      actorType: adminId ? 'admin' : 'system',
      actorId: adminId,
      context: { runId, ticketDate, code: err.code },
    });
    return await finalize(RUN_STATES.ERROR, { error: err.message, code: err.code || 'GENERATION_ERROR' });
  }
}

function counterPatch(counters = {}) {
  return {
    fixturesScanned: counters.fixturesScanned,
    over15Candidates: counters.over15Candidates,
    verifiedOdds: counters.verifiedOdds,
    rejectedMatches: counters.rejectedMatches,
    rejectedNoOdds: counters.rejectedNoOdds,
    rejectedLowConfidence: counters.rejectedLowConfidence,
    rejectedHighRisk: counters.rejectedHighRisk,
    rejectedLowQuality: counters.rejectedLowQuality,
    rejectedInsufficientData: counters.rejectedInsufficientData,
    rejectedFixtureState: counters.rejectedFixtureState,
    rejectedStaleOdds: counters.rejectedStaleOdds,
    correlationRejected: counters.correlationRejected,
    confidenceQualified: counters.confidenceQualified,
    riskQualified: counters.riskQualified,
    finalCandidates: counters.finalCandidates,
    combinationsTested: counters.combinationsTested,
    qualifiedCombinations: counters.qualifiedCombinations,
    selectedPicks: counters.selectedPicks,
  };
}

function mergeCounters(scan, finalPass, extra = {}) {
  return {
    fixturesScanned: extra.fixturesScanned ?? scan.fixturesScanned,
    playableFixtures: extra.playableFixtures ?? 0,
    over15Candidates: scan.over15Candidates,
    verifiedOdds: scan.verifiedOdds,
    rejectedMatches: scan.rejectedMatches,
    rejectedNoOdds: scan.rejectedNoOdds,
    rejectedFixtureState: scan.rejectedFixtureState,
    rejectedInsufficientData: scan.rejectedInsufficientData,
    rejectedStaleOdds: (scan.rejectedStaleOdds || 0) + (extra.reverify ? extra.reverify.dropped : 0),
    rejectedLowQuality: scan.rejectedLowQuality,
    rejectedLowConfidence: finalPass.rejectedLowConfidence,
    rejectedHighRisk: finalPass.rejectedHighRisk,
    confidenceQualified: finalPass.confidenceQualified,
    riskQualified: finalPass.riskQualified,
    qualityQualified: scan.qualityQualified,
    correlationRejected: (scan.correlationRejected || 0) + (finalPass.correlationRejected || 0),
    finalCandidates: finalPass.finalCandidates,
    combinationsTested: finalPass.combinationsTested,
    qualifiedCombinations: finalPass.qualifiedCombinations,
    selectedPicks: finalPass.selectedPicks,
    scanCandidates: scan.finalCandidates,
    reverify: extra.reverify || null,
    contexts: extra.contextCounters || null,
  };
}

/** The settings actually used, with nothing sensitive. */
function sanitizeSettings(settings) {
  const { confidence, riskWeights, qualityWeights, combinationWeights, ...rest } = settings;
  return {
    ...rest,
    weights: { confidence, riskWeights, qualityWeights, combinationWeights },
  };
}

/* ---------------------------------------------------------------------- */
/* persistence                                                             */
/* ---------------------------------------------------------------------- */

async function persistPredictions(predictions, { now }) {
  for (const p of predictions || []) {
    if (!p || !p.fixtureId) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      const row = await db.upsertPrediction({
        fixtureId: Number(p.fixtureId),
        isEligible: Boolean(p.isEligible),
        rejectReason: p.rejectReason || null,
        confidence: p.confidence ?? null,
        qualityScore: p.qualityScore ?? null,
        riskScore: p.riskScore ?? null,
        modelProbability: p.modelProbability ?? null,
        marketProbability: p.marketProbability ?? null,
        expectedGoalsHome: p.expectedGoalsHome ?? null,
        expectedGoalsAway: p.expectedGoalsAway ?? null,
        expectedTotalGoals: p.expectedTotalGoals ?? null,
        homeOver15Rate: p.features ? p.features.homeOver15Rate : null,
        awayOver15Rate: p.features ? p.features.awayOver15Rate : null,
        h2hOver15Rate: p.features ? p.features.h2hOver15Rate : null,
        h2hSample: p.features ? p.features.h2hSample : 0,
        homeFormSample: p.features ? p.features.homeSample : 0,
        awayFormSample: p.features ? p.features.awaySample : 0,
        dataQuality: p.dataQuality ?? null,
        injuriesHome: p.features ? p.features.injuriesHome : null,
        injuriesAway: p.features ? p.features.injuriesAway : null,
        selectedOdds: p.odds ? p.odds.oddRaw : null,
        selectedBookmakerId: p.odds ? p.odds.bookmakerId : null,
        selectedBookmakerName: p.odds ? p.odds.bookmakerName : null,
        oddsUpdatedAt: p.odds ? p.odds.oddsUpdatedAt : null,
        oddsVerifiedAt: p.odds ? p.odds.fetchedAt : null,
        analysisJson: {
          features: p.features || null,
          confidence: p.confidenceComponents || null,
          risk: p.riskComponents || null,
          quality: p.qualityComponents || null,
          flags: p.qualityFlags || null,
        },
        generatedAt: now,
      });
      if (row && row.id) {
        const components = [
          ...(p.confidenceComponents || []).map((c) => ({ ...c, component: `confidence_${c.component}` })),
          ...(p.riskComponents || []).map((c) => ({ ...c, component: `risk_${c.component}` })),
          ...(p.qualityComponents || []).map((c) => ({ ...c, component: `quality_${c.component}` })),
        ];
        // eslint-disable-next-line no-await-in-loop
        await db.replacePredictionScores(Number(row.id), Number(p.fixtureId), components);
        p.predictionId = Number(row.id);
      }
    } catch (err) {
      log.warn('prediction persistence failed', { fixtureId: p.fixtureId, message: err.message });
    }
  }
}

async function assertTicketReplaceable(ticketDate) {
  const existing = await db.getTicketByDate(ticketDate);
  if (!existing) return null;
  if (existing.result && existing.result !== 'PENDING' && existing.result !== 'N/A') {
    throw AppError.conflict(
      `The ticket for ${ticketDate} is already settled (${existing.result}) and cannot be regenerated`,
      'TICKET_ALREADY_SETTLED'
    );
  }
  return existing;
}

async function persistQualifiedTicket({ ticketDate, result, settings, adminId, generationId, now }) {
  const existing = await assertTicketReplaceable(ticketDate);
  if (existing) await db.deleteTicketById(Number(existing.id));

  const ticket = result.ticket;
  const ticketId = await db.createTicket({
    ticketDate,
    status: 'QUALIFIED',
    selectionCount: ticket.selections.length,
    totalOdds: decimal.format(ticket.totalOddsScaled, 6),
    totalOddsDisplay: ticket.totalOddsDisplay,
    avgConfidence: ticket.avgConfidence,
    minConfidence: ticket.minConfidence,
    avgQuality: ticket.avgQuality,
    maxRisk: ticket.maxRisk,
    estimatedProbability: ticket.estimatedProbability,
    minTotalOdds: Number(settings.minTotalOdds),
    maxTotalOdds: Number(settings.maxTotalOdds),
    generationId,
    generatedByAdminId: adminId,
    generatedAt: now,
    published: true,
  });

  const verifiedAt = now;
  const selections = ticket.selections.map((s, index) => ({
    fixtureId: Number(s.fixtureId),
    predictionId: s.predictionId || null,
    position: index + 1,
    leagueId: s.leagueId || null,
    leagueName: s.leagueName || null,
    leagueCountry: s.leagueCountry || null,
    leagueLogo: s.leagueLogo || null,
    homeTeamId: s.homeTeamId || null,
    awayTeamId: s.awayTeamId || null,
    homeTeamName: s.homeTeamName,
    awayTeamName: s.awayTeamName,
    homeTeamLogo: s.homeTeamLogo || null,
    awayTeamLogo: s.awayTeamLogo || null,
    kickoffAt: s.kickoffAt,
    bookmakerId: s.odds.bookmakerId,
    bookmakerName: s.odds.bookmakerName,
    oddDecimal: s.odds.oddRaw, // stored exactly as published
    oddRaw: s.odds.oddRaw,
    oddsUpdatedAt: s.odds.oddsUpdatedAt,
    oddsVerifiedAt: verifiedAt,
    confidence: s.confidence,
    qualityScore: s.qualityScore,
    riskScore: s.riskScore,
    modelProbability: s.modelProbability,
    snapshotJson: {
      market: { key: 'over_1_5', label: 'Over 1.5 Goals', goalLine: 1.5 },
      odds: {
        raw: s.odds.oddRaw,
        decimal: s.odds.oddDecimal,
        bookmakerId: s.odds.bookmakerId,
        bookmakerName: s.odds.bookmakerName,
        betName: s.odds.betName,
        valueName: s.odds.valueName,
        oddsUpdatedAt: time.toIso(s.odds.oddsUpdatedAt),
        verifiedAt: time.toIso(verifiedAt),
        ageMinutesAtVerification: s.odds.ageMinutes,
        bookmakersOffering: s.odds.bookmakersOffering,
        impliedProbability: s.odds.impliedProbability,
      },
      scoring: {
        confidence: s.confidence,
        quality: s.qualityScore,
        risk: s.riskScore,
        modelProbability: s.modelProbability,
        marketProbability: s.marketProbability,
        baseProbability: s.probability,
        expectedTotalGoals: s.expectedTotalGoals,
      },
      settings: {
        minTotalOdds: Number(settings.minTotalOdds),
        maxTotalOdds: Number(settings.maxTotalOdds),
        minConfidence: Number(settings.minConfidence),
        maxRisk: Number(settings.maxRisk),
        minDataQuality: Number(settings.minDataQuality),
      },
      generatedAt: time.toIso(verifiedAt),
      generatedBy: adminId ? { type: 'admin', id: adminId } : { type: 'cli' },
    },
  }));

  await db.insertSelections(ticketId, selections);
  const stored = await db.getSelectionsByTicket(ticketId);
  const ticketRow = await db.getTicketById(ticketId);

  return { ticketId, publicTicket: formatTicketForPublic(ticketRow, stored, { now }) };
}

async function persistNoTicket({ ticketDate, result, settings, adminId, generationId, now }) {
  const existing = await db.getTicketByDate(ticketDate);
  if (existing && existing.result && existing.result !== 'PENDING' && existing.result !== 'N/A') {
    // settled history is protected; report without touching it
    return { ticketId: Number(existing.id), publicTicket: null, protected: true };
  }
  if (existing) await db.deleteTicketById(Number(existing.id));

  const status = result.status === 'NO_QUALIFYING_TICKET' ? 'NO_QUALIFYING_TICKET' : result.status;
  const ticketId = await db.createTicket({
    ticketDate,
    status,
    selectionCount: 0,
    totalOdds: 0,
    totalOddsDisplay: '0.00',
    minTotalOdds: Number(settings.minTotalOdds),
    maxTotalOdds: Number(settings.maxTotalOdds),
    generationId,
    generatedByAdminId: adminId,
    generatedAt: now,
    published: true,
    resultNote: pipeline.describeNoTicket(result.report || {}, result.counters || {}),
  });
  const ticketRow = await db.getTicketById(ticketId);
  return { ticketId, publicTicket: formatTicketForPublic(ticketRow, [], { now, report: result.report, counters: result.counters }) };
}

/* ---------------------------------------------------------------------- */
/* reporting                                                               */
/* ---------------------------------------------------------------------- */

function buildReport({ ticketDate, counters, result, settings, reverify, bulkSync, ticketId }) {
  const qualified = result.status === 'QUALIFIED';
  return {
    date: time.formatReportDate(ticketDate),
    ticketDate,
    ticketId: ticketId || null,
    status: result.status,
    fixturesScanned: counters.fixturesScanned,
    playableFixtures: counters.playableFixtures,
    over15Candidates: counters.over15Candidates,
    verifiedOdds: counters.verifiedOdds,
    rejectedMatches: counters.rejectedMatches,
    rejectedNoOdds: counters.rejectedNoOdds,
    rejectedFixtureState: counters.rejectedFixtureState,
    rejectedInsufficientData: counters.rejectedInsufficientData,
    rejectedStaleOdds: counters.rejectedStaleOdds,
    rejectedLowQuality: counters.rejectedLowQuality,
    confidenceQualified: counters.confidenceQualified,
    rejectedLowConfidence: counters.rejectedLowConfidence,
    riskQualified: counters.riskQualified,
    rejectedHighRisk: counters.rejectedHighRisk,
    finalCandidates: counters.finalCandidates,
    correlationRejected: counters.correlationRejected,
    combinationsTested: counters.combinationsTested,
    qualifiedCombinations: counters.qualifiedCombinations,
    selectedPicks: qualified ? result.ticket.selections.length : 0,
    totalOdds: qualified ? result.ticket.totalOddsDisplay : null,
    totalOddsExact: qualified ? result.ticket.totalOddsExact : null,
    estimatedProbability: qualified ? result.ticket.estimatedProbability : null,
    avgConfidence: qualified ? result.ticket.avgConfidence : null,
    minConfidence: qualified ? result.ticket.minConfidence : null,
    maxRisk: qualified ? result.ticket.maxRisk : null,
    oddsWindow: { min: Number(settings.minTotalOdds), max: Number(settings.maxTotalOdds) },
    thresholds: {
      minConfidence: Number(settings.minConfidence),
      maxRisk: Number(settings.maxRisk),
      minDataQuality: Number(settings.minDataQuality),
      maxSelections: Number(settings.maxSelections),
      minSelections: Number(settings.minSelections),
    },
    reason: qualified ? null : (result.report && result.report.reason) || 'NO_COMBO_IN_RANGE',
    message: qualified
      ? 'TICKET QUALIFIED'
      : pipeline.describeNoTicket(result.report || {}, counters),
    reverify: reverify || null,
    oddsSync: bulkSync ? { rowsWritten: bulkSync.rowsWritten, endpointCalls: bulkSync.endpointCalls } : null,
    alternatives: qualified ? serializableAlternatives(result.alternatives) : [],
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Alternative combinations for the report. The exact scaled total is a BigInt
 * internally, which cannot be serialised to JSON, so only the formatted
 * strings are published.
 */
function serializableAlternatives(alternatives) {
  return (alternatives || []).slice(0, 5).map((entry) => {
    const metrics = entry.metrics || {};
    const { totalOddsScaled, ...safe } = metrics;
    return {
      fixtures: entry.combo || entry.fixtures || [],
      metrics: {
        ...safe,
        totalOdds: metrics.totalOddsDisplay ?? null,
        totalOddsExact: metrics.totalOddsExact ?? null,
      },
    };
  });
}

/* ---------------------------------------------------------------------- */
/* read models                                                             */
/* ---------------------------------------------------------------------- */

function selectionToPublic(row, now = new Date()) {
  const snapshot = parseJson(row.snapshot_json);
  return {
    id: Number(row.id),
    position: Number(row.position),
    fixtureId: Number(row.fixture_id),
    league: {
      id: row.league_id === null ? null : Number(row.league_id),
      name: row.league_name,
      country: row.league_country,
      logo: row.league_logo_url,
    },
    homeTeam: { id: row.home_team_id === null ? null : Number(row.home_team_id), name: row.home_team_name, logo: row.home_team_logo },
    awayTeam: { id: row.away_team_id === null ? null : Number(row.away_team_id), name: row.away_team_name, logo: row.away_team_logo },
    kickoffAt: time.toIso(row.kickoff_at),
    market: { key: row.market_key, label: row.market_label, goalLine: 1.5 },
    odds: {
      // the frozen snapshot value — never re-read from the bookmaker
      value: row.odd_raw || (row.odd_decimal === null ? null : String(row.odd_decimal)),
      display: decimal.format(decimal.toScaled(row.odd_raw || row.odd_decimal), 2),
      bookmakerId: row.bookmaker_id === null ? null : Number(row.bookmaker_id),
      bookmaker: row.bookmaker_name,
      oddsUpdatedAt: time.toIso(row.odds_updated_at),
      verifiedAt: time.toIso(row.odds_verified_at),
      verifiedAgo: time.humanizeAge(row.odds_verified_at, now),
    },
    confidence: row.confidence === null ? null : Number(row.confidence),
    quality: row.quality_score === null ? null : Number(row.quality_score),
    risk: row.risk_score === null ? null : Number(row.risk_score),
    result: row.result,
    score:
      row.final_home_goals === null || row.final_away_goals === null
        ? null
        : { home: Number(row.final_home_goals), away: Number(row.final_away_goals), total: Number(row.final_total_goals) },
    settledAt: time.toIso(row.settled_at),
    snapshot: snapshot
      ? {
          impliedProbability: snapshot.odds ? snapshot.odds.impliedProbability : null,
          bookmakersOffering: snapshot.odds ? snapshot.odds.bookmakersOffering : null,
          expectedTotalGoals: snapshot.scoring ? snapshot.scoring.expectedTotalGoals : null,
          modelProbability: snapshot.scoring ? snapshot.scoring.modelProbability : null,
        }
      : null,
  };
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

/** Public shape of a ticket (homepage / ticket page / history). */
function formatTicketForPublic(ticketRow, selectionRows = [], options = {}) {
  const now = options.now ? time.toDate(options.now) || new Date() : new Date();
  if (!ticketRow) return null;

  const selections = (selectionRows || []).map((row) => selectionToPublic(row, now));
  const status = ticketRow.status;
  const result = ticketRow.result;

  const base = {
    id: Number(ticketRow.id),
    date: ticketRow.ticket_date instanceof Date ? time.toMysqlDate(ticketRow.ticket_date) : String(ticketRow.ticket_date).slice(0, 10),
    market: { key: ticketRow.market_key, label: ticketRow.market_label, goalLine: 1.5 },
    status,
    result,
    selectionCount: Number(ticketRow.selection_count),
    totalOdds: ticketRow.status === 'QUALIFIED' ? String(ticketRow.total_odds_display || decimal.format(decimal.toScaled(ticketRow.total_odds), 2)) : null,
    totalOddsExact: ticketRow.status === 'QUALIFIED' ? String(ticketRow.total_odds) : null,
    settledOdds: ticketRow.settled_odds === null ? null : decimal.format(decimal.toScaled(ticketRow.settled_odds), 2),
    avgConfidence: ticketRow.avg_confidence === null ? null : Number(ticketRow.avg_confidence),
    minConfidence: ticketRow.min_confidence === null ? null : Number(ticketRow.min_confidence),
    avgQuality: ticketRow.avg_quality === null ? null : Number(ticketRow.avg_quality),
    maxRisk: ticketRow.max_risk === null ? null : Number(ticketRow.max_risk),
    estimatedProbability: ticketRow.estimated_probability === null ? null : Number(ticketRow.estimated_probability),
    oddsWindow: {
      min: Number(ticketRow.min_total_odds),
      max: Number(ticketRow.max_total_odds),
    },
    generatedAt: time.toIso(ticketRow.generated_at),
    settledAt: time.toIso(ticketRow.settled_at),
    resultNote: ticketRow.result_note || null,
    selections,
    headline:
      status === 'QUALIFIED'
        ? "TODAY'S TICKET"
        : status === 'NO_QUALIFYING_TICKET'
          ? 'NO QUALIFYING TICKET'
          : status === 'DATA_SOURCE_UNAVAILABLE'
            ? 'DATA SOURCE TEMPORARILY UNAVAILABLE'
            : "TODAY'S TICKET",
    statusLabel:
      status === 'QUALIFIED'
        ? result === 'PENDING'
          ? 'QUALIFIED'
          : result
        : status === 'NO_QUALIFYING_TICKET'
          ? 'NO QUALIFYING TICKET'
          : status === 'DATA_SOURCE_UNAVAILABLE'
            ? 'DATA SOURCE TEMPORARILY UNAVAILABLE'
            : 'PENDING',
  };

  if (status !== 'QUALIFIED') {
    const report = options.report || parseJson(options.generation && options.generation.report_json);
    const counters = options.counters || (report ? report : null);
    base.noTicket = {
      reason: report ? report.reason || report.status : status,
      message:
        status === 'DATA_SOURCE_UNAVAILABLE'
          ? 'DATA SOURCE TEMPORARILY UNAVAILABLE'
          : (report && report.message) || ticketRow.result_note ||
            `No valid Over 1.5 combination was found within the ${base.oddsWindow.min.toFixed(2)}-${base.oddsWindow.max.toFixed(2)} target range.`,
      diagnostics: counters
        ? {
            fixturesAnalyzed: counters.fixturesScanned ?? counters.playableFixtures ?? null,
            over15Candidates: counters.over15Candidates ?? null,
            verifiedOdds: counters.verifiedOdds ?? null,
            rejectedMatches: counters.rejectedMatches ?? null,
            lowConfidence: counters.rejectedLowConfidence ?? null,
            highRisk: counters.rejectedHighRisk ?? null,
            insufficientData: counters.rejectedInsufficientData ?? null,
            correlationRejected: counters.correlationRejected ?? null,
            combinationsTested: counters.combinationsTested ?? null,
            qualifiedCombinations: counters.qualifiedCombinations ?? null,
          }
        : null,
    };
  }

  return base;
}

/** Today's ticket for the public homepage. */
async function getTicketForDate(date, options = {}) {
  const now = options.now ? time.toDate(options.now) || new Date() : new Date();
  const ticketDate = time.toMysqlDate(date || now);
  const row = await db.getTicketByDate(ticketDate);
  if (!row) {
    const generation = await db.getGenerationLogByDate(ticketDate);
    if (generation && generation.status === RUN_STATES.DATA_SOURCE_UNAVAILABLE) {
      return {
        date: ticketDate,
        status: 'DATA_SOURCE_UNAVAILABLE',
        headline: 'DATA SOURCE TEMPORARILY UNAVAILABLE',
        statusLabel: 'DATA SOURCE TEMPORARILY UNAVAILABLE',
        selectionCount: 0,
        totalOdds: null,
        selections: [],
        market: { key: 'over_1_5', label: 'Over 1.5 Goals', goalLine: 1.5 },
        noTicket: {
          reason: 'DATA_SOURCE_UNAVAILABLE',
          message: 'DATA SOURCE TEMPORARILY UNAVAILABLE',
          diagnostics: null,
        },
      };
    }
    return {
      date: ticketDate,
      status: 'PENDING',
      headline: "TODAY'S TICKET",
      statusLabel: 'NOT GENERATED YET',
      selectionCount: 0,
      totalOdds: null,
      selections: [],
      market: { key: 'over_1_5', label: 'Over 1.5 Goals', goalLine: 1.5 },
      noTicket: {
        reason: 'NOT_GENERATED',
        message: 'No ticket has been generated for this date yet. Tickets are generated manually by our analysts.',
        diagnostics: null,
      },
    };
  }
  const selections = await db.getSelectionsByTicket(Number(row.id));
  const generation = row.generation_id ? await db.getGenerationLog(Number(row.generation_id)) : await db.getGenerationLogByDate(ticketDate);
  return formatTicketForPublic(row, selections, { now, generation, report: generation ? parseJson(generation.report_json) : null, counters: generation ? parseJson(generation.report_json) : null });
}

/** Paginated history with selections + results. */
async function getHistory({ from = null, to = null, status = null, result = null, page = 1, limit = 20 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const safePage = Math.max(Number(page) || 1, 1);
  const offset = (safePage - 1) * safeLimit;
  const filters = { from, to, status, result };
  const rows = await db.listTickets({ ...filters, limit: safeLimit, offset });
  const total = await db.countTickets(filters);
  const selections = await db.getSelectionsForTicketIds(rows.map((r) => Number(r.id)));
  const grouped = new Map();
  for (const s of selections) {
    const list = grouped.get(Number(s.ticket_id)) || [];
    list.push(s);
    grouped.set(Number(s.ticket_id), list);
  }
  return {
    page: safePage,
    limit: safeLimit,
    total,
    pages: Math.max(1, Math.ceil(total / safeLimit)),
    items: rows.map((row) => formatTicketForPublic(row, grouped.get(Number(row.id)) || [], {})),
  };
}

/** Generation report for the admin dashboard. */
async function getGenerationReport({ runId = null, date = null } = {}) {
  let row = null;
  if (runId) row = await db.getGenerationLog(Number(runId));
  else if (date) row = await db.getGenerationLogByDate(time.toMysqlDate(date));
  else {
    const rows = await db.listGenerationLogs(1);
    row = rows[0] || null;
  }
  if (!row) return null;
  const report = parseJson(row.report_json);
  return {
    runId: Number(row.id),
    ticketId: row.ticket_id === null ? null : Number(row.ticket_id),
    date: time.formatReportDate(row.ticket_date),
    ticketDate: time.toMysqlDate(row.ticket_date),
    status: row.status,
    triggerSource: row.trigger_source,
    adminId: row.admin_id === null ? null : Number(row.admin_id),
    startedAt: time.toIso(row.started_at),
    finishedAt: time.toIso(row.finished_at),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    progress: parseJson(row.progress_json) || [],
    settingsSnapshot: parseJson(row.settings_snapshot_json),
    counters: {
      fixturesScanned: Number(row.fixtures_scanned),
      over15Candidates: Number(row.over15_candidates),
      verifiedOdds: Number(row.verified_odds),
      rejectedMatches: Number(row.rejected_matches),
      rejectedNoOdds: Number(row.rejected_no_odds),
      rejectedLowConfidence: Number(row.rejected_low_confidence),
      rejectedHighRisk: Number(row.rejected_high_risk),
      rejectedLowQuality: Number(row.rejected_low_quality),
      rejectedInsufficientData: Number(row.rejected_insufficient_data),
      rejectedFixtureState: Number(row.rejected_fixture_state),
      rejectedStaleOdds: Number(row.rejected_stale_odds),
      correlationRejected: Number(row.correlation_rejected),
      confidenceQualified: Number(row.confidence_qualified),
      riskQualified: Number(row.risk_qualified),
      finalCandidates: Number(row.final_candidates),
      combinationsTested: Number(row.combinations_tested),
      qualifiedCombinations: Number(row.qualified_combinations),
      selectedPicks: Number(row.selected_picks),
      totalOdds: row.total_odds === null ? null : String(row.total_odds),
    },
    report,
    error: row.error_detail || null,
  };
}

/** Live progress for the dashboard (memory first, DB fallback). */
async function getGenerationProgress(runId) {
  const id = Number(runId);
  const store = runs.get(id);
  if (store) {
    return {
      runId: id,
      status: store.status,
      currentStep: store.currentStep || null,
      currentMessage: store.currentMessage || null,
      progress: store.progress,
      finishedAt: store.finishedAt || null,
      report: store.report || null,
      ticket: store.ticket || null,
      error: store.error || null,
    };
  }
  const report = await getGenerationReport({ runId: id });
  if (!report) return null;
  return {
    runId: id,
    status: report.status,
    currentStep: report.progress.length ? report.progress[report.progress.length - 1].step : null,
    currentMessage: report.progress.length ? report.progress[report.progress.length - 1].message : null,
    progress: report.progress,
    finishedAt: report.finishedAt,
    report: report.report,
    ticket: null,
    error: report.error,
  };
}

/** Is a generation running right now? */
function isRunning() {
  return Boolean(activeRunId && runs.get(activeRunId) && runs.get(activeRunId).status === RUN_STATES.RUNNING);
}

module.exports = {
  RUN_STATES,
  ALLOWED_SOURCES,
  assertManualTrigger,
  assertLockedRules,
  startGeneration,
  runGeneration,
  getTicketForDate,
  getHistory,
  getGenerationReport,
  getGenerationProgress,
  isRunning,
  formatTicketForPublic,
  selectionToPublic,
  buildReport,
  runs,
};
