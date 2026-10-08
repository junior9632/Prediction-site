/* GoalPredict — prediction analytics (members only)
 *
 * /api/analytics is behind the member guard: the performance record is
 * prediction data, so a signed-out caller is answered 401 with no payload. */
'use strict';
(function () {
  const { API, fmt, escapeHtml, icons, lockedState, isUnauthorized } = App;
  const $ = (s) => document.querySelector(s);

  function card(k, v, d, tone) {
    return `<div class="mini-card"><div class="k">${escapeHtml(k)}</div><div class="v ${tone || ''}">${escapeHtml(v)}</div><div class="d">${escapeHtml(d || '')}</div></div>`;
  }

  /** Flat-stake ROI cards. Honest framing: a negative ROI is shown in red, never hidden. */
  function renderRoi(flat) {
    if (!flat || !flat.staked) {
      return `<p class="small muted">No settled tickets yet — the flat-stake record appears after the first settlement.</p>`;
    }
    const profitTone = flat.profit > 0 ? 'green' : flat.profit < 0 ? 'red' : '';
    const sign = (v) => (v > 0 ? `+${v}` : String(v));
    return [
      card('Units staked', String(flat.staked), '1 unit per settled ticket'),
      card('Units returned', String(flat.returned), 'at the published odds'),
      card('Profit / loss', sign(flat.profit), 'units', profitTone),
      card('ROI', flat.roi === null ? '—' : `${sign(flat.roi)}%`, 'return on stakes', profitTone),
    ].join('');
  }

  /** Dependency-free SVG bar chart: win rate per month with settled counts. */
  function renderMonthlyChart(monthly) {
    const months = (monthly || []).filter((m) => m.won + m.lost > 0).slice(0, 12).reverse();
    if (!months.length) return `<p class="small muted">No settled months yet.</p>`;

    const W = 640;
    const H = 220;
    const padL = 34;
    const padB = 34;
    const padT = 16;
    const plotW = W - padL - 10;
    const plotH = H - padT - padB;
    const step = plotW / months.length;
    const barW = Math.min(44, step * 0.6);

    const gridLines = [0, 25, 50, 75, 100]
      .map((v) => {
        const y = padT + plotH - (v / 100) * plotH;
        return `<line x1="${padL}" y1="${y}" x2="${W - 10}" y2="${y}" stroke="rgba(148,163,184,0.15)" stroke-width="1"/>
          <text x="${padL - 6}" y="${y + 3}" text-anchor="end" font-size="9" fill="rgba(148,163,184,0.7)">${v}%</text>`;
      })
      .join('');

    const bars = months
      .map((m, i) => {
        const rate = m.winRate === null ? 0 : Number(m.winRate);
        const h = Math.max(2, (rate / 100) * plotH);
        const x = padL + i * step + (step - barW) / 2;
        const y = padT + plotH - h;
        const tone = rate >= 50 ? '#34d399' : '#f87171';
        const label = escapeHtml(String(m.month || '').slice(2)); // YY-MM
        return `<rect x="${x}" y="${y}" width="${barW}" height="${h}" rx="3" fill="${tone}" fill-opacity="0.75">
            <title>${escapeHtml(m.month)}: ${rate}% (${m.won}W/${m.lost}L)</title>
          </rect>
          <text x="${x + barW / 2}" y="${y - 4}" text-anchor="middle" font-size="9" fill="rgba(226,232,240,0.9)">${rate}%</text>
          <text x="${x + barW / 2}" y="${padT + plotH + 14}" text-anchor="middle" font-size="9" fill="rgba(148,163,184,0.8)">${label}</text>
          <text x="${x + barW / 2}" y="${padT + plotH + 26}" text-anchor="middle" font-size="8" fill="rgba(148,163,184,0.55)">${m.won}W/${m.lost}L</text>`;
      })
      .join('');

    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly ticket win rate" style="width:100%; height:auto;">
      ${gridLines}${bars}
    </svg>`;
  }

  async function load() {
    App.session.bindHeader();
    try {
      const a = await API.get('/analytics');
      $('#generatedAt').textContent = `Updated ${fmt.dateTimeLabel(a.generatedAt)}`;
      $('#statCards').innerHTML = [
        card('Total tickets', a.tickets.total, `${a.tickets.qualified} qualified · ${a.tickets.noTicketDays} no-ticket days`),
        card('Win rate', a.tickets.winRate === null ? '—' : `${a.tickets.winRate}%`, `${a.tickets.won} won / ${a.tickets.lost} lost`, 'green'),
        card('Average odds', a.tickets.avgOdds === null ? '—' : fmt.odds(a.tickets.avgOdds), `range ${a.tickets.lowestOdds === null ? '—' : fmt.odds(a.tickets.lowestOdds)} – ${a.tickets.highestOdds === null ? '—' : fmt.odds(a.tickets.highestOdds)}`, 'cyan'),
        card('Selection win rate', a.selections.winRate === null ? '—' : `${a.selections.winRate}%`, `${a.selections.won} won of ${a.selections.settled} settled picks`, 'green'),
        card('Over 1.5 hit rate', a.over15.winRate === null ? '—' : `${a.over15.winRate}%`, `${a.over15.won} of ${a.over15.settled} settled matches reached 2+ goals`, 'cyan'),
        card('Current streak', a.streaks.currentWinningStreak ? `${a.streaks.currentWinningStreak}W` : a.streaks.currentLosingStreak ? `${a.streaks.currentLosingStreak}L` : '—', `longest ${a.streaks.longestWinningStreak}W / ${a.streaks.longestLosingStreak}L`, a.streaks.currentLosingStreak ? 'red' : 'green'),
      ].join('');
      $('#roiCards').innerHTML = renderRoi(a.flatStake);
      $('#monthlyChart').innerHTML = renderMonthlyChart(a.monthly);
      $('#monthlyTable').innerHTML = `<table class="data"><thead><tr><th>Month</th><th>Tickets</th><th>Qualified</th><th>Won</th><th>Lost</th><th>Void</th><th>Picks</th><th>Avg odds</th><th>Win rate</th></tr></thead><tbody>
        ${a.monthly.map((m) => `<tr><td><b>${escapeHtml(m.month)}</b></td><td>${m.tickets}</td><td>${m.qualified}</td><td>${m.won}</td><td>${m.lost}</td><td>${m.voided}</td><td>${m.selections}</td><td>${m.avgOdds === null ? '—' : fmt.odds(m.avgOdds)}</td><td>${m.winRate === null ? '—' : m.winRate + '%'}</td></tr>`).join('') || `<tr><td colspan="9" class="muted">No settled months yet.</td></tr>`}
      </tbody></table>`;
      $('#streakCards').innerHTML = [
        card('Winning streak (current)', a.streaks.currentWinningStreak, 'consecutive won tickets', 'green'),
        card('Losing streak (current)', a.streaks.currentLosingStreak, 'consecutive lost tickets', a.streaks.currentLosingStreak ? 'red' : ''),
        card('Longest winning streak', a.streaks.longestWinningStreak, 'all time'),
        card('Longest losing streak', a.streaks.longestLosingStreak, 'all time'),
        card('Void / postponed legs', a.selections.voided, 'settlement follows bookmaker rules'),
        card('Pending legs', a.selections.pending, 'waiting for final scores'),
      ].join('');
    } catch (err) {
      $('#statCards').innerHTML = isUnauthorized(err)
        ? lockedState('Login to access GoalPredict prediction analytics and the performance record.')
        : `<div class="alert error">${icons.alert}<div>${escapeHtml(err.message)}</div></div>`;
    }
  }
  document.addEventListener('DOMContentLoaded', load);
})();
