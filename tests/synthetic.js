'use strict';

/**
 * Synthetic TEST data only. Nothing here is ever shipped as real content —
 * it exists so the pipeline, validator and HTTP layer can be exercised
 * without touching API-Football or a live database.
 */

const HOUR = 3600000;

function isoMinutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60000).toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Kickoffs are anchored to 12:00 / 15:00 / 18:00 UTC of the next usable UTC
 * day, so a run started at any hour still finds every fixture inside the same
 * ticket date and comfortably in the future.
 */
function targetDay(now = new Date()) {
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 0, 0));
  if (base.getTime() - now.getTime() < 3600000) base.setUTCDate(base.getUTCDate() + 1);
  return base;
}

function kickoffAt(hourIndex, now = new Date()) {
  const day = targetDay(now);
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 12 + hourIndex * 3, 0, 0));
}

function mysqlDateFrom(date) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function mysqlDate(offsetMinutes = 0) {
  return new Date(Date.now() + offsetMinutes * 60000).toISOString().replace('T', ' ').slice(0, 19);
}

function todayUtc() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Three strong Over 1.5 candidates with real-shaped odds payloads. */
function buildScenario({ oddsValues = ['1.28', '1.30', '1.32'], updateMinutesAgo = 5 } = {}) {
  const teams = [
    { id: 11, name: 'Northbridge FC' },
    { id: 12, name: 'Harbour United' },
    { id: 21, name: 'Riverside Rovers' },
    { id: 22, name: 'Kestrel Town' },
    { id: 31, name: 'Millstone Athletic' },
    { id: 32, name: 'Vale Wanderers' },
  ];

  const leagues = [
    { id: 39, name: 'Test Premier League', country: 'Testland' },
    { id: 40, name: 'Test Championship', country: 'Northmark' },
    { id: 41, name: 'Test Serie Alfa', country: 'Vessonia' },
  ];

  const fixtures = [
    { id: 1001, league: 39, home: 11, away: 12, hourIndex: 0 },
    { id: 1002, league: 40, home: 21, away: 22, hourIndex: 1 },
    { id: 1003, league: 41, home: 31, away: 32, hourIndex: 2 },
  ].map((f, index) => {
    const league = leagues.find((l) => l.id === f.league);
    const kickoff = kickoffAt(f.hourIndex);
    return {
      id: f.id,
      league_id: league.id,
      league_season: 2026,
      league_round: 'Regular Season - 10',
      home_team_id: f.home,
      away_team_id: f.away,
      home_team_name: teams.find((t) => t.id === f.home).name,
      away_team_name: teams.find((t) => t.id === f.away).name,
      league_name: league.name,
      league_country: league.country,
      league_logo: null,
      home_logo: null,
      away_logo: null,
      venue_name: 'Test Arena',
      venue_city: 'Testville',
      referee: null,
      kickoff_at: mysqlDateFrom(kickoff),
      kickoff_tz: 'UTC',
      status_long: 'Not Started',
      status_short: 'NS',
      status_elapsed: null,
      is_playable: 1,
      is_finished: 0,
      goals_home: null,
      goals_away: null,
      api_timestamp: mysqlDateFrom(kickoff),
      fetched_at: isoMinutesAgo(10),
      oddValue: oddsValues[index],
      kickoffDate: kickoff,
    };
  });

  /** API-Football /odds shaped payloads (bookmakers + Over/Under values). */
  const oddsPayloads = fixtures.map((f) => ({
    fixture: { id: f.id, timestamp: f.kickoffDate.toISOString() },
    league: {
      id: f.league_id,
      name: f.league_name,
      country: f.league_country,
      season: 2026,
    },
    update: new Date(Date.now() - updateMinutesAgo * 60000).toISOString(),
    bookmakers: [
      {
        id: 8,
        name: 'Bet365',
        bets: [
          {
            name: 'Match Winner',
            values: [
              { value: 'Home', odd: '2.10' },
              { value: 'Draw', odd: '3.40' },
              { value: 'Away', odd: '3.10' },
            ],
          },
          {
            name: 'Over/Under',
            values: [
              { value: 'Over 0.5', odd: '1.05' },
              { value: 'Under 0.5', odd: '9.50' },
              { value: 'Over 1.5', odd: f.oddValue },
              { value: 'Under 1.5', odd: '3.60' },
              { value: 'Over 2.5', odd: '1.80' },
              { value: 'Under 2.5', odd: '1.95' },
            ],
          },
          {
            name: 'Both Teams Score',
            values: [
              { value: 'Yes', odd: '1.70' },
              { value: 'No', odd: '2.05' },
            ],
          },
        ],
      },
      {
        id: 4,
        name: 'Pinnacle',
        bets: [
          {
            name: 'Over/Under',
            values: [
              { value: 'Over 1.5', odd: (Number(f.oddValue) - 0.02).toFixed(2) },
              { value: 'Over 2.5', odd: '1.78' },
            ],
          },
        ],
      },
      {
        id: 6,
        name: 'Bwin',
        bets: [
          {
            name: 'Total Goals',
            values: [
              { value: 'Over 1.5', odd: (Number(f.oddValue) - 0.01).toFixed(2) },
              { value: 'Under 1.5', odd: '3.55' },
            ],
          },
        ],
      },
    ],
  }));

  /** team_form rows strong enough to clear the quality / confidence gates. */
  const teamForms = [];
  for (const team of teams) {
    for (const [scope, matches] of [['all', 10], ['home', 6], ['away', 6]]) {
      for (const window of [5, 10]) {
        teamForms.push({
          team_id: team.id,
          scope,
          window_matches: window,
          matches_played: window === 5 ? 5 : matches,
          goals_for: 21,
          goals_against: 14,
          avg_goals_for: '2.100',
          avg_goals_against: '1.400',
          over15_hits: Math.round(0.85 * (window === 5 ? 5 : matches)),
          over15_rate: '85.00',
          over25_hits: 6,
          clean_sheets: 1,
          failed_to_score: 1,
          wins: 6,
          draws: 2,
          losses: 2,
          form_string: 'WWDWLWWLWW',
          total_goals_stddev: '0.900',
          last_match_at: isoMinutesAgo(2880),
        });
      }
    }
  }

  const leagueEnvs = leagues.map((l) => ({
    id: l.id,
    name: l.name,
    country: l.country,
    logo: null,
    avg_total_goals: '3.050',
    avg_home_goals: '1.750',
    avg_away_goals: '1.300',
    over15_rate: '86.00',
    sample_matches: 140,
  }));

  const ticketDate = fixtures[0].kickoff_at.slice(0, 10);
  return { teams, leagues, fixtures, oddsPayloads, teamForms, leagueEnvs, ticketDate };
}

/**
 * Minimal API-Football double with the same interface as the real client.
 */
class FakeApi {
  constructor(scenario, { configured = true, available = true } = {}) {
    this.scenario = scenario;
    this.configured = configured;
    this._available = available;
    this.calls = [];
    this.stats = { calls: 0, failures: 0, cacheHits: 0, quota: null };
    this.host = 'fake.api-football.test';
    this.baseUrl = 'https://fake.api-football.test/v3';
  }

  isAvailable() {
    return this.configured && this._available;
  }

  breakerState() {
    return { state: this.isAvailable() ? 'OK' : 'OPEN', available: this.isAvailable(), quota: null };
  }

  _record(endpoint) {
    this.calls.push(endpoint);
  }

  async getStatus() {
    this._record('/status');
    return { requests: { current: 40, limit_day: 7500 } };
  }

  async getFixturesByDate(date) {
    this._record(`/fixtures?date=${date}`);
    return { response: [], results: 0, paging: { current: 1, total: 1 } };
  }

  async getOddsByDate(date, page = 1) {
    this._record(`/odds?date=${date}&page=${page}`);
    return { response: this.scenario.oddsPayloads, results: this.scenario.oddsPayloads.length, paging: { current: 1, total: 1 } };
  }

  async getOddsByFixture(fixtureId) {
    this._record(`/odds?fixture=${fixtureId}`);
    const payload = this.scenario.oddsPayloads.find((p) => p.fixture.id === Number(fixtureId));
    return { response: payload ? [payload] : [], results: payload ? 1 : 0, paging: { current: 1, total: 1 } };
  }

  async getInjuriesByFixture() {
    this._record('/injuries');
    return { response: [], results: 0, paging: { current: 1, total: 1 } };
  }

  async getHeadToHead() {
    this._record('/fixtures/headtohead');
    return { response: [], results: 0, paging: { current: 1, total: 1 } };
  }
}

module.exports = { buildScenario, FakeApi, isoMinutesAgo, mysqlDate, mysqlDateFrom, kickoffAt, targetDay, todayUtc, HOUR };
