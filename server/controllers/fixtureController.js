'use strict';

/** Public fixture endpoints. Read only, database backed, no secrets. */

const db = require('../database/queries');
const time = require('../utils/time');
const { assertValid } = require('../utils/validate');
const { asyncHandler } = require('../utils/asyncHandler');
const { AppError } = require('../utils/errors');
const oddsService = require('../services/oddsService');
const fixtureStatus = require('../utils/fixtureStatus');

const listSchema = {
  date: { type: 'date', required: false },
  page: { type: 'int', default: 1, min: 1, max: 500 },
  limit: { type: 'int', default: 40, min: 1, max: 100 },
  playable: { type: 'boolean', default: false },
};

function formatFixture(row, oddsByFixture = new Map()) {
  const odds = oddsByFixture.get(Number(row.id)) || null;
  return {
    id: Number(row.id),
    kickoffAt: time.toIso(row.kickoff_at),
    status: {
      short: row.status_short,
      long: row.status_long,
      label: fixtureStatus.label(row.status_short),
      playable: Number(row.is_playable) === 1,
      finished: Number(row.is_finished) === 1,
    },
    league: {
      id: row.league_id === null ? null : Number(row.league_id),
      name: row.league_name || null,
      country: row.league_country || null,
      logo: row.league_logo || null,
      round: row.league_round || null,
      season: row.league_season === null ? null : Number(row.league_season),
    },
    homeTeam: { id: row.home_team_id === null ? null : Number(row.home_team_id), name: row.home_team_name, logo: row.home_logo || null },
    awayTeam: { id: row.away_team_id === null ? null : Number(row.away_team_id), name: row.away_team_name, logo: row.away_logo || null },
    score:
      row.goals_home === null || row.goals_away === null
        ? null
        : { home: Number(row.goals_home), away: Number(row.goals_away), total: Number(row.goals_home) + Number(row.goals_away) },
    venue: { name: row.venue_name || null, city: row.venue_city || null },
    over15: odds
      ? {
          available: true,
          odds: odds.display,
          raw: odds.raw,
          bookmaker: odds.bookmaker,
          bookmakersOffering: odds.bookmakers,
          verifiedAt: odds.verifiedAt,
          oddsUpdatedAt: odds.oddsUpdatedAt,
        }
      : { available: false, odds: null, bookmaker: null, note: 'DATA UNAVAILABLE' },
  };
}

/** GET /api/fixtures?date=YYYY-MM-DD&page=&limit=&playable= */
const list = asyncHandler(async (req, res) => {
  const params = assertValid(listSchema, req.query);
  const date = params.date || time.toMysqlDate(new Date());
  const start = time.startOfUtcDay(date);
  const end = time.addDays(start, 1);

  const rows = params.playable
    ? await db.getPlayableFixturesBetween(start, end)
    : await db.getFixturesBetween(start, end);

  const page = params.page;
  const limit = params.limit;
  const paged = rows.slice((page - 1) * limit, page * limit);

  // verified Over 1.5 prices (already validated, freshness re-checked)
  const loaded = await oddsService.loadVerifiedPricesFromDb(paged, { now: new Date() });
  const oddsByFixture = new Map();
  for (const [fixtureId, price] of loaded.selected.entries()) {
    oddsByFixture.set(fixtureId, {
      display: require('../utils/decimal').format(price.oddScaled, 2),
      raw: price.oddRaw,
      bookmaker: price.bookmakerName,
      bookmakers: price.bookmakersOffering,
      verifiedAt: time.toIso(price.fetchedAt),
      oddsUpdatedAt: time.toIso(price.oddsUpdatedAt),
    });
  }

  res.json({
    ok: true,
    data: {
      date,
      page,
      limit,
      total: rows.length,
      pages: Math.max(1, Math.ceil(rows.length / limit)),
      market: { key: 'over_1_5', label: 'Over 1.5 Goals' },
      items: paged.map((row) => formatFixture(row, oddsByFixture)),
    },
  });
});

/** GET /api/fixtures/:id */
const detail = asyncHandler(async (req, res) => {
  const { id } = assertValid({ id: { type: 'int', required: true, min: 1 } }, req.params);
  const row = await db.getFixtureById(id);
  if (!row) throw AppError.notFound('Fixture not found', 'FIXTURE_NOT_FOUND');

  const oddsRows = await db.getOddsForFixture(id);
  const verified = oddsRows.filter(
    (o) => o.market_key === 'over_1_5' && Number(o.is_verified) === 1 && Number(o.goal_line) === 1.5
  );
  const prediction = await db.getPredictionsForFixtures([id]);
  const result = await db.getResultsByFixtureIds([id]);

  res.json({
    ok: true,
    data: {
      fixture: formatFixture(row),
      over15Odds: verified.map((o) => ({
        bookmakerId: Number(o.bookmaker_id),
        bookmaker: o.bookmaker_name,
        odds: String(o.odd_raw),
        betName: o.bet_name,
        valueName: o.value_name,
        verifiedAt: time.toIso(o.fetched_at),
        oddsUpdatedAt: time.toIso(o.odds_updated_at),
      })),
      prediction: prediction[0]
        ? {
            confidence: prediction[0].confidence === null ? null : Number(prediction[0].confidence),
            quality: prediction[0].data_quality === null ? null : Number(prediction[0].data_quality),
            risk: prediction[0].risk_score === null ? null : Number(prediction[0].risk_score),
            eligible: Number(prediction[0].is_eligible) === 1,
            rejectReason: prediction[0].reject_reason,
            expectedTotalGoals: prediction[0].expected_total_goals === null ? null : Number(prediction[0].expected_total_goals),
          }
        : null,
      result: result[0]
        ? {
            home: result[0].goals_home === null ? null : Number(result[0].goals_home),
            away: result[0].goals_away === null ? null : Number(result[0].goals_away),
            total: result[0].total_goals === null ? null : Number(result[0].total_goals),
            over15: result[0].over15_result,
            settled: Number(result[0].settled) === 1,
          }
        : null,
    },
  });
});

module.exports = { list, detail, formatFixture };
