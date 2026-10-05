'use strict';

/**
 * In-memory database double for integration tests.
 *
 * It replaces the exported functions of server/database/connection.js with
 * handlers that recognise the SQL used by the code under test. Tests stay
 * honest because the SQL still comes from server/database/queries.js — only
 * the storage engine is faked. Production always uses MySQL/MariaDB.
 */

const connection = require('../server/database/connection');

function nowIso() {
  return new Date().toISOString();
}

function install(overrides = {}) {
  const store = {
    admins: overrides.admins || [
      { id: 1, email: 'admin@test.local', username: 'admin', password_hash: 'x', role: 'superadmin', is_active: 1, locked_until: null, must_change_password: 0 },
    ],
    settings: overrides.settings || [],
    generationLogs: overrides.generationLogs || [],
    tickets: overrides.tickets || [],
    selections: overrides.selections || [],
    fixtures: overrides.fixtures || [],
    odds: overrides.odds || [],
    teamForms: overrides.teamForms || [],
    leagues: overrides.leagues || [],
    predictions: overrides.predictions || [],
    results: overrides.results || [],
    systemLogs: overrides.systemLogs || [],
    apiSyncLogs: overrides.apiSyncLogs || [],
    users: overrides.users || [],
    ids: 1000,
  };

  const nextId = () => {
    store.ids += 1;
    return store.ids;
  };

  async function query(sql, params = []) {
    const s = String(sql).replace(/\s+/g, ' ').trim();

    if (/^SELECT \* FROM admins WHERE id = \?/.test(s)) return store.admins.filter((a) => a.id === Number(params[0]));
    if (/^SELECT \* FROM admins WHERE email = \? OR username = \?/.test(s)) {
      return store.admins.filter((a) => a.email === params[0] || a.username === params[0]);
    }
    if (/^SELECT \* FROM users WHERE id = \?/.test(s)) return store.users.filter((u) => u.id === Number(params[0]));
    if (/^SELECT \* FROM users WHERE email = \? OR username = \?/.test(s)) {
      return store.users.filter((u) => u.email === params[0] || u.username === params[0]);
    }
    if (/^SELECT \* FROM settings/.test(s)) return store.settings;
    if (/^SELECT \* FROM leagues/.test(s)) return store.leagues;
    if (/^SELECT id FROM predictions/.test(s)) {
      const row = store.predictions.find((p) => Number(p.fixture_id) === Number(params[0]));
      return [{ id: row ? row.id : nextId() }];
    }
    if (/^SELECT \* FROM predictions/.test(s)) return store.predictions;
    if (/^SELECT \* FROM team_form/.test(s)) {
      const ids = params.slice(0, -2).map(Number);
      const scope = params[params.length - 2];
      const window = Number(params[params.length - 1]);
      return store.teamForms.filter((t) => ids.includes(Number(t.team_id)) && t.scope === scope && Number(t.window_matches) === window);
    }
    if (/^SELECT \* FROM generation_logs WHERE id = \?/.test(s)) return store.generationLogs.filter((g) => g.id === Number(params[0]));
    if (/^SELECT \* FROM generation_logs WHERE ticket_date = \?/.test(s)) return store.generationLogs.filter((g) => String(g.ticket_date).slice(0, 10) === String(params[0]).slice(0, 10));
    if (/^SELECT \* FROM generation_logs ORDER BY started_at DESC/.test(s)) return [...store.generationLogs].sort((a, b) => b.id - a.id).slice(0, Number(String(s).match(/LIMIT (\d+)/) ? String(s).match(/LIMIT (\d+)/)[1] : 50));
    if (/^SELECT t\.\*, \(SELECT COUNT/.test(s)) return store.tickets;
    if (/FROM tickets t LEFT JOIN generation_logs/.test(s) && /WHERE t\.ticket_date = \?/.test(s)) {
      return store.tickets.filter((t) => String(t.ticket_date).slice(0, 10) === String(params[0]).slice(0, 10));
    }
    if (/FROM tickets t LEFT JOIN generation_logs/.test(s) && /WHERE t\.id = \?/.test(s)) return store.tickets.filter((t) => t.id === Number(params[0]));
    if (/^SELECT \* FROM ticket_selections WHERE ticket_id = \?/.test(s)) return store.selections.filter((s2) => s2.ticket_id === Number(params[0]));
    if (/^SELECT \* FROM ticket_selections WHERE ticket_id IN/.test(s)) {
      return store.selections
        .filter((s2) => params.map(Number).includes(Number(s2.ticket_id)))
        .sort((a, b) => Number(b.ticket_id) - Number(a.ticket_id) || Number(a.position) - Number(b.position));
    }
    if (/^SELECT f\.\*, l\.name AS league_name/.test(s) && /is_playable = 1/.test(s)) {
      const from = params[0];
      const to = params[1];
      return store.fixtures.filter((f) => f.kickoff_at >= from && f.kickoff_at < to && Number(f.is_playable) === 1);
    }
    if (/^SELECT f\.\*, l\.name AS league_name/.test(s)) {
      const from = params[0];
      const to = params[1];
      return store.fixtures.filter((f) => f.kickoff_at >= from && f.kickoff_at < to);
    }
    if (/^SELECT o\.\*, b\.name AS bookmaker_display_name/.test(s)) {
      return store.odds
        .filter(
          (o) =>
            params.map(Number).includes(Number(o.fixture_id)) &&
            Number(o.is_verified) === 1 &&
            o.market_key === 'over_1_5' &&
            Number(o.goal_line) === 1.5 &&
            o.direction === 'over'
        )
        .sort((a, b) => Number(a.fixture_id) - Number(b.fixture_id) || Number(b.odd_decimal) - Number(a.odd_decimal));
    }
    if (/^SELECT \* FROM odds WHERE fixture_id = \?/.test(s)) return store.odds.filter((o) => o.fixture_id === Number(params[0]));
    if (/^SELECT \* FROM odds WHERE fixture_id IN/.test(s)) return store.odds.filter((o) => params.map(Number).includes(Number(o.fixture_id)));
    if (/^SELECT fixture_id, MAX\(fetched_at\)/.test(s)) return [];
    if (/^SELECT \* FROM fixtures WHERE id = \?/.test(s)) return store.fixtures.filter((f) => f.id === Number(params[0]));
    if (/^SELECT f\.id, f\.kickoff_at, f\.home_team_id/.test(s)) return []; // form/h2h lookups -> empty (DATA UNAVAILABLE paths)
    if (/^SELECT goals_home, goals_away/.test(s)) return [];
    if (/^SELECT \* FROM results WHERE fixture_id IN/.test(s)) {
      return store.results.filter((r) => params.map(Number).includes(Number(r.fixture_id)));
    }
    if (/^SELECT \* FROM results/.test(s)) return store.results;
    // pending legs joined with their ticket and fixture (settlement job)
    if (/^SELECT s\.\*, t\.ticket_date/.test(s)) {
      return store.selections
        .filter((sel) => sel.result === 'PENDING')
        .map((sel) => {
          const fixture = store.fixtures.find((f) => Number(f.id) === Number(sel.fixture_id)) || {};
          const ticket = store.tickets.find((t) => Number(t.id) === Number(sel.ticket_id)) || {};
          return {
            ...sel,
            ticket_date: ticket.ticket_date || null,
            fixture_status: fixture.status_short || null,
            fixture_finished: fixture.is_finished ?? 0,
          };
        })
        .filter((row) => {
          const fixture = store.fixtures.find((f) => Number(f.id) === Number(row.fixture_id));
          return !fixture || !params[0] || String(fixture.kickoff_at) < String(params[0]);
        });
    }
    if (/^SELECT COUNT\(\*\) AS total, SUM/.test(s)) {
      const from = params[0];
      const to = params[1];
      const rows = store.fixtures.filter((f) => f.kickoff_at >= from && f.kickoff_at < to);
      return [{ total: rows.length, playable: rows.filter((f) => Number(f.is_playable) === 1).length }];
    }
    if (/^SELECT COUNT\(\*\) AS total FROM tickets/.test(s)) return [{ total: store.tickets.length }];
    if (/^SELECT MAX\(updated_at\) AS v/.test(s)) return [{ v: nowIso(), total: store.settings.length }];
    /* ---------------- analytics aggregates ---------------- */
    if (/^SELECT COUNT\(\*\) AS total_tickets/.test(s)) {
      const rows = store.tickets;
      const sum = (fn) => (rows.length ? rows.reduce((acc, r) => acc + fn(r), 0) : null);
      const qualified = rows.filter((r) => r.status === 'QUALIFIED');
      const avg = (list, fn) => (list.length ? list.reduce((a, r) => a + fn(r), 0) / list.length : null);
      return [
        {
          total_tickets: rows.length,
          qualified_tickets: sum((r) => (r.status === 'QUALIFIED' ? 1 : 0)),
          no_ticket_days: sum((r) => (r.status === 'NO_QUALIFYING_TICKET' ? 1 : 0)),
          won_tickets: sum((r) => (r.result === 'WON' ? 1 : 0)),
          lost_tickets: sum((r) => (r.result === 'LOST' ? 1 : 0)),
          void_tickets: sum((r) => (r.result === 'VOID' ? 1 : 0)),
          pending_tickets: sum((r) => (r.result === 'PENDING' ? 1 : 0)),
          total_selections: sum((r) => Number(r.selection_count) || 0),
          avg_ticket_odds: avg(qualified, (r) => Number(r.total_odds) || 0),
          highest_ticket_odds: qualified.length ? Math.max(...qualified.map((r) => Number(r.total_odds) || 0)) : null,
          lowest_ticket_odds: qualified.length ? Math.min(...qualified.map((r) => Number(r.total_odds) || 0)) : null,
          avg_confidence: avg(qualified, (r) => Number(r.avg_confidence) || 0),
        },
      ];
    }
    if (/^SELECT COUNT\(\*\) AS total_selections/.test(s)) {
      const rows = store.selections;
      const sum = (fn) => (rows.length ? rows.reduce((acc, r) => acc + fn(r), 0) : null);
      const settled = rows.filter((r) => r.result === 'WON' || r.result === 'LOST');
      return [
        {
          total_selections: rows.length,
          won: sum((r) => (r.result === 'WON' ? 1 : 0)),
          lost: sum((r) => (r.result === 'LOST' ? 1 : 0)),
          voided: sum((r) => (r.result === 'VOID' || r.result === 'POSTPONED' ? 1 : 0)),
          pending: sum((r) => (r.result === 'PENDING' ? 1 : 0)),
          avg_confidence_settled: settled.length ? settled.reduce((a, r) => a + (Number(r.confidence) || 0), 0) / settled.length : null,
          avg_selection_odds: rows.length ? rows.reduce((a, r) => a + (Number(r.odd_decimal) || 0), 0) / rows.length : null,
        },
      ];
    }
    if (/^SELECT SUM\(CASE WHEN over15_result/.test(s)) {
      const rows = store.results.filter((r) => Number(r.settled) === 1);
      const count = (fn) => (rows.length ? rows.reduce((a, r) => a + (fn(r) ? 1 : 0), 0) : null);
      return [
        {
          won: count((r) => r.over15_result === 'WON'),
          lost: count((r) => r.over15_result === 'LOST'),
          voided: count((r) => r.over15_result === 'VOID' || r.over15_result === 'POSTPONED'),
          settled_total: rows.length,
        },
      ];
    }
    if (/^SELECT DATE_FORMAT\(ticket_date/.test(s)) {
      const months = new Map();
      for (const t of store.tickets) {
        const month = String(t.ticket_date).slice(0, 7);
        const entry = months.get(month) || { month, tickets: 0, qualified: 0, won: 0, lost: 0, voided: 0, selections: 0, odds: [] };
        entry.tickets += 1;
        if (t.status === 'QUALIFIED') {
          entry.qualified += 1;
          entry.odds.push(Number(t.total_odds) || 0);
        }
        if (t.result === 'WON') entry.won += 1;
        if (t.result === 'LOST') entry.lost += 1;
        if (t.result === 'VOID') entry.voided += 1;
        entry.selections += Number(t.selection_count) || 0;
        months.set(month, entry);
      }
      return [...months.values()]
        .sort((a, b) => (a.month < b.month ? 1 : -1))
        .map((m) => ({
          month: m.month,
          tickets: m.tickets,
          qualified: m.qualified,
          won: m.won,
          lost: m.lost,
          voided: m.voided,
          selections: m.selections,
          avg_odds: m.odds.length ? m.odds.reduce((a, b) => a + b, 0) / m.odds.length : null,
        }));
    }
    if (/^SELECT ticket_date, result, total_odds, selection_count/.test(s)) {
      return store.tickets
        .filter((t) => t.result === 'WON' || t.result === 'LOST')
        .sort((a, b) => (String(a.ticket_date) > String(b.ticket_date) ? 1 : -1))
        .map((t) => ({ ticket_date: t.ticket_date, result: t.result, total_odds: t.total_odds, selection_count: t.selection_count }));
    }
    if (/^SELECT COUNT\(DISTINCT o\.fixture_id\)/.test(s)) {
      const [from, to] = params;
      const rows = store.odds.filter((o) => {
        if (o.market_key !== 'over_1_5' || Number(o.is_verified) !== 1) return false;
        const fixture = store.fixtures.find((f) => Number(f.id) === Number(o.fixture_id));
        return fixture && String(fixture.kickoff_at) >= String(from) && String(fixture.kickoff_at) < String(to);
      });
      return [{ fixtures_with_odds: new Set(rows.map((r) => Number(r.fixture_id))).size, odds_rows: rows.length }];
    }

    /* ---------------- predictions ---------------- */
    if (/^SELECT p\.\*, f\.kickoff_at/.test(s)) {
      const [from, to] = params;
      const eligibleOnly = /p\.is_eligible = 1/.test(s);
      return store.predictions
        .map((p) => {
          const f = store.fixtures.find((x) => Number(x.id) === Number(p.fixture_id)) || {};
          const l = store.leagues.find((x) => Number(x.id) === Number(f.league_id)) || {};
          return {
            ...p,
            kickoff_at: f.kickoff_at || null,
            home_team_name: f.home_team_name || null,
            away_team_name: f.away_team_name || null,
            home_team_id: f.home_team_id ?? null,
            away_team_id: f.away_team_id ?? null,
            status_short: f.status_short || null,
            is_playable: f.is_playable ?? null,
            league_name: l.name || null,
            league_country: l.country || null,
            league_logo: l.logo_url || null,
            home_logo: null,
            away_logo: null,
          };
        })
        .filter((row) => String(row.kickoff_at) >= String(from) && String(row.kickoff_at) < String(to))
        .filter((row) => (eligibleOnly ? Number(row.is_eligible) === 1 : true))
        .sort((a, b) => (String(a.kickoff_at) > String(b.kickoff_at) ? 1 : -1));
    }
    if (/^SELECT COUNT\(\*\) AS total FROM predictions p JOIN fixtures f/.test(s)) {
      const [from, to] = params;
      const eligibleOnly = /p\.is_eligible = 1/.test(s);
      const total = store.predictions.filter((p) => {
        const f = store.fixtures.find((x) => Number(x.id) === Number(p.fixture_id));
        if (!f) return false;
        if (String(f.kickoff_at) < String(from) || String(f.kickoff_at) >= String(to)) return false;
        return eligibleOnly ? Number(p.is_eligible) === 1 : true;
      }).length;
      return [{ total }];
    }
    if (/^SELECT COALESCE\(p\.reject_reason/.test(s)) {
      const [from, to] = params;
      const out = new Map();
      for (const f of store.fixtures) {
        if (String(f.kickoff_at) < String(from) || String(f.kickoff_at) >= String(to)) continue;
        const p = store.predictions.find((x) => Number(x.fixture_id) === Number(f.id));
        const reason = (p && p.reject_reason) || 'NONE';
        out.set(reason, (out.get(reason) || 0) + 1);
      }
      return [...out.entries()].map(([reason, total]) => ({ reason, total }));
    }

    /* ---------------- fixtures awaiting settlement ---------------- */
    if (/^SELECT f\.\* FROM fixtures f/.test(s)) {
      const [from, to, now] = params;
      return store.fixtures.filter(
        (f) =>
          String(f.kickoff_at) >= String(from) &&
          String(f.kickoff_at) < String(to) &&
          Number(f.is_finished) === 0 &&
          String(f.kickoff_at) < String(now)
      );
    }
    /* ---------------- logs ---------------- */
    if (/^SELECT \* FROM system_logs/.test(s)) {
      const where = s.slice(s.indexOf('WHERE 1=1'), s.indexOf('ORDER BY'));
      const filters = [...where.matchAll(/AND (\w+) = \?/g)].map((m) => m[1]);
      let rows = store.systemLogs.slice();
      filters.forEach((field, idx) => {
        rows = rows.filter((row) => String(row[field]) === String(params[idx]));
      });
      const limitMatch = s.match(/LIMIT (\d+)/);
      return rows.sort((a, b) => Number(b.id) - Number(a.id)).slice(0, limitMatch ? Number(limitMatch[1]) : 100);
    }
    if (/^SELECT COUNT\(\*\) AS total FROM system_logs/.test(s)) {
      const where = s.slice(s.indexOf('WHERE 1=1'));
      const filters = [...where.matchAll(/AND (\w+) = \?/g)].map((m) => m[1]);
      let rows = store.systemLogs;
      filters.forEach((field, idx) => {
        rows = rows.filter((row) => String(row[field]) === String(params[idx]));
      });
      return [{ total: rows.length }];
    }
    if (/^SELECT \* FROM api_sync_logs/.test(s)) {
      const rows = /WHERE job = \?/.test(s) ? store.apiSyncLogs.filter((r) => r.job === params[0]) : store.apiSyncLogs;
      const limitMatch = s.match(/LIMIT (\d+)/);
      return rows
        .slice()
        .sort((a, b) => Number(b.id) - Number(a.id))
        .slice(0, limitMatch ? Number(limitMatch[1]) : 50);
    }
    if (/^SHOW TABLES/.test(s)) return [];
    if (/^SELECT 1/.test(s)) return [{ 1: 1 }];
    return [];
  }

  async function queryOne(sql, params = []) {
    const rows = await query(sql, params);
    return rows && rows.length ? rows[0] : null;
  }

  async function execute(sql, params = []) {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    if (/^INSERT INTO users/.test(s)) {
      const id = nextId();
      store.users.push({
        id,
        email: params[0],
        username: params[1],
        password_hash: params[2],
        role: params[3] || 'user',
        is_active: params[4] === undefined ? 1 : Number(params[4]),
        failed_logins: 0,
        locked_until: null,
        last_login_at: null,
        last_login_ip: null,
        created_at: nowIso(),
        updated_at: nowIso(),
      });
      return { insertId: id, affectedRows: 1 };
    }
    if (/^UPDATE users SET failed_logins = 0/.test(s)) {
      const row = store.users.find((u) => u.id === Number(params[2]));
      if (row) {
        row.failed_logins = 0;
        row.locked_until = null;
        row.last_login_at = params[0];
        row.last_login_ip = params[1];
      }
      return { affectedRows: row ? 1 : 0 };
    }
    if (/^UPDATE users SET failed_logins = failed_logins \+ 1/.test(s)) {
      const row = store.users.find((u) => u.id === Number(params[2]));
      if (row) {
        row.failed_logins = Number(row.failed_logins || 0) + 1;
        row.locked_until = params[0];
        row.last_login_ip = params[1];
      }
      return { affectedRows: row ? 1 : 0 };
    }
    if (/^UPDATE users SET password_hash = \?/.test(s)) {
      const row = store.users.find((u) => u.id === Number(params[1]));
      if (row) row.password_hash = params[0];
      return { affectedRows: row ? 1 : 0 };
    }
    if (/^INSERT INTO generation_logs/.test(s)) {
      const id = nextId();
      store.generationLogs.push({
        id,
        ticket_id: null,
        ticket_date: params[1],
        trigger_source: params[2],
        admin_id: params[3],
        status: params[4],
        progress_step: params[5],
        progress_json: params[6],
        settings_snapshot_json: params[7],
        started_at: params[8] || nowIso(),
        finished_at: null,
        fixtures_scanned: 0, over15_candidates: 0, verified_odds: 0, rejected_matches: 0,
        rejected_no_odds: 0, rejected_low_confidence: 0, rejected_high_risk: 0, rejected_low_quality: 0,
        rejected_insufficient_data: 0, rejected_fixture_state: 0, rejected_stale_odds: 0,
        correlation_rejected: 0, confidence_qualified: 0, risk_qualified: 0, final_candidates: 0,
        combinations_tested: 0, qualified_combinations: 0, selected_picks: 0, total_odds: null,
        report_json: null, error_detail: null, duration_ms: null,
      });
      return { insertId: id, affectedRows: 1 };
    }
    if (/^UPDATE generation_logs/.test(s)) {
      const id = Number(params[params.length - 1]);
      const row = store.generationLogs.find((g) => g.id === id);
      if (row) {
        // the stored rows use the real column names, so keep them verbatim
        const fields = (s.match(/SET (.+) WHERE/) || [null, ''])[1].split(',').map((f) => f.trim().split(' = ')[0]);
        fields.forEach((field, i) => {
          row[field] = params[i];
        });
      }
      return { affectedRows: 1 };
    }
    if (/^INSERT INTO tickets/.test(s)) {
      const id = nextId();
      store.tickets.push({
        id,
        ticket_date: params[0],
        market_key: 'over_1_5',
        market_label: 'Over 1.5 Goals',
        status: params[1],
        selection_count: params[2],
        total_odds: params[3],
        total_odds_display: params[4],
        avg_confidence: params[5],
        min_confidence: params[6],
        avg_quality: params[7],
        max_risk: params[8],
        estimated_probability: params[9],
        result: 'PENDING',
        settled_odds: null,
        settled_at: null,
        result_note: params[16] || null,
        min_total_odds: params[10],
        max_total_odds: params[11],
        generation_id: params[12],
        generated_by_admin_id: params[13],
        generated_at: params[14],
        published: params[15],
      });
      return { insertId: id, affectedRows: 1 };
    }
    if (/^INSERT INTO ticket_selections/.test(s)) {
      const id = nextId();
      store.selections.push({
        id,
        ticket_id: params[0],
        fixture_id: params[1],
        prediction_id: params[2],
        position: params[3],
        league_id: params[4], league_name: params[5], league_country: params[6], league_logo_url: params[7],
        home_team_id: params[8], away_team_id: params[9], home_team_name: params[10], away_team_name: params[11],
        home_team_logo: params[12], away_team_logo: params[13],
        kickoff_at: params[14],
        market_key: 'over_1_5', market_label: 'Over 1.5 Goals',
        bookmaker_id: params[15], bookmaker_name: params[16],
        odd_decimal: params[17], odd_raw: params[18],
        odds_updated_at: params[19], odds_verified_at: params[20],
        confidence: params[21], quality_score: params[22], risk_score: params[23], model_probability: params[24],
        result: 'PENDING',
        final_home_goals: null, final_away_goals: null, final_total_goals: null, settled_at: null,
        snapshot_json: params[25],
      });
      return { insertId: id, affectedRows: 1 };
    }
    if (/^DELETE FROM tickets WHERE id = \?/.test(s)) {
      const id = Number(params[0]);
      store.tickets = store.tickets.filter((t) => t.id !== id);
      store.selections = store.selections.filter((s2) => s2.ticket_id !== id);
      return { affectedRows: 1 };
    }
    if (/^INSERT INTO system_logs/.test(s)) {
      const id = nextId();
      store.systemLogs.push({
        id,
        level: params[0],
        channel: params[1],
        event: params[2],
        message: params[3],
        actor_type: params[4] || null,
        actor_id: params[5] ?? null,
        ip_address: params[6] ?? null,
        user_agent: params[7] ?? null,
        context_json: params[8] ?? null,
        created_at: nowIso(),
      });
      return { insertId: id, affectedRows: 1 };
    }
    if (/^INSERT INTO api_sync_logs/.test(s)) {
      const id = nextId();
      store.apiSyncLogs.push({
        id,
        job: params[0],
        trigger_source: params[1],
        status: params[2],
        endpoint_calls: params[3],
        rows_written: params[4],
        rows_read: params[5],
        requests_used: params[6],
        requests_limit: params[7],
        message: params[8],
        error_detail: params[9],
        duration_ms: params[10],
        started_at: params[11],
        finished_at: params[12],
      });
      return { insertId: id, affectedRows: 1 };
    }
    if (/^UPDATE api_sync_logs/.test(s)) {
      const id = Number(params[params.length - 1]);
      const row = store.apiSyncLogs.find((r) => Number(r.id) === id);
      if (row) {
        const fields = (s.match(/SET (.+) WHERE/) || [null, ''])[1].split(',').map((f) => f.trim().split(' = ')[0]);
        fields.forEach((field, i) => {
          row[field] = params[i];
        });
      }
      return { affectedRows: row ? 1 : 0 };
    }
    if (/^INSERT INTO odds/.test(s)) {
      const row = {
        id: nextId(),
        fixture_id: params[0], bookmaker_id: params[1], bookmaker_name: params[2],
        market_key: params[3], market_label: params[4], bet_name: params[5], value_name: params[6],
        goal_line: params[7], direction: params[8], odd_decimal: params[9], odd_raw: params[10],
        is_verified: params[11], validation_state: params[12], reject_reason: params[13],
        odds_updated_at: params[14], fetched_at: params[15],
      };
      const at = store.odds.findIndex(
        (o) =>
          Number(o.fixture_id) === Number(row.fixture_id) &&
          Number(o.bookmaker_id) === Number(row.bookmaker_id) &&
          o.market_key === row.market_key &&
          String(o.value_name) === String(row.value_name)
      );
      if (at === -1) store.odds.push(row);
      else store.odds[at] = { ...store.odds[at], ...row, id: store.odds[at].id };
      return { insertId: row.id, affectedRows: 1 };
    }
    if (/^INSERT INTO predictions/.test(s)) {
      const row = {
        id: nextId(),
        fixture_id: params[0], market_key: 'over_1_5', market_label: 'Over 1.5 Goals',
        is_eligible: params[1], reject_reason: params[2], confidence: params[3],
        quality_score: params[4], risk_score: params[5], model_probability: params[6],
        market_probability: params[7], expected_goals_home: params[8], expected_goals_away: params[9],
        expected_total_goals: params[10], home_over15_rate: params[11], away_over15_rate: params[12],
        h2h_over15_rate: params[13], h2h_sample: params[14], home_form_sample: params[15],
        away_form_sample: params[16], data_quality: params[17], injuries_home: params[18],
        injuries_away: params[19], selected_odds: params[20], selected_bookmaker_id: params[21],
        selected_bookmaker_name: params[22], odds_updated_at: params[23], odds_verified_at: params[24],
        analysis_json: params[25], generated_at: params[26],
      };
      const at = store.predictions.findIndex(
        (p) => Number(p.fixture_id) === Number(row.fixture_id) && p.market_key === row.market_key
      );
      if (at === -1) store.predictions.push(row);
      else store.predictions[at] = { ...store.predictions[at], ...row, id: store.predictions[at].id };
      return { insertId: row.id, affectedRows: 1 };
    }
    if (/^INSERT INTO results/.test(s)) {
      const row = {
        id: nextId(),
        fixture_id: params[0], status_short: params[1], status_long: params[2],
        goals_home: params[3], goals_away: params[4], total_goals: params[5],
        over15_result: params[6], settled: params[7], settled_at: params[8],
        source: 'api-football', raw_json: params[9],
      };
      const at = store.results.findIndex((r) => Number(r.fixture_id) === Number(row.fixture_id));
      if (at === -1) store.results.push(row);
      else store.results[at] = { ...store.results[at], ...row, id: store.results[at].id };
      return { insertId: row.id, affectedRows: 1 };
    }
    if (/^UPDATE ticket_selections/.test(s)) {
      const id = Number(params[params.length - 1]);
      const row = store.selections.find((sel) => Number(sel.id) === id);
      if (row) {
        row.result = params[0];
        row.final_home_goals = params[1];
        row.final_away_goals = params[2];
        row.final_total_goals = params[3];
        row.settled_at = params[4];
      }
      return { affectedRows: row ? 1 : 0 };
    }
    if (/^UPDATE tickets SET result/.test(s)) {
      const id = Number(params[params.length - 1]);
      const row = store.tickets.find((t) => Number(t.id) === id);
      if (row) {
        row.result = params[0];
        row.settled_odds = params[1];
        row.settled_at = params[2];
        row.result_note = params[3];
      }
      return { affectedRows: row ? 1 : 0 };
    }
    if (/^INSERT INTO bookmakers/.test(s) || /^INSERT INTO prediction_scores/.test(s) || /^INSERT INTO team_form/.test(s)) {
      return { insertId: nextId(), affectedRows: 1 };
    }
    if (/^DELETE FROM prediction_scores/.test(s)) return { affectedRows: 0 };
    return { affectedRows: 1 };
  }

  const original = {
    query: connection.query,
    queryOne: connection.queryOne,
    execute: connection.execute,
    transaction: connection.transaction,
    ping: connection.ping,
    getPool: connection.getPool,
  };

  connection.query = query;
  connection.queryOne = queryOne;
  connection.execute = execute;
  connection.ping = async () => true;
  connection.getPool = () => ({ query: async () => [[{ 1: 1 }]], execute: async () => [[{ 1: 1 }]], getConnection: async () => ({ release() {}, ping: async () => {}, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, execute: async () => [[]] }) });
  connection.transaction = async (work) =>
    work({
      query: async (sql, params) => query(sql, params),
      queryOne: async (sql, params) => queryOne(sql, params),
      execute: async (sql, params) => execute(sql, params),
    });

  return {
    store,
    restore() {
      Object.assign(connection, original);
    },
  };
}

module.exports = { install };
