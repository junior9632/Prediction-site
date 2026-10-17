/* GoalPredict — validated, draft-safe admin settings editor. */
'use strict';

(function () {
  let state = null;
  const $ = (selector) => document.querySelector(selector);
  const GROUPS = {
    market: 'Locked product rules', odds_window: 'Odds window', filters: 'Eligibility filters',
    correlation: 'Correlation protection', model: 'Prediction model', scoring: 'Scoring weights',
    sync: 'Fixture & data synchronisation', site: 'Site & display',
  };

  function comparable(item, value) {
    if (item.type === 'json') {
      try { return JSON.stringify(JSON.parse(value)); } catch (_) { return value; }
    }
    return String(value);
  }

  function displayValue(item, value) {
    if (item.type === 'json') {
      try { return JSON.stringify(JSON.parse(value), null, 2); } catch (_) { return value; }
    }
    return String(value);
  }

  function fieldHtml(item, escapeHtml) {
    const id = `set_${item.key}`;
    const locked = item.locked ? ' <span class="badge badge-slate">locked</span>' : '';
    const attrs = `id="${id}" data-setting="${escapeHtml(item.key)}" aria-describedby="${id}_hint ${id}_error" ${item.locked ? 'disabled' : ''} ${item.required ? 'required' : ''}`;
    const hint = `<div class="hint" id="${id}_hint">${escapeHtml(item.description || '')}${item.warning ? `<div class="settings-warning">${escapeHtml(item.warning)}</div>` : ''}</div>`;
    const error = `<div class="field-error" id="${id}_error" aria-live="polite"></div>`;
    const label = `<label for="${id}">${escapeHtml(item.label)}${locked}</label>`;
    let control;
    if (item.type === 'boolean') {
      // The track must not intercept the checkbox's pointer events. The label
      // also makes the whole description a keyboard/touch-accessible target.
      return `<div class="field"><div class="toggle"><div>${label}${hint}</div><span class="switch"><input type="checkbox" ${attrs} ${['1', 'true'].includes(String(item.value)) ? 'checked' : ''}><span class="track" aria-hidden="true"></span></span></div>${error}</div>`;
    }
    if (item.type === 'json') {
      control = `<textarea class="input" ${attrs} rows="6" spellcheck="false">${escapeHtml(displayValue(item, item.value))}</textarea>`;
    } else if (item.type === 'enum') {
      control = `<select class="input" ${attrs}>${(item.options || []).map((value) => `<option value="${escapeHtml(value)}" ${String(value) === String(item.value) ? 'selected' : ''}>${escapeHtml(value)}</option>`).join('')}</select>`;
    } else {
      const typeAttrs = item.type === 'number'
        ? `type="number" step="${item.integer ? '1' : 'any'}" ${item.min !== null ? `min="${item.min}"` : ''} ${item.max !== null ? `max="${item.max}"` : ''}`
        : `type="text" maxlength="${item.maxLength || 200}"`;
      control = `<input class="input" ${attrs} ${typeAttrs} value="${escapeHtml(item.value)}">`;
    }
    return `<div class="field${item.type === 'json' ? ' settings-wide' : ''}">${label}${control}${hint}${error}</div>`;
  }

  function hasUnsavedChanges() {
    return Boolean(state && state.active() && (state.dirty || state.saving));
  }

  async function load({ API, icons, escapeHtml, card, render, isCurrent = () => true }) {
    render('<div class="skeleton block"></div>');
    const data = await API.get('/admin/settings');
    if (!isCurrent()) return;
    const groups = {};
    const byKey = new Map(data.items.map((item) => [item.key, item]));
    data.items.forEach((item) => { (groups[item.group] = groups[item.group] || []).push(item); });
    const order = [...new Set([...Object.keys(GROUPS), ...Object.keys(groups)])];
    render(`<form id="settingsForm">
      <div class="alert info">${icons.info}<div>Only changed settings are saved. Locked rules cannot be edited. Sync settings apply to the next sync; prediction settings apply to the next manual generation. Published tickets are not changed.</div></div>
      <fieldset id="settingsFields" class="settings-fields">${order.filter((group) => groups[group]).map((group) => `<section class="section">${card(GROUPS[group] || group, `<div class="card-body"><div class="field-grid">${groups[group].map((item) => fieldHtml(item, escapeHtml)).join('')}</div></div>`)}</section>`).join('')}</fieldset>
      <div class="settings-savebar"><div class="row wrap"><button type="submit" class="btn btn-primary" id="saveSettings" disabled>${icons.check} Save changes</button><button type="button" class="btn btn-ghost" id="discardSettings" disabled>Discard changes</button></div><div id="settingsMsg" class="small muted" role="status" aria-live="polite"></div></div>
    </form>`);

    const form = $('#settingsForm');
    const fields = Array.from(form.querySelectorAll('[data-setting]'));
    const baseline = new Map(data.items.map((item) => [item.key, comparable(item, item.value)]));
    const repairs = new Set(data.items.filter((item) => item.needsRepair && !item.locked).map((item) => item.key));
    const editor = { saving: false, dirty: false, active: () => isCurrent() && $('#settingsForm') === form };
    state = editor;
    const message = (text, tone) => {
      const node = $('#settingsMsg');
      node.textContent = text;
      node.className = `small ${tone || 'muted'}`;
    };
    const valueOf = (node) => node.type === 'checkbox' ? (node.checked ? '1' : '0') : node.value;
    const patchOf = () => {
      const patch = {};
      fields.forEach((node) => {
        const item = byKey.get(node.dataset.setting);
        if (item.locked) return;
        const value = valueOf(node);
        if (repairs.has(item.key) || comparable(item, value) !== baseline.get(item.key)) patch[item.key] = value;
      });
      return patch;
    };
    const updateButtons = () => {
      const count = Object.keys(patchOf()).length;
      editor.dirty = count > 0;
      $('#saveSettings').disabled = editor.saving || !count;
      $('#discardSettings').disabled = editor.saving || !count;
      return count;
    };
    const fieldError = (node, text) => {
      node.setCustomValidity(text);
      node.setAttribute('aria-invalid', text ? 'true' : 'false');
      $(`#set_${node.dataset.setting}_error`).textContent = text;
    };
    const writeValue = (node, value) => {
      const item = byKey.get(node.dataset.setting);
      if (node.type === 'checkbox') node.checked = String(value) === '1';
      else node.value = displayValue(item, value);
    };

    fields.forEach((node) => {
      const changed = () => {
        // One edit can resolve a cross-field error on a different control.
        // Clear server feedback and revalidate the whole draft on submission.
        fields.forEach((field) => fieldError(field, ''));
        const count = updateButtons();
        message(count ? `${count} unsaved change(s).` : 'No unsaved changes.');
      };
      node.addEventListener('input', changed);
      node.addEventListener('change', changed);
    });
    $('#discardSettings').onclick = () => {
      if (editor.saving || !window.confirm('Discard your unsaved changes?')) return;
      fields.forEach((node) => {
        writeValue(node, baseline.get(node.dataset.setting));
        fieldError(node, '');
      });
      const count = updateButtons();
      message(count ? `${count} stored setting(s) still need repair. Save the safe defaults to repair them.` : 'Unsaved changes discarded.');
    };

    form.onsubmit = async (event) => {
      event.preventDefault();
      if (editor.saving) return;
      const patch = patchOf();
      if (!Object.keys(patch).length) return;
      fields.forEach((node) => {
        const item = byKey.get(node.dataset.setting);
        if (item.locked || item.type !== 'json') return;
        try {
          const parsed = JSON.parse(node.value);
          fieldError(node, parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? '' : 'Enter a JSON object of named weights.');
        } catch (_) {
          fieldError(node, 'Enter valid JSON.');
        }
      });
      if (!form.reportValidity()) {
        message('Check the highlighted fields. Nothing has been saved.', 'red');
        return;
      }
      editor.saving = true;
      $('#settingsFields').disabled = true;
      form.setAttribute('aria-busy', 'true');
      updateButtons();
      message('Saving changes…');
      try {
        const result = await API.put('/admin/settings', patch);
        if (!editor.active()) return;
        result.applied.forEach(({ key, value }) => {
          const item = byKey.get(key);
          baseline.set(key, comparable(item, value));
          repairs.delete(key);
          const node = fields.find((field) => field.dataset.setting === key);
          writeValue(node, value);
          fieldError(node, '');
          const hint = $(`#set_${key}_hint`);
          hint.textContent = item.description || '';
        });
        result.rejected.forEach((entry) => {
          const node = fields.find((field) => field.dataset.setting === entry.key);
          if (node) fieldError(node, entry.message || entry.reason.replace(/_/g, ' '));
        });
        if (result.rejected.length) {
          message(`${result.applied.length} saved; ${result.rejected.length} need attention. Rejected changes have not been saved.`, 'warn');
        } else {
          message(`${result.applied.length} setting(s) saved.`, 'good');
        }
        if (App.site && result.settings) App.site.apply({ siteName: result.settings.site_name, tagline: result.settings.site_tagline, displayTimezone: result.settings.display_timezone });
      } catch (err) {
        if (editor.active()) message(`Save failed: ${err.message}. Your changes are still here; retry when ready.`, 'red');
      } finally {
        editor.saving = false;
        if (editor.active()) {
          $('#settingsFields').disabled = false;
          form.setAttribute('aria-busy', 'false');
          updateButtons();
        }
      }
    };
    const count = updateButtons();
    message(count ? `${count} stored setting(s) need repair. Save the safe defaults to repair them.` : 'No unsaved changes.');
  }

  window.addEventListener('beforeunload', (event) => {
    if (!hasUnsavedChanges()) return;
    event.preventDefault();
    event.returnValue = '';
  });
  window.AdminSettings = { load, hasUnsavedChanges };
})();
