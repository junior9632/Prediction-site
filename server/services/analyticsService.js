'use strict';

/**
 * ANALYTICS SERVICE — performance statistics derived exclusively from
 * settled, real results and the frozen odds snapshots. No projections,
 * no simulated outcomes.
 */

const db = require('../database/queries');
const numbers = require('../utils/numbers');
const decimal = require('../utils/decimal');

const num = (v) => (v === null || v === undefined ? 0 : Number(v));
const pct = (a, b) => (b > 0 ? numbers.round((a / b) * 100, 2) : null);

/** Winning / losing streaks from the chronological settled sequence. */
function computeStreaks(sequence = []) {
  const results = sequence.map((r) => r.result).filter((r) => r === 'WON' || r === 'LOST');
  let currentWin = 0;
  let currentLoss = 0;
  let longestWin = 0;
  let longestLoss = 0;
  let runWin = 0;
  let runLoss = 0;

  for (const r of results) {
    if (r === 'WON') {
      runWin += 1;
      runLoss = 0;
      longestWin = Math.max(longestWin, runWin);
    } else {
      runLoss += 1;
      runWin = 0;
      longestLoss = Math.max(longestLoss, runLoss);
    }
  }
  const last = results[results.length - 1];
  if (last === 'WON') {
    for (let i = results.length - 1; i >= 0 && results[i] === 'WON'; i -= 1) currentWin += 1;
  } else if (last === 'LOST') {
    for (let i = results.length - 1; i >= 0 && results[i] === 'LOST'; i -= 1) currentLoss += 1;
  }

  return {
    currentWinningStreak: currentWin,
    currentLosingStreak: currentLoss,
    longestWinningStreak: longestWin,
    longestLosingStreak: longestLoss,
    settledTickets: results.length,
  };
}

/**
 * Illustrative flat-stake accounting: 1 unit on every QUALIFIED ticket.
 * Won tickets return their (void-adjusted) real odds, lost tickets return 0,
 * fully void tickets return the stake.
 */
async function computeFlatStake() {
  const rows = await db.listTickets({ status: 'QUALIFIED', limit: 100000 });
  let staked = 0;
  let returned = 0;
  for (const row of rows) {
    if (row.result === 'PENDING' || row.result === 'N/A') continue;
    staked += 1;
    if (row.result === 'WON') {
      const odds = row.settled_odds !== null ? decimal.toScaled(row.settled_odds) : decimal.toScaled(row.total_odds);
      returned += odds === null ? 0 : decimal.toNumber(odds);
    } else if (row.result === 'VOID' || row.result === 'PARTIAL_VOID') {
      if (row.result === 'VOID') returned += 1;
      else if (row.settled_odds !== null) {
        const odds = decimal.toScaled(row.settled_odds);
        returned += odds === null ? 0 : decimal.toNumber(odds);
      }
    }
  }
  return {
    staked: numbers.round(staked, 2),
    returned: numbers.round(returned, 2),
    profit: numbers.round(returned - staked, 2),
    roi: staked > 0 ? numbers.round(((returned - staked) / staked) * 100, 2) : null,
  };
}

async function getOverview() {
  const [tickets, selections, outcomes, monthly, sequence] = await Promise.all([
    db.getTicketAnalytics(),
    db.getSelectionAnalytics(),
    db.getOver15OutcomeCounts(),
    db.getMonthlyTicketStats(12),
    db.getSettledTicketSequence(),
  ]);

  const wonTickets = num(tickets?.won_tickets);
  const lostTickets = num(tickets?.lost_tickets);
  const voidTickets = num(tickets?.void_tickets);
  const settledTickets = wonTickets + lostTickets;

  const wonSelections = num(selections?.won);
  const lostSelections = num(selections?.lost);
  const settledSelections = wonSelections + lostSelections;

  const outcomeWon = num(outcomes?.won);
  const outcomeLost = num(outcomes?.lost);
  const settledOutcomes = outcomeWon + outcomeLost;

  const monthlyStats = (monthly || []).map((m) => {
    const won = num(m.won);
    const lost = num(m.lost);
    return {
      month: m.month,
      tickets: num(m.tickets),
      qualified: num(m.qualified),
      won,
      lost,
      voided: num(m.voided),
      selections: num(m.selections),
      avgOdds: m.avg_odds === null ? null : numbers.round(Number(m.avg_odds), 2),
      winRate: pct(won, won + lost),
    };
  });

  return {
    tickets: {
      total: num(tickets?.total_tickets),
      qualified: num(tickets?.qualified_tickets),
      noTicketDays: num(tickets?.no_ticket_days),
      won: wonTickets,
      lost: lostTickets,
      void: voidTickets,
      pending: num(tickets?.pending_tickets),
      settled: settledTickets,
      winRate: pct(wonTickets, settledTickets),
      avgOdds: tickets?.avg_ticket_odds === null || tickets?.avg_ticket_odds === undefined ? null : numbers.round(Number(tickets.avg_ticket_odds), 2),
      highestOdds: tickets?.highest_ticket_odds === null || tickets?.highest_ticket_odds === undefined ? null : numbers.round(Number(tickets.highest_ticket_odds), 2),
      lowestOdds: tickets?.lowest_ticket_odds === null || tickets?.lowest_ticket_odds === undefined ? null : numbers.round(Number(tickets.lowest_ticket_odds), 2),
      avgConfidence: tickets?.avg_confidence === null || tickets?.avg_confidence === undefined ? null : numbers.round(Number(tickets.avg_confidence), 2),
    },
    selections: {
      total: num(selections?.total_selections),
      won: wonSelections,
      lost: lostSelections,
      voided: num(selections?.voided),
      pending: num(selections?.pending),
      settled: settledSelections,
      winRate: pct(wonSelections, settledSelections),
      avgOdds: selections?.avg_selection_odds === null || selections?.avg_selection_odds === undefined ? null : numbers.round(Number(selections.avg_selection_odds), 2),
    },
    over15: {
      settled: settledOutcomes,
      won: outcomeWon,
      lost: outcomeLost,
      voided: num(outcomes?.voided),
      winRate: pct(outcomeWon, settledOutcomes),
    },
    streaks: computeStreaks(sequence),
    monthly: monthlyStats,
  };
}

/** Public, trimmed statistics for the homepage / analytics page. */
async function getPublicStats() {
  const overview = await getOverview();
  const flat = await computeFlatStake().catch(() => null);
  return {
    // Aggregate performance only — the analytics page renders every one of
    // these counters, so the public shape must stay complete.
    tickets: {
      total: overview.tickets.total,
      qualified: overview.tickets.qualified,
      noTicketDays: overview.tickets.noTicketDays,
      won: overview.tickets.won,
      lost: overview.tickets.lost,
      void: overview.tickets.void,
      pending: overview.tickets.pending,
      settled: overview.tickets.settled,
      winRate: overview.tickets.winRate,
      avgOdds: overview.tickets.avgOdds,
      highestOdds: overview.tickets.highestOdds,
      lowestOdds: overview.tickets.lowestOdds,
    },
    selections: {
      total: overview.selections.total,
      won: overview.selections.won,
      lost: overview.selections.lost,
      voided: overview.selections.voided,
      pending: overview.selections.pending,
      settled: overview.selections.settled,
      winRate: overview.selections.winRate,
    },
    over15: overview.over15,
    streaks: overview.streaks,
    monthly: overview.monthly.slice(0, 6),
    flatStake: flat,
    market: { key: 'over_1_5', label: 'Over 1.5 Goals', oddsWindow: { min: 2, max: 4 } },
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { getOverview, getPublicStats, computeStreaks, computeFlatStake };
