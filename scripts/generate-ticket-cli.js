#!/usr/bin/env node
'use strict';

/**
 * MANUAL ticket generation from the command line.
 *
 *   npm run ticket:generate -- --admin=admin --confirm
 *   npm run ticket:generate -- --admin=admin --confirm --date=2026-10-04
 *
 * This is an operator tool. It must NEVER be placed in a cron job: the script
 * refuses to run when CRON_CONTEXT is set, and it requires an explicit
 * --confirm flag plus an existing, active administrator for attribution.
 */

const ticketService = require('../server/services/ticketService');
const settingsService = require('../server/services/settingsService');
const db = require('../server/database/queries');
const pool = require('../server/database/connection');
const time = require('../server/utils/time');

if (process.env.CRON_CONTEXT === '1') {
  process.stderr.write('REFUSED: ticket generation is not allowed from a cron context.\n');
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (const arg of argv.slice(2)) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

function usage() {
  process.stdout.write(
    [
      'Usage: node scripts/generate-ticket-cli.js --admin=<username> --confirm [--date=YYYY-MM-DD]',
      '',
      '  --admin    username of an active administrator (attribution in the audit log)',
      '  --confirm  required acknowledgement that this is a manual, human triggered run',
      '  --date     ticket date in UTC (defaults to today)',
      '',
      'The run uses only verified Over 1.5 odds from API-Football. If no combination',
      'lands inside the configured odds window the result is NO QUALIFYING TICKET.',
      '',
    ].join('\n')
  );
}

(async () => {
  const args = parseArgs(process.argv);
  if (!args.confirm || !args.admin) {
    usage();
    process.exitCode = 1;
    return;
  }

  const admin = await db.getAdminByLogin(String(args.admin).toLowerCase());
  if (!admin || Number(admin.is_active) !== 1) {
    process.stderr.write(`REFUSED: no active administrator named "${args.admin}".\n`);
    process.exitCode = 1;
    return;
  }

  const date = args.date ? time.toMysqlDate(args.date) : time.toMysqlDate(new Date());
  const settings = await settingsService.getEngineSettings(true);

  process.stdout.write(
    [
      `Generating the ${date} ticket for ${admin.username} (manual CLI run)`,
      `  market           : ${settings.marketLabel} (locked)`,
      `  odds window      : ${Number(settings.minTotalOdds).toFixed(2)} - ${Number(settings.maxTotalOdds).toFixed(2)}`,
      `  min confidence   : ${settings.minConfidence}`,
      `  max risk         : ${settings.maxRisk}`,
      `  min data quality : ${settings.minDataQuality}`,
      `  selections       : ${settings.minSelections}-${settings.maxSelections}`,
      '  auto generation  : OFF (locked)',
      '',
    ].join('\n')
  );

  const runId = await db.insertGenerationLog({
    ticketDate: date,
    triggerSource: 'cli_manual',
    adminId: Number(admin.id),
    status: 'RUNNING',
    progressStep: 'LOADING_FIXTURES',
    progressJson: [{ step: 'START', message: 'CLI generation started', at: new Date().toISOString() }],
    settingsSnapshot: { minTotalOdds: settings.minTotalOdds, maxTotalOdds: settings.maxTotalOdds },
    startedAt: new Date(),
  });

  const result = await ticketService.runGeneration({
    runId,
    adminId: Number(admin.id),
    source: 'cli_manual',
    date,
    now: new Date(),
    settings,
  });

  const report = result.report || {};
  process.stdout.write(
    [
      '',
      `RESULT: ${result.status}`,
      report.message ? `  ${report.message}` : '',
      '',
      'GENERATION REPORT',
      `  DATE                    : ${report.date || date}`,
      `  FIXTURES SCANNED        : ${report.fixturesScanned ?? 0}`,
      `  PLAYABLE FIXTURES       : ${report.playableFixtures ?? 0}`,
      `  OVER 1.5 CANDIDATES     : ${report.over15Candidates ?? 0}`,
      `  VERIFIED ODDS           : ${report.verifiedOdds ?? 0}`,
      `  REJECTED (NO ODDS)      : ${report.rejectedNoOdds ?? 0}`,
      `  REJECTED (DATA)         : ${report.rejectedInsufficientData ?? 0}`,
      `  REJECTED (LOW CONF)     : ${report.rejectedLowConfidence ?? 0}`,
      `  REJECTED (HIGH RISK)    : ${report.rejectedHighRisk ?? 0}`,
      `  REJECTED (LOW QUALITY)  : ${report.rejectedLowQuality ?? 0}`,
      `  CORRELATION REJECTED    : ${report.correlationRejected ?? 0}`,
      `  CONFIDENCE QUALIFIED    : ${report.confidenceQualified ?? 0}`,
      `  RISK QUALIFIED          : ${report.riskQualified ?? 0}`,
      `  FINAL CANDIDATES        : ${report.finalCandidates ?? 0}`,
      `  COMBINATIONS TESTED     : ${report.combinationsTested ?? 0}`,
      `  QUALIFIED COMBINATIONS  : ${report.qualifiedCombinations ?? 0}`,
      `  SELECTED PICKS          : ${report.selectedPicks ?? 0}`,
      `  TOTAL ODDS              : ${report.totalOdds ?? '-'}`,
      `  DURATION                : ${result.durationMs ?? 0} ms`,
      '',
    ]
      .filter((l) => l !== null)
      .join('\n')
  );

  if (result.ticket && result.ticket.selections) {
    process.stdout.write('SELECTIONS (immutable odds snapshot)\n');
    for (const s of result.ticket.selections) {
      process.stdout.write(
        `  ${String(s.position).padStart(2, '0')}. ${s.league?.name || '-'} | ${s.homeTeam?.name} vs ${s.awayTeam?.name} | OVER 1.5 GOALS @ ${s.odds?.display} (${s.odds?.bookmaker}) | confidence ${s.confidence}%\n`
      );
    }
    process.stdout.write('\n');
  }

  process.exitCode = result.status === 'QUALIFIED' ? 0 : result.status === 'NO_QUALIFYING_TICKET' ? 0 : 3;
})()
  .catch((err) => {
    process.stderr.write(`Generation failed: ${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => pool.closePool());
