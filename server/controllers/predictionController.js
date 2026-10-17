'use strict';

/** Public prediction endpoints — server computed values only. */

const db = require('../database/queries');
const time = require('../utils/time');
const { assertValid } = require('../utils/validate');
const { asyncHandler } = require('../utils/asyncHandler');
const { AppError } = require('../utils/errors');

const listSchema = {
  date: { type: 'date' },
  page: { type: 'int', default: 1, min: 1, max: 500 },
  limit: { type: 'int', default: 30, min: 1, max: 100 },
  eligible: { type: 'boolean', default: false },
};

function parseAnalysis(row) {
  if (!row.analysis_json) return null;
  if (typeof row.analysis_json === 'object') return row.analysis_json;
  try {
    return JSON.parse(row.analysis_json);
  } catch (_) {
    return null;
  }
}

function formatPrediction(row) {
  const analysis = parseAnalysis(row);
  const features = (analysis && analysis.features) || {};
  return {
    fixtureId: Number(row.fixture_id),
    kickoffAt: time.toIso(row.kickoff_at),
    market: { key: row.market_key, label: row.market_label, goalLine: 1.5 },
    league: { name: row.league_name || null, country: row.league_country || null, logo: row.league_logo || null },
    homeTeam: { name: row.home_team_name, logo: row.home_logo || null, id: row.home_team_id === null ? null : Number(row.home_team_id) },
    awayTeam: { name: row.away_team_name, logo: row.away_logo || null, id: row.away_team_id === null ? null : Number(row.away_team_id) },
    eligible: Number(row.is_eligible) === 1,
    rejectReason: row.reject_reason || null,
    confidence: row.confidence === null ? null : Number(row.confidence),
    quality: row.data_quality === null ? null : Number(row.data_quality),
    risk: row.risk_score === null ? null : Number(row.risk_score),
    modelProbability: row.model_probability === null ? null : Number(row.model_probability),
    marketProbability: row.market_probability === null ? null : Number(row.market_probability),
    expectedGoals: {
      home: row.expected_goals_home === null ? null : Number(row.expected_goals_home),
      away: row.expected_goals_away === null ? null : Number(row.expected_goals_away),
      total: row.expected_total_goals === null ? null : Number(row.expected_total_goals),
    },
    over15Rates: {
      home: row.home_over15_rate === null ? null : Number(row.home_over15_rate),
      away: row.away_over15_rate === null ? null : Number(row.away_over15_rate),
      h2h: row.h2h_over15_rate === null ? null : Number(row.h2h_over15_rate),
      league: features.leagueOver15Rate ?? null,
    },
    samples: {
      home: Number(row.home_form_sample || 0),
      away: Number(row.away_form_sample || 0),
      h2h: Number(row.h2h_sample || 0),
    },
    form: { home: features.homeFormString || null, away: features.awayFormString || null },
    injuries:
      row.injuries_home === null && row.injuries_away === null
        ? { available: false, note: 'DATA UNAVAILABLE' }
        : { available: true, home: Number(row.injuries_home || 0), away: Number(row.injuries_away || 0) },
    odds:
      row.selected_odds === null
        ? { available: false, note: 'DATA UNAVAILABLE' }
        : {
            available: true,
            value: String(row.selected_odds),
            bookmaker: row.selected_bookmaker_name,
            bookmakerId: row.selected_bookmaker_id === null ? null : Number(row.selected_bookmaker_id),
            oddsUpdatedAt: time.toIso(row.odds_updated_at),
            verifiedAt: time.toIso(row.odds_verified_at),
            verifiedAgo: time.humanizeAge(row.odds_verified_at),
          },
    generatedAt: time.toIso(row.generated_at),
  };
}

/** GET /api/predictions?date=&page=&limit=&eligible= */
const list = asyncHandler(async (req, res) => {
  const params = assertValid(listSchema, req.query);
  const date = params.date || time.toMysqlDate(new Date());
  const start = time.startOfUtcDay(date);
  const end = time.addDays(start, 1);
  const limit = params.limit;
  const offset = (params.page - 1) * limit;

  const rows = await db.getPredictionsByDateRange(start, end, {
    eligibleOnly: params.eligible,
    limit,
    offset,
  });
  const total = await db.countPredictionsByDateRange(start, end, { eligibleOnly: params.eligible });
  const breakdown = await db.getRejectionBreakdown(start, end);

  res.json({
    ok: true,
    data: {
      date,
      page: params.page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
      market: { key: 'over_1_5', label: 'Over 1.5 Goals' },
      rejectionBreakdown: breakdown,
      items: rows.map(formatPrediction),
    },
  });
});

/** GET /api/predictions/:fixtureId — full transparent breakdown */
const detail = asyncHandler(async (req, res) => {
  const { fixtureId } = assertValid({ fixtureId: { type: 'int', required: true, min: 1 } }, req.params);
  const rows = await db.getPredictionsForFixtures([fixtureId]);
  if (!rows.length) throw AppError.notFound('No prediction stored for this fixture', 'PREDICTION_NOT_FOUND');
  const row = rows[0];
  const scores = await db.getPredictionScores([Number(row.id)]);
  const analysis = parseAnalysis(row);

  res.json({
    ok: true,
    data: {
      prediction: formatPrediction(row),
      scoreBreakdown: scores.map((s) => ({
        component: s.component,
        score: Number(s.score),
        weight: Number(s.weight),
        contribution: Number(s.contribution),
        detail: s.detail_json ? (typeof s.detail_json === 'object' ? s.detail_json : null) : null,
      })),
      features: analysis ? analysis.features : null,
      flags: analysis ? analysis.flags : null,
      note: 'Every value below was computed on the server from API-Football data.',
    },
  });
});

module.exports = { list, detail, formatPrediction, parseAnalysis };
