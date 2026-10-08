/* GoalPredict — session-aware navigation for pages with no controller of their
 * own (legal.html, …).
 *
 * It does exactly one thing: asks the server who is signed in and lets the
 * shared helper in api.js swap Login / Create Account for the account chip and
 * reveal the member-only navigation entries (Dashboard · Predictions ·
 * Today's Ticket · Ticket History · Analytics).
 *
 * It reads NO prediction data. Those surfaces live behind the server guard: a
 * guest asking for /predictions, /ticket, /history or /analytics — or for any
 * of their APIs — is answered with 401 Unauthorized and an empty body.
 */
'use strict';

document.addEventListener('DOMContentLoaded', () => App.session.bindHeader());
