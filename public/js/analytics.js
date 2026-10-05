/* GoalPredict — public analytics */
'use strict';
(function () {
  const { API, fmt, escapeHtml, icons } = App;
  const $ = (s) => document.querySelector(s);

  function card(k, v, d, tone) {
    return `<div class="mini-card"><div class="k">${escapeHtml(k)}</div><div class="v ${tone || ''}">${escapeHtml(v)}</div><div class="d">${escapeHtml(d || '')}</div></div>`;
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
      $('#statCards').innerHTML = `<div class="alert error">${icons.alert}<div>${escapeHtml(err.message)}</div></div>`;
    }
  }
  document.addEventListener('DOMContentLoaded', load);
})();
