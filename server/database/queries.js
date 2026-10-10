'use strict';

/**
 * Repository layer — the ONLY place SQL is written.
 *
 * Rules:
 *  - every value is bound with `?` placeholders (SQL injection safe)
 *  - LIMIT/OFFSET are inlined only after integer validation (see limitClause)
 *  - `db` is referenced through the module object so it can be replaced in
 *    tests (server/tests use mock.method on ./connection)
 */

const db = require('./connection');
const time = require('../utils/time');

const dt = (v) => time.toMysqlDateTime(v);
const d = (v) => time.toMysqlDate(v);

/* =====================================================================
 * LEAGUES
 * ===================================================================*/

async function upsertLeague(league) {
  return db.execute(
    `INSERT INTO leagues (id, name, country, country_code, logo_url, season, type, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       name = VALUES(name),
       country = VALUES(country),
       country_code = VALUES(country_code),
       logo_url = VALUES(logo_url),
       season = VALUES(season),
       type = VALUES(type),
       synced_at = VALUES(synced_at)`,
    [
      league.id,
      league.name,
      league.country || null,
      league.countryCode || null,
      league.logoUrl || null,
      league.season || null,
      league.type || null,
      dt(league.syncedAt || new Date()),
    ]
  );
}

async function getLeagueById(id) {
  return db.queryOne(`SELECT * FROM leagues WHERE id = ?`, [id]);
}

async function getAllLeagues() {
  return db.query(`SELECT * FROM leagues ORDER BY country ASC, name ASC`);
}

async function updateLeagueGoalEnvironment(id, env) {
  return db.execute(
    `UPDATE leagues
        SET avg_total_goals = ?, avg_home_goals = ?, avg_away_goals = ?,
            over15_rate = ?, sample_matches = ?, synced_at = ?
      WHERE id = ?`,
    [env.avgTotalGoals, env.avgHomeGoals, env.avgAwayGoals, env.over15Rate, env.sampleMatches, dt(new Date()), id]
  );
}

/* =====================================================================
 * TEAMS
 * ===================================================================*/

async function upsertTeam(team) {
  return db.execute(
    `INSERT INTO teams (id, name, code, country, logo_url, venue, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       name = VALUES(name), code = VALUES(code), country = VALUES(country),
       logo_url = VALUES(logo_url), venue = VALUES(venue), synced_at = VALUES(synced_at)`,
    [team.id, team.name, team.code || null, team.country || null, team.logoUrl || null, team.venue || null, dt(team.syncedAt || new Date())]
  );
}

async function getTeamsByIds(ids) {
  if (!ids || !ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.query(`SELECT * FROM teams WHERE id IN (${placeholders})`, ids);
}

/* =====================================================================
 * FIXTURES
 * ===================================================================*/

const FIXTURE_COLUMNS = `id, league_id, league_season, league_round, home_team_id, away_team_id,
  home_team_name, away_team_name, venue_name, venue_city, referee, kickoff_at, kickoff_tz,
  status_long, status_short, status_elapsed, is_playable, is_finished,
  goals_home, goals_away, score_halftime_home, score_halftime_away,
  score_extra_home, score_extra_away, score_penalty_home, score_penalty_away,
  api_timestamp, fetched_at`;

async function upsertFixture(f) {
  return db.execute(
    `INSERT INTO fixtures (${FIXTURE_COLUMNS})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       league_id = VALUES(league_id), league_season = VALUES(league_season), league_round = VALUES(league_round),
       home_team_id = VALUES(home_team_id), away_team_id = VALUES(away_team_id),
       home_team_name = VALUES(home_team_name), away_team_name = VALUES(away_team_name),
       venue_name = VALUES(venue_name), venue_city = VALUES(venue_city), referee = VALUES(referee),
       kickoff_at = VALUES(kickoff_at), kickoff_tz = VALUES(kickoff_tz),
       status_long = VALUES(status_long), status_short = VALUES(status_short), status_elapsed = VALUES(status_elapsed),
       is_playable = VALUES(is_playable), is_finished = VALUES(is_finished),
       goals_home = VALUES(goals_home), goals_away = VALUES(goals_away),
       score_halftime_home = VALUES(score_halftime_home), score_halftime_away = VALUES(score_halftime_away),
       score_extra_home = VALUES(score_extra_home), score_extra_away = VALUES(score_extra_away),
       score_penalty_home = VALUES(score_penalty_home), score_penalty_away = VALUES(score_penalty_away),
       api_timestamp = VALUES(api_timestamp), fetched_at = VALUES(fetched_at)`,
    [
      f.id, f.leagueId, f.leagueSeason, f.leagueRound || null,
      f.homeTeamId, f.awayTeamId, f.homeTeamName || null, f.awayTeamName || null,
      f.venueName || null, f.venueCity || null, f.referee || null,
      dt(f.kickoffAt), f.kickoffTz || null,
      f.statusLong || null, f.statusShort || null, f.statusElapsed || null,
      f.isPlayable ? 1 : 0, f.isFinished ? 1 : 0,
      f.goalsHome === undefined ? null : f.goalsHome,
      f.goalsAway === undefined ? null : f.goalsAway,
      f.halftimeHome === undefined ? null : f.halftimeHome,
      f.halftimeAway === undefined ? null : f.halftimeAway,
      f.extraHome === undefined ? null : f.extraHome,
      f.extraAway === undefined ? null : f.extraAway,
      f.penaltyHome === undefined ? null : f.penaltyHome,
      f.penaltyAway === undefined ? null : f.penaltyAway,
      dt(f.apiTimestamp), dt(f.fetchedAt || new Date()),
    ]
  );
}

async function getFixtureById(id) {
  return db.queryOne(`SELECT * FROM fixtures WHERE id = ?`, [id]);
}

async function getFixturesByIds(ids) {
  if (!ids || !ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.query(`SELECT * FROM fixtures WHERE id IN (${placeholders})`, ids);
}

/** Fixtures whose kickoff falls inside [from, to] (UTC). */
async function getFixturesBetween(from, to) {
  return db.query(
    `SELECT f.*, l.name AS league_name, l.country AS league_country, l.logo_url AS league_logo,
            t1.logo_url AS home_logo, t2.logo_url AS away_logo
       FROM fixtures f
       LEFT JOIN leagues l ON l.id = f.league_id
       LEFT JOIN teams t1 ON t1.id = f.home_team_id
       LEFT JOIN teams t2 ON t2.id = f.away_team_id
      WHERE f.kickoff_at >= ? AND f.kickoff_at < ?
      ORDER BY f.kickoff_at ASC`,
    [dt(from), dt(to)]
  );
}

/** Not started + not cancelled/postponed/abandoned, inside [from, to]. */
async function getPlayableFixturesBetween(from, to, leagueIds = null) {
  const params = [dt(from), dt(to)];
  let leagueFilter = '';
  if (leagueIds && leagueIds.length) {
    leagueFilter = ` AND f.league_id IN (${leagueIds.map(() => '?').join(',')})`;
    params.push(...leagueIds);
  }
  return db.query(
    `SELECT f.*, l.name AS league_name, l.country AS league_country, l.logo_url AS league_logo,
            t1.logo_url AS home_logo, t2.logo_url AS away_logo
       FROM fixtures f
       LEFT JOIN leagues l ON l.id = f.league_id
       LEFT JOIN teams t1 ON t1.id = f.home_team_id
       LEFT JOIN teams t2 ON t2.id = f.away_team_id
      WHERE f.kickoff_at >= ? AND f.kickoff_at < ?
        AND f.is_playable = 1${leagueFilter}
      ORDER BY f.kickoff_at ASC`,
    params
  );
}

/**
 * Finished matches for one team, strictly before `before` (UTC), most recent first.
 * scope: all | home | away
 */
async function getRecentFinishedByTeam(teamId, before, limit = 10, scope = 'all') {
  // placeholder order: teamId, teamId, before, [teamId when scoped]
  const params = [teamId, teamId, dt(before)];
  let scopeSql = '';
  if (scope === 'home') {
    scopeSql = ' AND f.home_team_id = ?';
    params.push(teamId);
  } else if (scope === 'away') {
    scopeSql = ' AND f.away_team_id = ?';
    params.push(teamId);
  }
  return db.query(
    `SELECT f.id, f.kickoff_at, f.home_team_id, f.away_team_id, f.goals_home, f.goals_away,
            f.league_id, f.status_short
       FROM fixtures f
      WHERE (f.home_team_id = ? OR f.away_team_id = ?)
        AND f.kickoff_at < ?
        AND f.is_finished = 1
        AND f.goals_home IS NOT NULL AND f.goals_away IS NOT NULL${scopeSql}
      ORDER BY f.kickoff_at DESC${db.limitClause(limit)}`,
    params
  );
}

/** Head to head: previous meetings between two teams before a kickoff. */
async function getH2HFixtures(teamA, teamB, before, limit = 10) {
  return db.query(
    `SELECT f.id, f.kickoff_at, f.home_team_id, f.away_team_id, f.goals_home, f.goals_away, f.league_id
       FROM fixtures f
      WHERE ((f.home_team_id = ? AND f.away_team_id = ?) OR (f.home_team_id = ? AND f.away_team_id = ?))
        AND f.kickoff_at < ?
        AND f.is_finished = 1
        AND f.goals_home IS NOT NULL AND f.goals_away IS NOT NULL
      ORDER BY f.kickoff_at DESC${db.limitClause(limit)}`,
    [teamA, teamB, teamB, teamA, dt(before)]
  );
}

/** Finished league matches used to measure the league goal environment. */
async function getLeagueFinishedMatches(leagueId, before, limit = 300) {
  return db.query(
    `SELECT goals_home, goals_away
       FROM fixtures
      WHERE league_id = ?
        AND is_finished = 1
        AND kickoff_at < ?
        AND goals_home IS NOT NULL AND goals_away IS NOT NULL
      ORDER BY kickoff_at DESC${db.limitClause(limit)}`,
    [leagueId, dt(before)]
  );
}

/** Fixtures that should now have a result but are not yet stored as finished. */
async function getFixturesAwaitingResult(from, to, limit = 200) {
  return db.query(
    `SELECT f.* FROM fixtures f
      WHERE f.kickoff_at >= ? AND f.kickoff_at < ?
        AND f.is_finished = 0
        AND f.kickoff_at < ?
      ORDER BY f.kickoff_at ASC${db.limitClause(limit)}`,
    [dt(from), dt(to), dt(new Date())]
  );
}

async function countFixturesBetween(from, to) {
  const row = await db.queryOne(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN is_playable = 1 THEN 1 ELSE 0 END) AS playable
       FROM fixtures WHERE kickoff_at >= ? AND kickoff_at < ?`,
    [dt(from), dt(to)]
  );
  return { total: Number(row?.total || 0), playable: Number(row?.playable || 0) };
}

/* =====================================================================
 * BOOKMAKERS
 * ===================================================================*/

async function upsertBookmaker(bookmaker) {
  return db.execute(
    `INSERT INTO bookmakers (id, name, is_active) VALUES (?, ?, 1)
     ON DUPLICATE KEY UPDATE name = VALUES(name), is_active = 1`,
    [bookmaker.id, bookmaker.name]
  );
}

async function getBookmakers() {
  return db.query(`SELECT * FROM bookmakers ORDER BY name ASC`);
}

/* =====================================================================
 * ODDS
 * ===================================================================*/

async function upsertOdds(o) {
  return db.execute(
    `INSERT INTO odds (fixture_id, bookmaker_id, bookmaker_name, market_key, market_label,
                       bet_name, value_name, goal_line, direction, odd_decimal, odd_raw,
                       is_verified, validation_state, reject_reason, odds_updated_at, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       bookmaker_name = VALUES(bookmaker_name),
       market_label = VALUES(market_label),
       bet_name = VALUES(bet_name),
       value_name = VALUES(value_name),
       odd_decimal = VALUES(odd_decimal),
       odd_raw = VALUES(odd_raw),
       is_verified = VALUES(is_verified),
       validation_state = VALUES(validation_state),
       reject_reason = VALUES(reject_reason),
       odds_updated_at = VALUES(odds_updated_at),
       fetched_at = VALUES(fetched_at)`,
    [
      o.fixtureId, o.bookmakerId, o.bookmakerName, o.marketKey, o.marketLabel,
      o.betName, o.valueName, o.goalLine, o.direction, o.oddDecimal, o.oddRaw,
      o.isVerified ? 1 : 0, o.validationState, o.rejectReason || null,
      dt(o.oddsUpdatedAt), dt(o.fetchedAt || new Date()),
    ]
  );
}

/** All verified Over 1.5 rows for a set of fixtures (joined with bookmaker). */
async function getVerifiedOver15Odds(fixtureIds) {
  if (!fixtureIds || !fixtureIds.length) return [];
  const placeholders = fixtureIds.map(() => '?').join(',');
  return db.query(
    `SELECT o.*, b.name AS bookmaker_display_name
       FROM odds o
       JOIN bookmakers b ON b.id = o.bookmaker_id
      WHERE o.fixture_id IN (${placeholders})
        AND o.market_key = 'over_1_5'
        AND o.goal_line = 1.50
        AND o.direction = 'over'
        AND o.is_verified = 1
      ORDER BY o.fixture_id ASC, o.odd_decimal DESC`,
    fixtureIds
  );
}

async function getOddsForFixture(fixtureId) {
  return db.query(
    `SELECT * FROM odds WHERE fixture_id = ? ORDER BY market_key ASC, odd_decimal DESC`,
    [fixtureId]
  );
}

async function getOddsForFixtures(fixtureIds) {
  if (!fixtureIds || !fixtureIds.length) return [];
  const placeholders = fixtureIds.map(() => '?').join(',');
  return db.query(
    `SELECT * FROM odds WHERE fixture_id IN (${placeholders}) ORDER BY fixture_id ASC, market_key ASC`,
    fixtureIds
  );
}

/** Freshness probe: newest stored odds payload timestamp per fixture. */
async function getOddsFreshness(fixtureIds) {
  if (!fixtureIds || !fixtureIds.length) return [];
  const placeholders = fixtureIds.map(() => '?').join(',');
  return db.query(
    `SELECT fixture_id,
            MAX(fetched_at) AS last_fetched_at,
            MAX(odds_updated_at) AS last_odds_updated_at,
            COUNT(*) AS stored_rows
       FROM odds
      WHERE fixture_id IN (${placeholders}) AND market_key = 'over_1_5'
      GROUP BY fixture_id`,
    fixtureIds
  );
}

async function countVerifiedOver15Odds(from, to) {
  const row = await db.queryOne(
    `SELECT COUNT(DISTINCT o.fixture_id) AS fixtures_with_odds, COUNT(*) AS odds_rows
       FROM odds o JOIN fixtures f ON f.id = o.fixture_id
      WHERE o.market_key = 'over_1_5' AND o.is_verified = 1
        AND f.kickoff_at >= ? AND f.kickoff_at < ?`,
    [dt(from), dt(to)]
  );
  return { fixturesWithOdds: Number(row?.fixtures_with_odds || 0), oddsRows: Number(row?.odds_rows || 0) };
}

/* =====================================================================
 * PREDICTIONS
 * ===================================================================*/

async function upsertPrediction(p) {
  await db.execute(
    `INSERT INTO predictions (fixture_id, market_key, market_label, is_eligible, reject_reason,
        confidence, quality_score, risk_score, model_probability, market_probability,
        expected_goals_home, expected_goals_away, expected_total_goals,
        home_over15_rate, away_over15_rate, h2h_over15_rate, h2h_sample,
        home_form_sample, away_form_sample, data_quality, injuries_home, injuries_away,
        selected_odds, selected_bookmaker_id, selected_bookmaker_name,
        odds_updated_at, odds_verified_at, analysis_json, generated_at)
     VALUES (?, 'over_1_5', 'Over 1.5 Goals', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
        is_eligible = VALUES(is_eligible), reject_reason = VALUES(reject_reason),
        confidence = VALUES(confidence), quality_score = VALUES(quality_score), risk_score = VALUES(risk_score),
        model_probability = VALUES(model_probability), market_probability = VALUES(market_probability),
        expected_goals_home = VALUES(expected_goals_home), expected_goals_away = VALUES(expected_goals_away),
        expected_total_goals = VALUES(expected_total_goals),
        home_over15_rate = VALUES(home_over15_rate), away_over15_rate = VALUES(away_over15_rate),
        h2h_over15_rate = VALUES(h2h_over15_rate), h2h_sample = VALUES(h2h_sample),
        home_form_sample = VALUES(home_form_sample), away_form_sample = VALUES(away_form_sample),
        data_quality = VALUES(data_quality), injuries_home = VALUES(injuries_home), injuries_away = VALUES(injuries_away),
        selected_odds = VALUES(selected_odds), selected_bookmaker_id = VALUES(selected_bookmaker_id),
        selected_bookmaker_name = VALUES(selected_bookmaker_name),
        odds_updated_at = VALUES(odds_updated_at), odds_verified_at = VALUES(odds_verified_at),
        analysis_json = VALUES(analysis_json), generated_at = VALUES(generated_at)`,
    [
      p.fixtureId, p.isEligible ? 1 : 0, p.rejectReason || null,
      p.confidence, p.qualityScore, p.riskScore, p.modelProbability, p.marketProbability,
      p.expectedGoalsHome, p.expectedGoalsAway, p.expectedTotalGoals,
      p.homeOver15Rate, p.awayOver15Rate, p.h2hOver15Rate, p.h2hSample || 0,
      p.homeFormSample || 0, p.awayFormSample || 0, p.dataQuality,
      p.injuriesHome === undefined ? null : p.injuriesHome,
      p.injuriesAway === undefined ? null : p.injuriesAway,
      p.selectedOdds, p.selectedBookmakerId || null, p.selectedBookmakerName || null,
      dt(p.oddsUpdatedAt), dt(p.oddsVerifiedAt),
      p.analysisJson ? JSON.stringify(p.analysisJson) : null,
      dt(p.generatedAt || new Date()),
    ]
  );
  return db.queryOne(`SELECT id FROM predictions WHERE fixture_id = ? AND market_key = 'over_1_5'`, [p.fixtureId]);
}

async function replacePredictionScores(predictionId, fixtureId, components) {
  await db.execute(`DELETE FROM prediction_scores WHERE prediction_id = ?`, [predictionId]);
  for (const c of components || []) {
    await db.execute(
      `INSERT INTO prediction_scores (prediction_id, fixture_id, component, score, weight, contribution, detail_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [predictionId, fixtureId, c.component, c.score ?? 0, c.weight ?? 0, c.contribution ?? 0, c.detail ? JSON.stringify(c.detail) : null]
    );
  }
}

async function getPredictionScores(predictionIds) {
  if (!predictionIds || !predictionIds.length) return [];
  const placeholders = predictionIds.map(() => '?').join(',');
  return db.query(
    `SELECT * FROM prediction_scores WHERE prediction_id IN (${placeholders}) ORDER BY contribution DESC`,
    predictionIds
  );
}

async function getPredictionsForFixtures(fixtureIds) {
  if (!fixtureIds || !fixtureIds.length) return [];
  const placeholders = fixtureIds.map(() => '?').join(',');
  return db.query(
    `SELECT p.*, f.kickoff_at, f.home_team_name, f.away_team_name, f.status_short
       FROM predictions p JOIN fixtures f ON f.id = p.fixture_id
      WHERE p.fixture_id IN (${placeholders}) AND p.market_key = 'over_1_5'`,
    fixtureIds
  );
}

async function getPredictionsByDateRange(from, to, options = {}) {
  const params = [dt(from), dt(to)];
  let extra = '';
  if (options.eligibleOnly) extra += ' AND p.is_eligible = 1';
  if (options.rejectReason) {
    extra += ' AND p.reject_reason = ?';
    params.push(options.rejectReason);
  }
  const limit = Number.isInteger(options.limit) ? options.limit : 100;
  const offset = Number.isInteger(options.offset) ? options.offset : 0;
  return db.query(
    `SELECT p.*, f.kickoff_at, f.home_team_name, f.away_team_name, f.home_team_id, f.away_team_id,
            f.status_short, f.is_playable, l.name AS league_name, l.country AS league_country, l.logo_url AS league_logo,
            t1.logo_url AS home_logo, t2.logo_url AS away_logo
       FROM predictions p
       JOIN fixtures f ON f.id = p.fixture_id
       LEFT JOIN leagues l ON l.id = f.league_id
       LEFT JOIN teams t1 ON t1.id = f.home_team_id
       LEFT JOIN teams t2 ON t2.id = f.away_team_id
      WHERE f.kickoff_at >= ? AND f.kickoff_at < ? AND p.market_key = 'over_1_5'${extra}
      ORDER BY f.kickoff_at ASC${db.limitClause(limit, offset)}`,
    params
  );
}

async function countPredictionsByDateRange(from, to, options = {}) {
  const params = [dt(from), dt(to)];
  let extra = '';
  if (options.eligibleOnly) extra += ' AND p.is_eligible = 1';
  const row = await db.queryOne(
    `SELECT COUNT(*) AS total FROM predictions p JOIN fixtures f ON f.id = p.fixture_id
      WHERE f.kickoff_at >= ? AND f.kickoff_at < ? AND p.market_key = 'over_1_5'${extra}`,
    params
  );
  return Number(row?.total || 0);
}

/** Rejection breakdown for the "NO QUALIFYING TICKET" diagnostics panel. */
async function getRejectionBreakdown(from, to) {
  const rows = await db.query(
    `SELECT COALESCE(p.reject_reason, 'NONE') AS reason, COUNT(*) AS total
       FROM fixtures f LEFT JOIN predictions p ON p.fixture_id = f.id AND p.market_key = 'over_1_5'
      WHERE f.kickoff_at >= ? AND f.kickoff_at < ?
      GROUP BY COALESCE(p.reject_reason, 'NONE')`,
    [dt(from), dt(to)]
  );
  const out = {};
  for (const r of rows) out[r.reason] = Number(r.total);
  return out;
}

/* =====================================================================
 * TEAM FORM
 * ===================================================================*/

async function upsertTeamForm(f) {
  return db.execute(
    `INSERT INTO team_form (team_id, scope, window_matches, matches_played, goals_for, goals_against,
        avg_goals_for, avg_goals_against, over15_hits, over15_rate, over25_hits, clean_sheets,
        failed_to_score, wins, draws, losses, form_string, total_goals_stddev, last_match_at, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
        matches_played = VALUES(matches_played), goals_for = VALUES(goals_for), goals_against = VALUES(goals_against),
        avg_goals_for = VALUES(avg_goals_for), avg_goals_against = VALUES(avg_goals_against),
        over15_hits = VALUES(over15_hits), over15_rate = VALUES(over15_rate), over25_hits = VALUES(over25_hits),
        clean_sheets = VALUES(clean_sheets), failed_to_score = VALUES(failed_to_score),
        wins = VALUES(wins), draws = VALUES(draws), losses = VALUES(losses),
        form_string = VALUES(form_string), total_goals_stddev = VALUES(total_goals_stddev),
        last_match_at = VALUES(last_match_at), computed_at = VALUES(computed_at)`,
    [
      f.teamId, f.scope, f.windowMatches, f.matchesPlayed, f.goalsFor, f.goalsAgainst,
      f.avgGoalsFor, f.avgGoalsAgainst, f.over15Hits, f.over15Rate, f.over25Hits, f.cleanSheets,
      f.failedToScore, f.wins, f.draws, f.losses, f.formString || null, f.totalGoalsStddev,
      dt(f.lastMatchAt), dt(new Date()),
    ]
  );
}

async function getTeamForms(teamIds, scope = 'all', windowMatches = 10) {
  if (!teamIds || !teamIds.length) return [];
  const placeholders = teamIds.map(() => '?').join(',');
  return db.query(
    `SELECT * FROM team_form
      WHERE team_id IN (${placeholders}) AND scope = ? AND window_matches = ?`,
    [...teamIds, scope, windowMatches]
  );
}

/* =====================================================================
 * TICKETS
 * ===================================================================*/

const TICKET_SELECT = `SELECT t.*, g.id AS generation_id_ref
                         FROM tickets t
                         LEFT JOIN generation_logs g ON g.id = t.generation_id`;

async function getTicketByDate(date) {
  return db.queryOne(`${TICKET_SELECT} WHERE t.ticket_date = ?`, [d(date)]);
}

async function getTicketById(id) {
  return db.queryOne(`${TICKET_SELECT} WHERE t.id = ?`, [id]);
}

async function createTicket(t) {
  const res = await db.execute(
    `INSERT INTO tickets (ticket_date, market_key, market_label, status, selection_count,
        total_odds, total_odds_display, avg_confidence, min_confidence, avg_quality, max_risk,
        estimated_probability, result, min_total_odds, max_total_odds, generation_id,
        generated_by_admin_id, generated_at, published, result_note)
     VALUES (?, 'over_1_5', 'Over 1.5 Goals', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?)`,
    [
      d(t.ticketDate), t.status, t.selectionCount || 0,
      t.totalOdds ?? 0, t.totalOddsDisplay || '0.00',
      t.avgConfidence ?? null, t.minConfidence ?? null, t.avgQuality ?? null, t.maxRisk ?? null,
      t.estimatedProbability ?? null, t.minTotalOdds, t.maxTotalOdds,
      t.generationId || null, t.generatedByAdminId || null, dt(t.generatedAt || new Date()),
      t.published === false ? 0 : 1, t.resultNote || null,
    ]
  );
  return res.insertId;
}

async function insertSelections(ticketId, selections) {
  const ids = [];
  let position = 0;
  for (const s of selections) {
    position += 1;
    const res = await db.execute(
      `INSERT INTO ticket_selections (ticket_id, fixture_id, prediction_id, position,
          league_id, league_name, league_country, league_logo_url,
          home_team_id, away_team_id, home_team_name, away_team_name, home_team_logo, away_team_logo,
          kickoff_at, market_key, market_label, bookmaker_id, bookmaker_name,
          odd_decimal, odd_raw, odds_updated_at, odds_verified_at,
          confidence, quality_score, risk_score, model_probability, result, snapshot_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'over_1_5', 'Over 1.5 Goals', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
      [
        ticketId, s.fixtureId, s.predictionId || null, s.position || position,
        s.leagueId || null, s.leagueName || null, s.leagueCountry || null, s.leagueLogo || null,
        s.homeTeamId || null, s.awayTeamId || null, s.homeTeamName, s.awayTeamName,
        s.homeTeamLogo || null, s.awayTeamLogo || null,
        dt(s.kickoffAt), s.bookmakerId || null, s.bookmakerName || null,
        s.oddDecimal, s.oddRaw || null, dt(s.oddsUpdatedAt), dt(s.oddsVerifiedAt),
        s.confidence, s.qualityScore ?? null, s.riskScore ?? null, s.modelProbability ?? null,
        s.snapshotJson ? JSON.stringify(s.snapshotJson) : null,
      ]
    );
    ids.push(res.insertId);
  }
  return ids;
}

async function getSelectionsByTicket(ticketId) {
  return db.query(
    `SELECT * FROM ticket_selections WHERE ticket_id = ? ORDER BY position ASC, kickoff_at ASC`,
    [ticketId]
  );
}

async function listTickets({ from = null, to = null, status = null, result = null, limit = 30, offset = 0 } = {}) {
  const params = [];
  let where = ' WHERE 1=1';
  if (from) { where += ' AND t.ticket_date >= ?'; params.push(d(from)); }
  if (to) { where += ' AND t.ticket_date <= ?'; params.push(d(to)); }
  if (status) { where += ' AND t.status = ?'; params.push(status); }
  if (result) { where += ' AND t.result = ?'; params.push(result); }
  return db.query(
    `SELECT t.*, (SELECT COUNT(*) FROM ticket_selections s WHERE s.ticket_id = t.id) AS selections_stored
       FROM tickets t${where}
      ORDER BY t.ticket_date DESC${db.limitClause(limit, offset)}`,
    params
  );
}

async function countTickets(filters = {}) {
  const params = [];
  let where = ' WHERE 1=1';
  if (filters.from) { where += ' AND ticket_date >= ?'; params.push(d(filters.from)); }
  if (filters.to) { where += ' AND ticket_date <= ?'; params.push(d(filters.to)); }
  if (filters.status) { where += ' AND status = ?'; params.push(filters.status); }
  if (filters.result) { where += ' AND result = ?'; params.push(filters.result); }
  const row = await db.queryOne(`SELECT COUNT(*) AS total FROM tickets${where}`, params);
  return Number(row?.total || 0);
}

async function updateTicketResult(ticketId, patch) {
  return db.execute(
    `UPDATE tickets SET result = ?, settled_odds = ?, settled_at = ?, result_note = ? WHERE id = ?`,
    [patch.result, patch.settledOdds ?? null, dt(patch.settledAt || new Date()), patch.resultNote || null, ticketId]
  );
}

/**
 * Remove a ticket (selections cascade). Used only when an administrator
 * regenerates a day that is still PENDING — settled history is never touched.
 */
async function deleteTicketById(ticketId) {
  return db.execute(`DELETE FROM tickets WHERE id = ?`, [ticketId]);
}

/* =====================================================================
 * TICKET SELECTIONS — settlement
 * ===================================================================*/

async function getPendingSelections(limit = 200) {
  return db.query(
    `SELECT s.*, t.ticket_date, f.status_short AS fixture_status, f.is_finished AS fixture_finished
       FROM ticket_selections s
       JOIN tickets t ON t.id = s.ticket_id
       JOIN fixtures f ON f.id = s.fixture_id
      WHERE s.result = 'PENDING' AND f.kickoff_at < ?
      ORDER BY f.kickoff_at ASC${db.limitClause(limit)}`,
    [dt(new Date())]
  );
}

async function updateSelectionResult(selectionId, patch) {
  return db.execute(
    `UPDATE ticket_selections
        SET result = ?, final_home_goals = ?, final_away_goals = ?, final_total_goals = ?, settled_at = ?
      WHERE id = ?`,
    [
      patch.result,
      patch.finalHomeGoals === undefined ? null : patch.finalHomeGoals,
      patch.finalAwayGoals === undefined ? null : patch.finalAwayGoals,
      patch.finalTotalGoals === undefined ? null : patch.finalTotalGoals,
      dt(patch.settledAt || new Date()),
      selectionId,
    ]
  );
}

async function getSelectionsForTicketIds(ticketIds) {
  if (!ticketIds || !ticketIds.length) return [];
  const placeholders = ticketIds.map(() => '?').join(',');
  return db.query(
    `SELECT * FROM ticket_selections WHERE ticket_id IN (${placeholders}) ORDER BY ticket_id DESC, position ASC`,
    ticketIds
  );
}

/* =====================================================================
 * RESULTS
 * ===================================================================*/

async function upsertResult(r) {
  return db.execute(
    `INSERT INTO results (fixture_id, status_short, status_long, goals_home, goals_away,
        total_goals, over15_result, settled, settled_at, source, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'api-football', ?)
     ON DUPLICATE KEY UPDATE
       status_short = VALUES(status_short), status_long = VALUES(status_long),
       goals_home = VALUES(goals_home), goals_away = VALUES(goals_away),
       total_goals = VALUES(total_goals), over15_result = VALUES(over15_result),
       settled = VALUES(settled), settled_at = VALUES(settled_at), raw_json = VALUES(raw_json)`,
    [
      r.fixtureId, r.statusShort || null, r.statusLong || null,
      r.goalsHome === undefined ? null : r.goalsHome,
      r.goalsAway === undefined ? null : r.goalsAway,
      r.totalGoals === undefined ? null : r.totalGoals,
      r.over15Result || null, r.settled ? 1 : 0, dt(r.settledAt || new Date()),
      r.rawJson ? JSON.stringify(r.rawJson) : null,
    ]
  );
}

async function getResultsByFixtureIds(fixtureIds) {
  if (!fixtureIds || !fixtureIds.length) return [];
  const placeholders = fixtureIds.map(() => '?').join(',');
  return db.query(`SELECT * FROM results WHERE fixture_id IN (${placeholders})`, fixtureIds);
}

/* =====================================================================
 * SETTINGS
 * ===================================================================*/

async function getAllSettings() {
  return db.query(`SELECT * FROM settings ORDER BY group_name ASC, setting_key ASC`);
}

async function getSetting(key) {
  return db.queryOne(`SELECT * FROM settings WHERE setting_key = ?`, [key]);
}

async function getSettingsVersion() {
  const row = await db.queryOne(`SELECT MAX(updated_at) AS v, COUNT(*) AS total FROM settings`);
  return `${row?.total || 0}:${row?.v ? new Date(row.v).getTime() : 0}`;
}

async function upsertSetting(s, adminId = null) {
  return db.execute(
    `INSERT INTO settings (setting_key, setting_value, value_type, group_name, label, description, is_locked, min_value, max_value, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       setting_value = VALUES(setting_value),
       value_type = VALUES(value_type),
       group_name = VALUES(group_name),
       label = VALUES(label),
       description = VALUES(description),
       is_locked = VALUES(is_locked),
       min_value = VALUES(min_value),
       max_value = VALUES(max_value),
       updated_by = VALUES(updated_by)`,
    [
      s.key, s.value === null || s.value === undefined ? null : String(s.value),
      s.type || 'string', s.group || 'general', s.label || null, s.description || null,
      s.isLocked ? 1 : 0, s.min ?? null, s.max ?? null, adminId,
    ]
  );
}

async function updateSettingValue(key, value, adminId) {
  return db.execute(
    `UPDATE settings SET setting_value = ?, updated_by = ? WHERE setting_key = ?`,
    [value === null || value === undefined ? null : String(value), adminId || null, key]
  );
}

/* =====================================================================
 * API SYNC LOGS
 * ===================================================================*/

async function insertApiSyncLog(log) {
  const res = await db.execute(
    `INSERT INTO api_sync_logs (job, trigger_source, status, endpoint_calls, rows_written, rows_read,
        requests_used, requests_limit, message, error_detail, duration_ms, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      log.job, log.triggerSource || 'cron', log.status || 'SUCCESS', log.endpointCalls || 0,
      log.rowsWritten || 0, log.rowsRead || 0, log.requestsUsed ?? null, log.requestsLimit ?? null,
      log.message || null, log.errorDetail || null, log.durationMs ?? null,
      dt(log.startedAt || new Date()), log.finishedAt ? dt(log.finishedAt) : null,
    ]
  );
  return res.insertId;
}

async function finishApiSyncLog(id, patch) {
  return db.execute(
    `UPDATE api_sync_logs SET status = ?, endpoint_calls = ?, rows_written = ?, rows_read = ?,
        requests_used = ?, requests_limit = ?, message = ?, error_detail = ?, duration_ms = ?, finished_at = ?
      WHERE id = ?`,
    [
      patch.status, patch.endpointCalls || 0, patch.rowsWritten || 0, patch.rowsRead || 0,
      patch.requestsUsed ?? null, patch.requestsLimit ?? null, patch.message || null,
      patch.errorDetail || null, patch.durationMs ?? null, dt(patch.finishedAt || new Date()), id,
    ]
  );
}

async function getApiSyncLogs(limit = 50, job = null) {
  const params = [];
  let where = '';
  if (job) { where = ' WHERE job = ?'; params.push(job); }
  return db.query(
    `SELECT * FROM api_sync_logs${where} ORDER BY started_at DESC${db.limitClause(limit)}`,
    params
  );
}

/* =====================================================================
 * GENERATION LOGS
 * ===================================================================*/

async function insertGenerationLog(log) {
  const res = await db.execute(
    `INSERT INTO generation_logs (ticket_id, ticket_date, trigger_source, admin_id, status,
        progress_step, progress_json, settings_snapshot_json, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      log.ticketId || null, d(log.ticketDate), log.triggerSource, log.adminId || null, log.status,
      log.progressStep || null, log.progressJson ? JSON.stringify(log.progressJson) : null,
      log.settingsSnapshot ? JSON.stringify(log.settingsSnapshot) : null, dt(log.startedAt || new Date()),
    ]
  );
  return res.insertId;
}

async function updateGenerationLog(id, patch) {
  const fields = [];
  const params = [];
  const map = {
    ticketId: 'ticket_id', status: 'status', progressStep: 'progress_step',
    fixturesScanned: 'fixtures_scanned', over15Candidates: 'over15_candidates',
    verifiedOdds: 'verified_odds', rejectedMatches: 'rejected_matches',
    rejectedNoOdds: 'rejected_no_odds', rejectedLowConfidence: 'rejected_low_confidence',
    rejectedHighRisk: 'rejected_high_risk', rejectedLowQuality: 'rejected_low_quality',
    rejectedInsufficientData: 'rejected_insufficient_data', rejectedFixtureState: 'rejected_fixture_state',
    rejectedStaleOdds: 'rejected_stale_odds', correlationRejected: 'correlation_rejected',
    confidenceQualified: 'confidence_qualified', riskQualified: 'risk_qualified',
    finalCandidates: 'final_candidates', combinationsTested: 'combinations_tested',
    qualifiedCombinations: 'qualified_combinations', selectedPicks: 'selected_picks',
    totalOdds: 'total_odds', durationMs: 'duration_ms', errorDetail: 'error_detail',
  };
  for (const [key, column] of Object.entries(map)) {
    if (patch[key] !== undefined) {
      fields.push(`${column} = ?`);
      params.push(patch[key]);
    }
  }
  if (patch.progressJson !== undefined) {
    fields.push('progress_json = ?');
    params.push(JSON.stringify(patch.progressJson));
  }
  if (patch.reportJson !== undefined) {
    fields.push('report_json = ?');
    params.push(JSON.stringify(patch.reportJson));
  }
  if (patch.finishedAt !== undefined) {
    fields.push('finished_at = ?');
    params.push(dt(patch.finishedAt));
  }
  if (!fields.length) return { affectedRows: 0 };
  params.push(id);
  return db.execute(`UPDATE generation_logs SET ${fields.join(', ')} WHERE id = ?`, params);
}

async function getGenerationLog(id) {
  return db.queryOne(`SELECT * FROM generation_logs WHERE id = ?`, [id]);
}

async function getGenerationLogByDate(date) {
  return db.queryOne(
    `SELECT * FROM generation_logs WHERE ticket_date = ? ORDER BY started_at DESC${db.limitClause(1)}`,
    [d(date)]
  );
}

async function listGenerationLogs(limit = 50) {
  return db.query(`SELECT * FROM generation_logs ORDER BY started_at DESC${db.limitClause(limit)}`);
}

/* =====================================================================
 * SYSTEM LOGS
 * ===================================================================*/

async function insertSystemLog(entry) {
  return db.execute(
    `INSERT INTO system_logs (level, channel, event, message, actor_type, actor_id, ip_address, user_agent, context_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.level || 'info', entry.channel || 'app', entry.event, entry.message || null,
      entry.actorType || null, entry.actorId || null, entry.ipAddress || null,
      entry.userAgent ? String(entry.userAgent).slice(0, 255) : null,
      entry.context ? JSON.stringify(entry.context) : null,
    ]
  );
}

async function querySystemLogs({ level = null, channel = null, event = null, from = null, to = null, limit = 100, offset = 0 } = {}) {
  const params = [];
  let where = ' WHERE 1=1';
  if (level) { where += ' AND level = ?'; params.push(level); }
  if (channel) { where += ' AND channel = ?'; params.push(channel); }
  if (event) { where += ' AND event = ?'; params.push(event); }
  if (from) { where += ' AND created_at >= ?'; params.push(dt(from)); }
  if (to) { where += ' AND created_at <= ?'; params.push(dt(to)); }
  return db.query(`SELECT * FROM system_logs${where} ORDER BY id DESC${db.limitClause(limit, offset)}`, params);
}

/**
 * Audit entries that belong to ONE actor (a member account or an administrator).
 *
 * `actorType` and `actorId` are always taken from the verified session on the
 * server — never from the request — so a signed-in member can only ever read
 * their own activity feed. Indexed by `idx_logs_actor (actor_type, actor_id)`.
 */
async function listActorSystemLogs(actorType, actorId, limit = 25) {
  return db.query(
    `SELECT * FROM system_logs WHERE 1=1 AND actor_type = ? AND actor_id = ? ORDER BY id DESC${db.limitClause(limit)}`,
    [actorType, actorId]
  );
}

async function countActorSystemLogs(actorType, actorId) {
  const row = await db.queryOne(
    `SELECT COUNT(*) AS total FROM system_logs WHERE 1=1 AND actor_type = ? AND actor_id = ?`,
    [actorType, actorId]
  );
  return Number(row?.total || 0);
}

async function countSystemLogs({ level = null, channel = null, from = null, to = null } = {}) {
  const params = [];
  let where = ' WHERE 1=1';
  if (level) { where += ' AND level = ?'; params.push(level); }
  if (channel) { where += ' AND channel = ?'; params.push(channel); }
  if (from) { where += ' AND created_at >= ?'; params.push(dt(from)); }
  if (to) { where += ' AND created_at <= ?'; params.push(dt(to)); }
  const row = await db.queryOne(`SELECT COUNT(*) AS total FROM system_logs${where}`, params);
  return Number(row?.total || 0);
}

/* =====================================================================
 * ADMINS / USERS
 * ===================================================================*/

async function getAdminByLogin(login) {
  return db.queryOne(`SELECT * FROM admins WHERE email = ? OR username = ?`, [login, login]);
}

async function getAdminById(id) {
  return db.queryOne(`SELECT * FROM admins WHERE id = ?`, [id]);
}

async function listAdmins() {
  return db.query(
    `SELECT id, email, username, role, is_active, last_login_at, last_login_ip, must_change_password, created_at
       FROM admins ORDER BY id ASC`
  );
}

async function createAdmin(a) {
  const res = await db.execute(
    `INSERT INTO admins (email, username, password_hash, role, is_active, must_change_password)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [a.email, a.username, a.passwordHash, a.role || 'admin', a.isActive === false ? 0 : 1, a.mustChangePassword ? 1 : 0]
  );
  return res.insertId;
}

async function updateAdminPassword(id, passwordHash) {
  return db.execute(
    `UPDATE admins SET password_hash = ?, must_change_password = 0 WHERE id = ?`,
    [passwordHash, id]
  );
}

async function recordAdminLoginSuccess(id, ip) {
  return db.execute(
    `UPDATE admins SET failed_logins = 0, locked_until = NULL, last_login_at = ?, last_login_ip = ? WHERE id = ?`,
    [dt(new Date()), ip || null, id]
  );
}

async function recordAdminLoginFailure(id, ip, lockUntil) {
  return db.execute(
    `UPDATE admins SET failed_logins = failed_logins + 1, locked_until = ?, last_login_ip = ? WHERE id = ?`,
    [lockUntil ? dt(lockUntil) : null, ip || null, id]
  );
}

async function getUserByLogin(login) {
  return db.queryOne(`SELECT * FROM users WHERE email = ? OR username = ?`, [login, login]);
}

async function getUserById(id) {
  return db.queryOne(`SELECT * FROM users WHERE id = ?`, [id]);
}

async function createUser(u) {
  const res = await db.execute(
    `INSERT INTO users (email, username, full_name, password_hash, role, is_active, status) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      u.email,
      u.username,
      u.fullName || '',
      u.passwordHash,
      u.role || 'user',
      u.isActive === false ? 0 : 1,
      u.status || 'pending',
    ]
  );
  return res.insertId;
}

async function recordUserLoginSuccess(id, ip) {
  return db.execute(
    `UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ?, last_login_ip = ? WHERE id = ?`,
    [dt(new Date()), ip || null, id]
  );
}

async function recordUserLoginFailure(id, ip, lockUntil) {
  return db.execute(
    `UPDATE users SET failed_logins = failed_logins + 1, locked_until = ?, last_login_ip = ? WHERE id = ?`,
    [lockUntil ? dt(lockUntil) : null, ip || null, id]
  );
}

async function updateUserPassword(id, passwordHash) {
  return db.execute(`UPDATE users SET password_hash = ? WHERE id = ?`, [passwordHash, id]);
}

/* =====================================================================
 * USER MANAGEMENT (admin approval workflow)
 * Every statement is parameterised; LIMIT/OFFSET go through limitClause
 * after integer validation. Password hashes are NEVER selected here.
 * ===================================================================*/

const USER_LIST_COLUMNS = `id, username, full_name, email, role, status, is_active,
  approved_at, approved_by_admin_id, status_reason, status_changed_at, last_login_at, created_at`;

function userFilterWhere({ status = null, search = null } = {}) {
  const params = [];
  let where = ' WHERE 1=1';
  if (status) {
    where += ' AND status = ?';
    params.push(status);
  }
  if (search) {
    // search by username, full name, e-mail or exact user id
    where += ' AND (username LIKE ? OR full_name LIKE ? OR email LIKE ? OR CAST(id AS CHAR) = ?)';
    const like = `%${search}%`;
    params.push(like, like, like, String(search));
  }
  return { where, params };
}

/** Paginated, filterable, searchable user list — never includes password_hash. */
async function listUsers({ status = null, search = null, limit = 25, offset = 0 } = {}) {
  const { where, params } = userFilterWhere({ status, search });
  return db.query(
    `SELECT ${USER_LIST_COLUMNS} FROM users${where}
      ORDER BY created_at DESC, id DESC${db.limitClause(limit, offset)}`,
    params
  );
}

async function countUsers({ status = null, search = null } = {}) {
  const { where, params } = userFilterWhere({ status, search });
  const row = await db.queryOne(`SELECT COUNT(*) AS total FROM users${where}`, params);
  return Number(row?.total || 0);
}

/** Summary counters for the user management dashboard cards. */
async function getUserSummary() {
  const row = await db.queryOne(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'pending'   THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN status = 'approved'  THEN 1 ELSE 0 END) AS approved,
            SUM(CASE WHEN status = 'rejected'  THEN 1 ELSE 0 END) AS rejected,
            SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END) AS suspended
       FROM users`
  );
  return {
    total: Number(row?.total || 0),
    pending: Number(row?.pending || 0),
    approved: Number(row?.approved || 0),
    rejected: Number(row?.rejected || 0),
    suspended: Number(row?.suspended || 0),
  };
}

/**
 * Apply an administrative status decision. The caller (controller) decides
 * every value — nothing here is taken from the request. `run` defaults to
 * the shared pool and may be a transaction connection.
 */
async function setUserStatus(id, patch, run = db) {
  return run.execute(
    `UPDATE users
        SET status = ?, is_active = ?, approved_at = ?, approved_by_admin_id = ?,
            status_reason = ?, status_changed_at = ?
      WHERE id = ?`,
    [
      patch.status,
      patch.isActive ? 1 : 0,
      dt(patch.approvedAt),
      patch.approvedByAdminId ?? null,
      patch.reason || null,
      dt(new Date()),
      id,
    ]
  );
}

async function insertUserAuditLog(entry, run = db) {
  const res = await run.execute(
    `INSERT INTO user_audit_logs (user_id, admin_id, action, previous_status, new_status, reason, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.userId,
      entry.adminId ?? null,
      entry.action,
      entry.previousStatus || null,
      entry.newStatus,
      entry.reason || null,
      entry.ipAddress || null,
      entry.userAgent ? String(entry.userAgent).slice(0, 255) : null,
    ]
  );
  return res.insertId;
}

/**
 * Apply a status decision AND its audit row in ONE transaction: either both
 * writes land or neither does.
 */
async function applyUserStatusDecision(id, patch, auditEntry) {
  return db.transaction(async (tx) => {
    await setUserStatus(id, patch, tx);
    return insertUserAuditLog(auditEntry, tx);
  });
}

async function listUserAuditLogs(userId, limit = 50) {
  return db.query(
    `SELECT * FROM user_audit_logs WHERE user_id = ? ORDER BY id DESC${db.limitClause(limit)}`,
    [userId]
  );
}

/* =====================================================================
 * ANALYTICS
 * ===================================================================*/

async function getTicketAnalytics() {
  return db.queryOne(
    `SELECT
        COUNT(*) AS total_tickets,
        SUM(CASE WHEN status = 'QUALIFIED' THEN 1 ELSE 0 END) AS qualified_tickets,
        SUM(CASE WHEN status = 'NO_QUALIFYING_TICKET' THEN 1 ELSE 0 END) AS no_ticket_days,
        SUM(CASE WHEN result = 'WON' THEN 1 ELSE 0 END) AS won_tickets,
        SUM(CASE WHEN result = 'LOST' THEN 1 ELSE 0 END) AS lost_tickets,
        SUM(CASE WHEN result = 'VOID' THEN 1 ELSE 0 END) AS void_tickets,
        SUM(CASE WHEN result = 'PENDING' THEN 1 ELSE 0 END) AS pending_tickets,
        SUM(selection_count) AS total_selections,
        AVG(CASE WHEN status = 'QUALIFIED' THEN total_odds END) AS avg_ticket_odds,
        MAX(CASE WHEN status = 'QUALIFIED' THEN total_odds END) AS highest_ticket_odds,
        MIN(CASE WHEN status = 'QUALIFIED' AND selection_count > 0 THEN total_odds END) AS lowest_ticket_odds,
        AVG(CASE WHEN status = 'QUALIFIED' THEN avg_confidence END) AS avg_confidence
       FROM tickets`
  );
}

async function getSelectionAnalytics() {
  return db.queryOne(
    `SELECT
        COUNT(*) AS total_selections,
        SUM(CASE WHEN result = 'WON' THEN 1 ELSE 0 END) AS won,
        SUM(CASE WHEN result = 'LOST' THEN 1 ELSE 0 END) AS lost,
        SUM(CASE WHEN result IN ('VOID','POSTPONED') THEN 1 ELSE 0 END) AS voided,
        SUM(CASE WHEN result = 'PENDING' THEN 1 ELSE 0 END) AS pending,
        AVG(CASE WHEN result IN ('WON','LOST') THEN confidence END) AS avg_confidence_settled,
        AVG(odd_decimal) AS avg_selection_odds
       FROM ticket_selections`
  );
}

/** Every settled pick in the whole platform (Over 1.5 hit rate). */
async function getOver15OutcomeCounts() {
  return db.queryOne(
    `SELECT
        SUM(CASE WHEN over15_result = 'WON' THEN 1 ELSE 0 END) AS won,
        SUM(CASE WHEN over15_result = 'LOST' THEN 1 ELSE 0 END) AS lost,
        SUM(CASE WHEN over15_result IN ('VOID','POSTPONED') THEN 1 ELSE 0 END) AS voided,
        COUNT(*) AS settled_total
       FROM results WHERE settled = 1`
  );
}

async function getMonthlyTicketStats(months = 12) {
  // `months` is an integer validated here and inlined: INTERVAL placeholders
  // are not reliably supported by prepared statements on MariaDB 10.3.
  const window = Number.isInteger(months) && months > 0 && months <= 120 ? months : 12;
  return db.query(
    `SELECT DATE_FORMAT(ticket_date, '%Y-%m') AS month,
            COUNT(*) AS tickets,
            SUM(CASE WHEN status = 'QUALIFIED' THEN 1 ELSE 0 END) AS qualified,
            SUM(CASE WHEN result = 'WON' THEN 1 ELSE 0 END) AS won,
            SUM(CASE WHEN result = 'LOST' THEN 1 ELSE 0 END) AS lost,
            SUM(CASE WHEN result = 'VOID' THEN 1 ELSE 0 END) AS voided,
            SUM(selection_count) AS selections,
            AVG(CASE WHEN status = 'QUALIFIED' THEN total_odds END) AS avg_odds
       FROM tickets
      WHERE ticket_date >= DATE_SUB(CURDATE(), INTERVAL ${window} MONTH)
      GROUP BY DATE_FORMAT(ticket_date, '%Y-%m')
      ORDER BY month DESC${db.limitClause(window)}`,
    []
  );
}

/** Chronological settled ticket results — streaks are derived in the service. */
async function getSettledTicketSequence() {
  return db.query(
    `SELECT ticket_date, result, total_odds, selection_count
       FROM tickets
      WHERE result IN ('WON','LOST')
      ORDER BY ticket_date ASC, id ASC`
  );
}

module.exports = {
  // leagues
  upsertLeague, getLeagueById, getAllLeagues, updateLeagueGoalEnvironment,
  // teams
  upsertTeam, getTeamsByIds,
  // fixtures
  upsertFixture, getFixtureById, getFixturesByIds, getFixturesBetween,
  getPlayableFixturesBetween, getRecentFinishedByTeam, getH2HFixtures,
  getLeagueFinishedMatches, getFixturesAwaitingResult, countFixturesBetween,
  // bookmakers
  upsertBookmaker, getBookmakers,
  // odds
  upsertOdds, getVerifiedOver15Odds, getOddsForFixture, getOddsForFixtures,
  getOddsFreshness, countVerifiedOver15Odds,
  // predictions
  upsertPrediction, replacePredictionScores, getPredictionScores, getPredictionsForFixtures,
  getPredictionsByDateRange, countPredictionsByDateRange, getRejectionBreakdown,
  // team form
  upsertTeamForm, getTeamForms,
  // tickets
  getTicketByDate, getTicketById, createTicket, insertSelections, getSelectionsByTicket,
  listTickets, countTickets, updateTicketResult, deleteTicketById, getSelectionsForTicketIds,
  // settlement
  getPendingSelections, updateSelectionResult, upsertResult, getResultsByFixtureIds,
  // settings
  getAllSettings, getSetting, getSettingsVersion, upsertSetting, updateSettingValue,
  // logs
  insertApiSyncLog, finishApiSyncLog, getApiSyncLogs,
  insertGenerationLog, updateGenerationLog, getGenerationLog, getGenerationLogByDate, listGenerationLogs,
  insertSystemLog, querySystemLogs, countSystemLogs,
  listActorSystemLogs, countActorSystemLogs,
  // auth
  getAdminByLogin, getAdminById, listAdmins, createAdmin, updateAdminPassword,
  recordAdminLoginSuccess, recordAdminLoginFailure,
  getUserByLogin, getUserById, createUser, recordUserLoginSuccess, recordUserLoginFailure, updateUserPassword,
  // user management (admin approval workflow)
  listUsers, countUsers, getUserSummary, setUserStatus, insertUserAuditLog, applyUserStatusDecision, listUserAuditLogs,
  // analytics
  getTicketAnalytics, getSelectionAnalytics, getOver15OutcomeCounts,
  getMonthlyTicketStats, getSettledTicketSequence,
};
