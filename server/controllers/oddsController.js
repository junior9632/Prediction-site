'use strict';

/**
 * Public odds endpoints. Only VERIFIED Over 1.5 prices are ever exposed, and
 * they are exposed exactly as published by the bookmaker.
 */

const db = require('../database/queries');
const time = require('../utils/time');
const decimal = require('../utils/decimal');
const { assertValid } = require('../utils/validate');
const { asyncHandler } = require('../utils/asyncHandler');
const { AppError } = require('../utils/errors');
const oddsService = require('../services/oddsService');
const settingsService = require('../services/settingsService');

/** GET /api/odds?date=YYYY-MM-DD */
const listByDate = asyncHandler(async (req, res) => {
  const params = assertValid({ date: { type: 'date' } }, req.query);
  const settings = await settingsService.getEngineSettings();
  const now = new Date();
  const date = params.date || time.toMysqlDate(now);
  const start = time.startOfUtcDay(date);
  const end = time.addDays(start, 1);

  const fixtures = await db.getFixturesBetween(start, end);
  const loaded = await oddsService.loadVerifiedPricesFromDb(fixtures, { settings, now });

  const items = [];
  for (const row of fixtures) {
    const prices = loaded.grouped.get(Number(row.id)) || [];
    if (!prices.length) continue;
    const selected = loaded.selected.get(Number(row.id));
    items.push({
      fixtureId: Number(row.id),
      kickoffAt: time.toIso(row.kickoff_at),
      league: row.league_name || null,
      homeTeam: row.home_team_name,
      awayTeam: row.away_team_name,
      market: { key: 'over_1_5', label: 'Over 1.5 Goals', goalLine: 1.5 },
      selected: selected
        ? {
            bookmakerId: selected.bookmakerId,
            bookmaker: selected.bookmakerName,
            odds: decimal.format(selected.oddScaled, 2),
            raw: selected.oddRaw,
            oddsUpdatedAt: time.toIso(selected.oddsUpdatedAt),
            ageMinutes: selected.ageMinutes,
            bookmakersOffering: selected.bookmakersOffering,
          }
        : null,
      bookmakers: prices.map((p) => ({
        bookmakerId: p.bookmakerId,
        bookmaker: p.bookmakerName,
        odds: decimal.format(p.oddScaled, 2),
        raw: p.oddRaw,
        oddsUpdatedAt: time.toIso(p.oddsUpdatedAt),
      })),
    });
  }

  res.json({
    ok: true,
    data: {
      date,
      market: { key: 'over_1_5', label: 'Over 1.5 Goals', goalLine: 1.5 },
      fixturesScanned: fixtures.length,
      fixturesWithVerifiedOdds: items.length,
      freshnessMinutes: Number(settings.oddsFreshnessMinutes),
      items,
      generatedAt: now.toISOString(),
    },
  });
});

/** GET /api/odds/fixture/:id */
const byFixture = asyncHandler(async (req, res) => {
  const { id } = assertValid({ id: { type: 'int', required: true, min: 1 } }, req.params);
  const fixture = await db.getFixtureById(id);
  if (!fixture) throw AppError.notFound('Fixture not found', 'FIXTURE_NOT_FOUND');

  const settings = await settingsService.getEngineSettings();
  const loaded = await oddsService.loadVerifiedPricesFromDb([fixture], { settings, now: new Date() });
  const prices = loaded.grouped.get(Number(id)) || [];

  res.json({
    ok: true,
    data: {
      fixtureId: Number(id),
      kickoffAt: time.toIso(fixture.kickoff_at),
      homeTeam: fixture.home_team_name,
      awayTeam: fixture.away_team_name,
      league: fixture.league_id,
      market: { key: 'over_1_5', label: 'Over 1.5 Goals', goalLine: 1.5 },
      verified: prices.map((p) => ({
        bookmakerId: p.bookmakerId,
        bookmaker: p.bookmakerName,
        odds: decimal.format(p.oddScaled, 2),
        raw: p.oddRaw,
        oddsUpdatedAt: time.toIso(p.oddsUpdatedAt),
        fetchedAt: time.toIso(p.fetchedAt),
        ageMinutes: p.ageMinutes,
      })),
      selected: loaded.selected.get(Number(id))
        ? {
            bookmaker: loaded.selected.get(Number(id)).bookmakerName,
            odds: decimal.format(loaded.selected.get(Number(id)).oddScaled, 2),
            raw: loaded.selected.get(Number(id)).oddRaw,
          }
        : null,
      note: prices.length ? null : 'DATA UNAVAILABLE — no verified Over 1.5 price for this fixture',
    },
  });
});

/** GET /api/odds/bookmakers */
const bookmakers = asyncHandler(async (_req, res) => {
  const rows = await db.getBookmakers();
  res.json({
    ok: true,
    data: rows.map((r) => ({ id: Number(r.id), name: r.name, active: Number(r.is_active) === 1 })),
  });
});

module.exports = { listByDate, byFixture, bookmakers };
