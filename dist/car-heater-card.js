const DEFAULT_LANGUAGE = 'en';

const CAR_HEATER_CARD_VERSION = '0.5.6';
console.info(`Car Heater Card ${CAR_HEATER_CARD_VERSION}`);

class CarHeaterCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._timePicker = null;
    this._translations = {};
    this._loadedLanguages = new Set();
    this._loadingLanguages = new Set();
    this._historyCache = {};
    this._historyLoading = new Set();
    this._heatCurveOpen = false;
  }

  setConfig(config) {
    this.config = config || {};
    this._autoEntities = null;
    this._autoConfigKey = null;
  }

  get lang() {
    const language = this.config?.language || this._hass?.locale?.language || this._hass?.language || DEFAULT_LANGUAGE;
    const normalized = String(language).toLowerCase().split('-')[0];
    return normalized || DEFAULT_LANGUAGE;
  }

  get translationBasePath() {
    // Default assumes the file is installed as:
    // /config/www/car-heater-card/car-heater-card.js
    // /config/www/car-heater-card/translations/sv.json
    return this.config?.translation_path || new URL('./translations/', import.meta.url).toString().replace(/\/$/, '');
  }

  async loadLanguage(lang) {
    if (!lang || this._loadedLanguages.has(lang) || this._loadingLanguages.has(lang)) return;
    this._loadingLanguages.add(lang);
    try {
      const response = await fetch(`${this.translationBasePath}/${lang}.json`, { cache: 'no-cache' });
      if (response.ok) {
        this._translations[lang] = await response.json();
        this._loadedLanguages.add(lang);
        this.render();
      }
    } catch (err) {
      // Keep the card usable even if a translation file is missing.
      // Missing keys will show the translation key itself.
      // eslint-disable-next-line no-console
      console.warn(`car-heater-card: could not load translation ${lang}`, err);
    } finally {
      this._loadingLanguages.delete(lang);
    }
  }

  ensureTranslations() {
    this.loadLanguage(DEFAULT_LANGUAGE);
    if (this.lang !== DEFAULT_LANGUAGE) this.loadLanguage(this.lang);
  }

  lookupTranslation(dict, key) {
    if (!dict || !key) return undefined;
    return String(key).split('.').reduce((obj, part) => {
      if (obj && Object.prototype.hasOwnProperty.call(obj, part)) return obj[part];
      return undefined;
    }, dict);
  }

  t(key) {
    const dict = this._translations[this.lang] || {};
    const fallback = this._translations[DEFAULT_LANGUAGE] || {};
    const translated = this.lookupTranslation(dict, key) ?? this.lookupTranslation(fallback, key);
    return typeof translated === 'string' ? translated : key;
  }

  set hass(hass) {
    this._hass = hass;
    this.ensureTranslations();
    this.ensureAutoEntities();
    this.ensureHistory();
    // Do not re-render while the time picker is open. Home Assistant pushes
    // frequent state updates, and a re-render would reset the wheel/select
    // back to the stored entity value before the user has time to save.
    if (this._timePicker && this.shadowRoot.querySelector('.picker-overlay')) return;
    this.render();
  }

  static getConfigElement() {
    return document.createElement('car-heater-card-editor');
  }

  static getStubConfig() {
    return { type: 'custom:car-heater-card' };
  }

  getCardSize() { return 5; }

  isCarHeaterDevice(device) {
    const identifiers = Array.from(device?.identifiers || []);
    if (identifiers.some((identifier) => {
      if (Array.isArray(identifier)) return identifier[0] === 'car_heater';
      return String(identifier).includes('car_heater');
    })) return true;
    const name = String(device?.name_by_user || device?.name || '').toLowerCase();
    const manufacturer = String(device?.manufacturer || '').toLowerCase();
    const model = String(device?.model || '').toLowerCase();
    const entryType = String(device?.entry_type || '').toLowerCase();
    return name.includes('car heater') || name.includes('motorvärmare') || model.includes('car heater') || manufacturer.includes('car heater') || entryType.includes('car_heater');
  }

  isCarHeaterRegistryEntity(entry) {
    const platform = String(entry?.platform || '').toLowerCase();
    const uniqueId = String(entry?.unique_id || '').toLowerCase();
    const entityId = String(entry?.entity_id || '').toLowerCase();
    const translationKey = String(entry?.translation_key || '').toLowerCase();
    return platform === 'car_heater'
      || uniqueId.includes('car_heater')
      || uniqueId.includes('_departure')
      || uniqueId.includes('_runtime')
      || uniqueId.includes('_manual_active')
      || entityId.includes('car_heater')
      || translationKey === 'departure'
      || translationKey === 'runtime';
  }

  get resolvedEntities() {
    return Object.keys(this.config?.entities || {}).length ? this.config.entities : (this._autoEntities || {});
  }

  async ensureAutoEntities() {
    if (!this._hass || this._autoLoading || Object.keys(this.config?.entities || {}).length || !this.config?.device_id) return;
    const key = this.config.device_id;
    if (this._autoConfigKey === key && this._autoEntities) return;
    this._autoLoading = true;
    try {
      const entities = await this.detectEntities(this.config?.device_id);
      this._autoEntities = entities || {};
      this._autoConfigKey = key;
      this.render();
    } catch (err) {
      console.warn('car-heater-card: auto detection failed', err);
    } finally {
      this._autoLoading = false;
    }
  }

  async detectEntities(deviceId) {
    const [devices, entities] = await Promise.all([
      this._hass.callWS({ type: 'config/device_registry/list' }),
      this._hass.callWS({ type: 'config/entity_registry/list' }),
    ]);
    let targetDeviceId = deviceId;
    if (!targetDeviceId) {
      const device = devices.find((d) => this.isCarHeaterDevice(d));
      targetDeviceId = device?.id;
    }

    let deviceEntities = targetDeviceId ? entities.filter((entry) => entry.device_id === targetDeviceId) : [];
    if (!deviceEntities.length) {
      const candidates = entities.filter((entry) => this.isCarHeaterRegistryEntity(entry));
      const groups = new Map();
      candidates.forEach((entry) => {
        const key = entry.device_id || entry.config_entry_id || '__no_device__';
        groups.set(key, [...(groups.get(key) || []), entry]);
      });
      const best = [...groups.values()].sort((a, b) => b.length - a.length)[0];
      deviceEntities = best || candidates;
    }

    const byKey = (...keys) => {
      const found = deviceEntities.find((entry) => {
        const uid = String(entry.unique_id || '').toLowerCase();
        const tkey = String(entry.translation_key || '').toLowerCase();
        const eid = String(entry.entity_id || '').toLowerCase();
        return keys.some((key) => uid.endsWith(`_${key}`) || tkey === key || eid.endsWith(`_${key}`));
      });
      return found?.entity_id;
    };
    return {
      departure_time: byKey('departure'),
      start_time: byKey('start'),
      stop_time: byKey('stop'),
      running_time: byKey('runtime'),
      temperature: byKey('temperature'),
      temperature_source: byKey('temperature_source'),
      status: byKey('status'),
      heater_switch: byKey('heater', 'heater_switch'),
      enable_switch: byKey('enabled'),
      one_time_switch: byKey('manual_active'),
      manual_departure_time: byKey('manual_departure'),
      workday_departure_time: byKey('workday_departure'),
      start_now_button: byKey('start_now'),
      stop_button: byKey('stop_now'),
      runtime_curve: byKey('runtime_curve', 'heat_curve', 'heating_curve'),
      power_sensor: this.config?.power_sensor,
    };
  }

  obj(entity) { return entity ? this._hass?.states?.[entity] : undefined; }

  state(entity, fallback = '—') {
    const obj = this.obj(entity);
    if (!obj || obj.state === 'unknown' || obj.state === 'unavailable' || obj.state === '') return fallback;
    return obj.state;
  }

  unit(entity) { return this.obj(entity)?.attributes?.unit_of_measurement || ''; }

  fmt(entity, fallback = '—') {
    const value = this.state(entity, fallback);
    const unit = this.unit(entity);
    if (value === fallback) return value;
    return `${value}${unit ? ' ' + unit : ''}`;
  }

  friendlyStatus(raw) {
    const value = String(raw || '').toLowerCase();
    const map = {
      on: this.t('state.on'),
      off: this.t('state.off'),
      no_departure: this.t('status.no_departure'),
      idle: this.t('status.waiting'),
      waiting: this.t('status.waiting'),
      scheduled: this.t('status.scheduled'),
      running: this.t('status.running'),
      heating: this.t('status.running'),
      manual: this.t('status.manual'),
      start_now: this.t('status.start_now'),
      no_temperature: this.t('status.no_temperature'),
      no_heating_needed: this.t('status.no_heating_needed'),
      finished: this.t('status.finished'),
      disabled: this.t('status.disabled'),
      unavailable: this.t('status.unavailable'),
      unknown: this.t('status.unknown'),
    };
    return map[value] || String(raw || '—').replaceAll('_', ' ');
  }

  isHeaterRunning(e) {
    const attrs = this.statusAttributes();
    const nested = this.attrPath('heater_switch.is_on');
    if (typeof nested === 'boolean') return nested;
    if (typeof attrs.heater_switch_is_on === 'boolean') return attrs.heater_switch_is_on;
    const attrState = String(this.attrPath('heater_switch.state', attrs.heater_switch_state || '')).toLowerCase();
    if (attrState === 'on') return true;
    if (attrState === 'off') return false;
    const heaterState = this.state(e.heater_switch, '');
    if (heaterState === 'on') return true;
    if (heaterState === 'off') return false;
    const status = String(this.state(e.status, '')).toLowerCase();
    return ['running', 'heating', 'manual', 'start_now'].includes(status);
  }

  moreInfo(entity) {
    if (!entity) return;
    const ev = new Event('hass-more-info', { bubbles: true, composed: true });
    ev.detail = { entityId: entity };
    this.dispatchEvent(ev);
  }

  toggle(entity) {
    if (!entity || !this._hass) return;
    this._hass.callService('switch', 'toggle', { entity_id: entity });
  }

  press(entity) {
    if (!entity || !this._hass) return;
    this._hass.callService('button', 'press', { entity_id: entity });
  }

  setTime(entity, value) {
    if (!entity || !value || !this._hass) return;
    this._hass.callService('time', 'set_value', { entity_id: entity, time: value });
  }

  isUnavailable(entity) {
    const obj = this.obj(entity);
    return !obj || obj.state === 'unavailable';
  }

  bind() {
    const curveDetails = this.shadowRoot.querySelector('.curve-details');
    curveDetails?.addEventListener('toggle', () => { this._heatCurveOpen = curveDetails.open; });

    this.shadowRoot.querySelectorAll('[data-action]').forEach((el) => {
      const action = el.dataset.action;
      const entity = el.dataset.entity;
      el.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        if (el.hasAttribute('disabled')) return;
        if (action === 'toggle') this.toggle(entity);
        if (action === 'press') this.press(entity);
        if (action === 'more') this.moreInfo(entity);
        if (action === 'pick-time') this.openTimePicker(entity, el.dataset.label || this.t('time'));
      });
    });
  }

  timeSetting(entity, label) {
    if (!entity || !this.obj(entity)) return '';
    const value = this.state(entity, '00:00').slice(0, 5);
    return `<button class="time-set" data-action="pick-time" data-entity="${entity}" data-label="${label}">
      <span>${label}</span><strong>${value}</strong><ha-icon icon="mdi:clock-edit-outline"></ha-icon>
    </button>`;
  }

  numberOptions(max, selected) {
    let html = '';
    for (let i = 0; i <= max; i += 1) {
      const text = String(i).padStart(2, '0');
      html += `<option value="${text}" ${text === selected ? 'selected' : ''}>${text}</option>`;
    }
    return html;
  }

  openTimePicker(entity, label) {
    if (!entity || !this.obj(entity)) return;
    const current = this.state(entity, '00:00').slice(0, 5);
    const [h = '00', m = '00'] = current.split(':');
    this._timePicker = { entity, label, hour: h.padStart(2, '0'), minute: m.padStart(2, '0') };
    this.render();
  }

  closeTimePicker() {
    this._timePicker = null;
    this.render();
  }

  saveTimePicker() {
    const hour = this._timePicker?.hour || this.shadowRoot.querySelector('#ch-hour')?.value || '00';
    const minute = this._timePicker?.minute || this.shadowRoot.querySelector('#ch-minute')?.value || '00';
    const entity = this._timePicker?.entity;
    this.setTime(entity, `${hour}:${minute}:00`);
    this.closeTimePicker();
  }

  bindPicker() {
    const overlay = this.shadowRoot.querySelector('.picker-overlay');
    if (!overlay) return;
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) this.closeTimePicker();
    });
    const hour = this.shadowRoot.querySelector('#ch-hour');
    const minute = this.shadowRoot.querySelector('#ch-minute');
    hour?.addEventListener('change', () => { if (this._timePicker) this._timePicker.hour = hour.value; });
    minute?.addEventListener('change', () => { if (this._timePicker) this._timePicker.minute = minute.value; });
    this.shadowRoot.querySelector('.picker-cancel')?.addEventListener('click', () => this.closeTimePicker());
    this.shadowRoot.querySelector('.picker-save')?.addEventListener('click', () => this.saveTimePicker());
  }


  historyEnabled() {
    return this.config.show_temperature_graph || this.config.show_power_graph || this.config.show_runtime_history || this.config.show_planned_runtime;
  }

  graphHours() {
    const value = Number(this.config.graph_hours ?? 24);
    return Number.isFinite(value) && value > 0 ? Math.min(168, Math.max(1, value)) : 24;
  }

  runtimeHistoryDays() {
    const value = Number(this.config.runtime_history_days ?? 7);
    return Number.isFinite(value) && value > 0 ? Math.min(31, Math.max(1, value)) : 7;
  }

  async ensureHistory() {
    if (!this._hass || !this.historyEnabled()) return;

    const timelineHours = this.graphHours();
    const historyHours = Math.max(1, Math.ceil(timelineHours / 2));

    if (this.config.show_temperature_graph) this.loadHistory('temperature', this.temperatureEntity(), historyHours);
    if (this.config.show_power_graph) this.loadHistory('power', this.powerEntity(), historyHours);
    if (this.config.show_runtime_history) {
      const e = this.resolvedEntities;
      this.loadHistory('runtime', e.heater_switch || e.status || this.powerEntity(), this.runtimeHistoryDays() * 24);
    }
  }

  async loadHistory(kind, entity, hours) {
    if (!entity || !this._hass) return;
    const now = new Date();
    const cacheKey = `${kind}:${entity}:${hours}`;
    const cached = this._historyCache[cacheKey];
    if (cached && now.getTime() - cached.loaded < 2 * 60 * 1000) return;
    if (this._historyLoading.has(cacheKey)) return;
    this._historyLoading.add(cacheKey);
    try {
      const start = new Date(now.getTime() - hours * 60 * 60 * 1000);
      const result = await this._hass.callWS({
        type: 'history/history_during_period',
        start_time: start.toISOString(),
        end_time: now.toISOString(),
        entity_ids: [entity],
        significant_changes_only: false,
        minimal_response: false,
        no_attributes: true,
      });
      const rows = this.extractHistoryRows(result, entity);
      this._historyCache[cacheKey] = { loaded: now.getTime(), start, end: now, entity, rows };
      if (!this._timePicker) this.render();
    } catch (err) {
      console.warn(`car-heater-card: could not load ${kind} history for ${entity}`, err);
      this._historyCache[cacheKey] = { loaded: now.getTime(), start: new Date(now.getTime() - hours * 60 * 60 * 1000), end: now, entity, rows: [], error: String(err) };
    } finally {
      this._historyLoading.delete(cacheKey);
    }
  }

  extractHistoryRows(result, entity) {
    if (Array.isArray(result)) {
      if (Array.isArray(result[0])) return result[0];
      if (result.length && (result[0]?.state !== undefined || result[0]?.s !== undefined || result[0]?.last_changed || result[0]?.lc || result[0]?.lu)) return result;
      return [];
    }
    if (result && typeof result === 'object') {
      const direct = result[entity];
      if (Array.isArray(direct)) return Array.isArray(direct[0]) ? direct[0] : direct;
      const first = result[Object.keys(result)[0]];
      if (Array.isArray(first)) return Array.isArray(first[0]) ? first[0] : first;
    }
    return [];
  }

  history(kind, entity, hours) {
    return this._historyCache[`${kind}:${entity}:${hours}`];
  }

  historyRowState(row) {
    if (!row) return undefined;
    return row.state ?? row.s ?? row.State ?? row.value;
  }

  historyRowTimestamp(row) {
    if (!row) return NaN;
    const raw = row.last_changed ?? row.last_updated ?? row.lc ?? row.lu ?? row.t ?? row.time;
    if (raw === undefined || raw === null || raw === '') return NaN;
    if (typeof raw === 'number') {
      // Home Assistant frontend history may return milliseconds or seconds depending on API version.
      return raw > 100000000000 ? raw : raw * 1000;
    }
    const ts = new Date(raw).getTime();
    return Number.isFinite(ts) ? ts : NaN;
  }

  numericPoints(cache, entity, start, end) {
    const points = [];
    if (cache) {
      cache.rows.forEach((row) => {
        const value = Number(this.historyRowState(row));
        const ts = this.historyRowTimestamp(row);
        if (Number.isFinite(value) && Number.isFinite(ts) && ts >= start.getTime() && ts <= end.getTime()) {
          points.push({ ts, value });
        }
      });
    }

    const current = Number(this.state(entity, ''));
    if (Number.isFinite(current)) {
      const nowTs = end instanceof Date ? end.getTime() : Date.now();
      if (!points.length || Math.abs(points[points.length - 1].ts - nowTs) > 30000) {
        points.push({ ts: nowTs, value: current });
      }
    }

    return points
      .sort((a, b) => a.ts - b.ts)
      .filter((p, i, arr) => i === 0 || p.ts !== arr[i - 1].ts || p.value !== arr[i - 1].value);
  }

  timeToDateInRange(hhmm, start, end) {
    if (!hhmm || hhmm === '—') return [];
    const [hh, mm] = String(hhmm).slice(0, 5).split(':').map(Number);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) return [];
    const dates = [];
    const cursor = new Date(start);
    cursor.setHours(0, 0, 0, 0);
    cursor.setDate(cursor.getDate() - 1);
    const limit = new Date(end);
    limit.setHours(23, 59, 59, 999);
    limit.setDate(limit.getDate() + 1);
    while (cursor <= limit) {
      const d = new Date(cursor);
      d.setHours(hh, mm, 0, 0);
      if (d >= start && d <= end) dates.push(d);
      cursor.setDate(cursor.getDate() + 1);
    }
    return dates;
  }

  parseDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  statusAttributes() {
    const e = this.resolvedEntities;
    return this.obj(e.status)?.attributes || {};
  }

  attrPath(path, fallback = undefined) {
    const attrs = this.statusAttributes();
    const value = String(path).split('.').reduce((obj, part) => {
      if (obj && Object.prototype.hasOwnProperty.call(obj, part)) return obj[part];
      return undefined;
    }, attrs);
    return value === undefined || value === null || value === '' ? fallback : value;
  }

  dateAttr(name) {
    return this.parseDate(this.attrPath(name));
  }

  datePath(path) {
    return this.parseDate(this.attrPath(path));
  }

  temperatureEntity() {
    const e = this.resolvedEntities;
    return this.attrPath('temperature.entity_id') || this.attrPath('temperature_source') || e.temperature;
  }

  powerEntity() {
    const e = this.resolvedEntities;
    return this.attrPath('power_sensor.entity_id') || this.attrPath('power_entity_id') || e.power_sensor || this.config.power_sensor;
  }

  rangeFromPath(base, fallbackStart = null, fallbackStop = null) {
    const start = this.datePath(`${base}.start`) || (fallbackStart ? this.dateAttr(fallbackStart) : null);
    const stop = this.datePath(`${base}.stop`) || (fallbackStop ? this.dateAttr(fallbackStop) : null);
    return { start, stop };
  }

  clipRange(range, start, end) {
    if (!range?.start || !range?.stop) return null;
    const clippedStart = new Date(Math.max(range.start.getTime(), start.getTime()));
    const clippedStop = new Date(Math.min(range.stop.getTime(), end.getTime()));
    if (clippedStop <= clippedStart) return null;
    return { start: clippedStart, stop: clippedStop };
  }

  scheduledRanges(start, end) {
    const planned = this.rangeFromPath('timeline.planned', 'planned_start', 'planned_stop');
    const plannedRange = this.clipRange(planned, start, end);
    const departure = this.datePath('timeline.planned.departure') || this.dateAttr('planned_departure') || this.dateAttr('departure_datetime');
    const departures = departure && departure >= start && departure <= end ? [departure] : [];
    if (plannedRange || departures.length) {
      return { ranges: plannedRange ? [plannedRange] : [], departures };
    }

    const startAttr = this.dateAttr('start_datetime');
    const stopAttr = this.dateAttr('stop_datetime');
    const attrRange = this.clipRange({ start: startAttr, stop: stopAttr }, start, end);
    if (attrRange) return { ranges: [attrRange], departures };

    const e = this.resolvedEntities;
    const startVal = this.state(e.start_time, '');
    const stopVal = this.state(e.stop_time, '');
    const depVal = this.state(e.departure_time, '');
    const starts = this.timeToDateInRange(startVal, new Date(start.getTime() - 24 * 60 * 60 * 1000), end);
    const ranges = [];
    starts.forEach((s) => {
      const [eh, em] = String(stopVal).slice(0, 5).split(':').map(Number);
      if (!Number.isFinite(eh) || !Number.isFinite(em)) return;
      const stop = new Date(s);
      stop.setHours(eh, em, 0, 0);
      if (stop <= s) stop.setDate(stop.getDate() + 1);
      if (stop >= start && s <= end) ranges.push({ start: s, stop });
    });
    return { ranges, departures: this.timeToDateInRange(depVal, start, end) };
  }

  actualRuntimeRanges(start, end) {
    const ranges = [];
    const addRange = (range, allowOpen = false) => {
      let { start: a, stop: b } = range || {};
      if (!a) return;
      if (!b && allowOpen && this.isHeaterRunning(this.resolvedEntities)) b = new Date();
      const clipped = this.clipRange({ start: a, stop: b }, start, end);
      if (clipped) ranges.push(clipped);
    };

    const history = this.attrPath('timeline.history') || this.attrPath('run_history') || [];
    if (Array.isArray(history)) {
      history.forEach((run) => {
        const startValue = run?.start;
        const stopValue = run?.stop;
        const startDate = startValue ? new Date(startValue) : null;
        const stopDate = stopValue ? new Date(stopValue) : null;
        if (startDate && stopDate && !Number.isNaN(startDate.getTime()) && !Number.isNaN(stopDate.getTime())) {
          addRange({ start: startDate, stop: stopDate });
        }
      });
    }

    addRange(this.rangeFromPath('timeline.previous', 'previous_start', 'previous_stop'));
    addRange(this.rangeFromPath('timeline.current', 'current_start', 'current_stop'), true);

    // Backwards compatibility with older integration versions.
    if (!ranges.length) {
      let lastStop = this.dateAttr('last_stop');
      const lastStart = this.dateAttr('last_start');
      if (lastStart && !lastStop && this.isHeaterRunning(this.resolvedEntities)) lastStop = new Date();
      addRange({ start: lastStart, stop: lastStop });
    }

    return ranges.sort((a, b) => a.start - b.start);
  }

  linePath(points, x, y) {
    return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.ts).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ');
  }

  timelineAxisMode() {
    const mode = String(this.config.timeline_axis || 'relative').toLowerCase();
    return mode === 'clock' || mode === 'absolute' ? 'clock' : 'relative';
  }

  formatTimelineTick(date, offsetHours) {
    if (Math.abs(offsetHours) < 0.001) return this.t('now');
    if (this.timelineAxisMode() === 'clock') {
      return date.toLocaleTimeString(this.lang === 'sv' ? 'sv-SE' : 'en-US', { hour: '2-digit', minute: '2-digit' });
    }
    const sign = offsetHours < 0 ? '-' : '+';
    const abs = Math.abs(offsetHours);
    if (abs < 1) return `${sign}${Math.round(abs * 60)}m`;
    if (Number.isInteger(abs)) return `${sign}${abs}h`;
    const hours = Math.floor(abs);
    const minutes = Math.round((abs - hours) * 60);
    return hours > 0 ? `${sign}${hours}h${minutes ? ' ' + minutes + 'm' : ''}` : `${sign}${minutes}m`;
  }

  timelineTickOffsets(halfHours) {
    const h = Number(halfHours);
    if (!Number.isFinite(h) || h <= 0) return [0];
    if (h <= 0.5) return [-0.5, 0, 0.5].filter((v) => Math.abs(v) <= h + 0.001);
    if (h <= 1) return [-1, -0.5, 0, 0.5, 1].filter((v) => Math.abs(v) <= h + 0.001);
    if (h <= 2) return [-2, -1, 0, 1, 2].filter((v) => Math.abs(v) <= h + 0.001);
    if (h <= 3) return [-3, -2, -1, 0, 1, 2, 3].filter((v) => Math.abs(v) <= h + 0.001);
    if (h <= 6) return [-6, -4, -2, 0, 2, 4, 6].filter((v) => Math.abs(v) <= h + 0.001);
    if (h <= 12) return [-12, -8, -4, 0, 4, 8, 12].filter((v) => Math.abs(v) <= h + 0.001);
    const step = h <= 24 ? 12 : 24;
    const offsets = [];
    for (let v = -Math.floor(h / step) * step; v <= h + 0.001; v += step) {
      if (Math.abs(v) <= h + 0.001) offsets.push(v);
    }
    if (!offsets.includes(0)) offsets.push(0);
    return offsets.sort((a, b) => a - b);
  }

  chartTemplate() {
    const showTemp = !!this.config.show_temperature_graph;
    const showPower = !!this.config.show_power_graph;
    const showRuntime = !!this.config.show_runtime_history;
    const showPlan = !!this.config.show_planned_runtime;
    if (!showTemp && !showPower && !showRuntime && !showPlan) return '';

    const hours = this.graphHours();
    const halfHours = hours / 2;
    const historyHours = Math.max(1, Math.ceil(halfHours));
    const now = new Date();
    const graphStart = new Date(now.getTime() - halfHours * 60 * 60 * 1000);
    const graphEnd = new Date(now.getTime() + halfHours * 60 * 60 * 1000);

    const width = 640;
    const height = 226;
    const pad = { left: 68, right: 16, top: 18, bottom: 18 };
    const plotWidth = width - pad.left - pad.right;
    const plotRight = width - pad.right;
    const x = (ts) => pad.left + ((ts - graphStart.getTime()) / (graphEnd.getTime() - graphStart.getTime())) * plotWidth;
    const nowX = x(now.getTime());
    const valueX = nowX + ((plotRight - nowX) * 0.50);

    const lanes = {
      temp: { top: 24, bottom: 72, label: this.t('temperature') },
      power: { top: 88, bottom: 136, label: this.t('power') },
      runtime: { top: 156, bottom: 192, label: this.t('running_time') },
    };

    const laneGrid = Object.values(lanes).map((lane) => `
      <text class="lane-label" x="8" y="${((lane.top + lane.bottom) / 2).toFixed(1)}">${lane.label}</text>
      <line class="lane-grid" x1="${pad.left}" x2="${plotRight}" y1="${lane.bottom}" y2="${lane.bottom}"></line>
    `).join('');

    const makeTempSeries = () => {
      const entity = this.temperatureEntity();
      if (!entity) return null;
      const cache = this.history('temperature', entity, historyHours);
      const points = this.numericPoints(cache, entity, graphStart, now).filter((p) => p.ts >= graphStart.getTime() && p.ts <= now.getTime());
      if (!points.length) return null;
      let min = Infinity;
      let max = -Infinity;
      points.forEach((pnt) => { min = Math.min(min, pnt.value); max = Math.max(max, pnt.value); });
      if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
      if (min === max) { min -= 0.5; max += 0.5; }
      const range = Math.max(0.1, max - min);
      min -= range * 0.12;
      max += range * 0.12;
      const lane = lanes.temp;
      const y = (value) => lane.bottom - ((value - min) / (max - min)) * (lane.bottom - lane.top);
      const unit = this.attrPath('temperature.unit') || this.unit(entity) || '°C';
      return { key: 'temperature', entity, points, min, max, unit, lane, y };
    };

    const makePowerSeries = () => {
      const entity = this.powerEntity();
      if (!entity) return null;
      const cache = this.history('power', entity, historyHours);
      const points = this.numericPoints(cache, entity, graphStart, now).filter((p) => p.ts >= graphStart.getTime() && p.ts <= now.getTime());
      if (!points.length) return null;
      const positiveValues = points.map((pnt) => Math.max(0, pnt.value)).filter((value) => Number.isFinite(value));
      const max = Math.max(1, ...positiveValues);
      const lane = lanes.power;
      const y = (value) => lane.bottom - (Math.max(0, value) / max) * (lane.bottom - lane.top);
      const unit = this.attrPath('power_sensor.unit') || this.unit(entity) || 'W';
      return { key: 'power', entity, points, min: 0, max, unit, lane, y };
    };

    const tempSeries = showTemp ? makeTempSeries() : null;
    const powerSeries = showPower ? makePowerSeries() : null;

    const tempSvg = tempSeries ? (() => {
      const path = this.linePath(tempSeries.points, x, tempSeries.y);
      if (tempSeries.points.length > 1) return `<path class="temp-line" d="${path}"></path>`;
      const pnt = tempSeries.points[0];
      return `<circle class="temp-line-dot" cx="${x(pnt.ts).toFixed(1)}" cy="${tempSeries.y(pnt.value).toFixed(1)}" r="3.5"></circle>`;
    })() : '';

    const powerSvg = powerSeries ? (() => {
      const minBarWidth = 2.5;
      return powerSeries.points.map((pnt, index, arr) => {
        const x1 = Math.max(pad.left, x(pnt.ts));
        const nextTs = arr[index + 1]?.ts ?? now.getTime();
        const x2 = Math.min(nowX, x(nextTs));
        const barWidth = Math.max(minBarWidth, x2 - x1 - 1);
        if (x1 > nowX || x2 < pad.left) return '';
        const barTop = powerSeries.y(pnt.value);
        const barHeight = Math.max(1, powerSeries.lane.bottom - barTop);
        return `<rect class="power-bar" x="${x1.toFixed(1)}" y="${barTop.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="1.2"></rect>`;
      }).join('');
    })() : '';

    const currentValueLabel = (series, cls) => {
      if (!series?.points?.length) return '';
      const current = series.points[series.points.length - 1]?.value;
      if (!Number.isFinite(current)) return '';
      const decimals = Math.abs(current) < 20 ? 1 : 0;
      const yPos = ((series.lane.top + series.lane.bottom) / 2).toFixed(1);
      return `<text class="current-value ${cls}" x="${valueX.toFixed(1)}" y="${yPos}" text-anchor="middle">${current.toFixed(decimals)} ${series.unit}</text>`;
    };

    const valueLabels = `${currentValueLabel(tempSeries, 'temp-value')}${currentValueLabel(powerSeries, 'power-value')}`;

    const { ranges, departures } = this.scheduledRanges(graphStart, graphEnd);
    const actualRanges = showPlan ? this.actualRuntimeRanges(graphStart, now) : [];
    const bandHeight = 16;
    const runtimeBandY = lanes.runtime.top + 10;

    const bandRect = (cls, r, yPos) => {
      const x1 = Math.max(pad.left, x(r.start.getTime()));
      const x2 = Math.min(plotRight, x(r.stop.getTime()));
      if (x2 <= x1) return '';
      return `<rect class="${cls}" x="${x1.toFixed(1)}" y="${yPos}" width="${(x2 - x1).toFixed(1)}" height="${bandHeight}" rx="5"></rect>`;
    };

    const isCurrentRange = (r) => r.stop && Math.abs(r.stop.getTime() - now.getTime()) < 90000 && this.isHeaterRunning(this.resolvedEntities);
    const actualSvg = showPlan ? actualRanges.map((r) => bandRect(isCurrentRange(r) ? 'current-band' : 'actual-band', r, runtimeBandY)).join('') : '';
    const planSvg = showPlan ? ranges.map((r) => bandRect('planned-band', r, runtimeBandY)).join('') : '';

    const marker = (cls, date, label) => {
      if (!date || date < graphStart || date > graphEnd) return '';
      const xx = x(date.getTime()).toFixed(1);
      const y1 = lanes.runtime.top + 2;
      const y2 = lanes.runtime.bottom - 3;
      const labelY = lanes.runtime.top - 5;
      return `<line class="${cls}" x1="${xx}" x2="${xx}" y1="${y1}" y2="${y2}"></line><text class="axis-label marker-label" x="${xx}" y="${labelY}" text-anchor="middle">${label}</text>`;
    };

    const plannedMarkers = showPlan ? ranges.map((r) => `${marker('start-line', r.start, this.t('start'))}${marker('stop-line', r.stop, this.t('stop'))}`).join('') : '';
    const depSvg = showPlan ? departures.map((d) => marker('departure-line', d, this.t('departure'))).join('') : '';
    const nowSvg = `<line class="now-line" x1="${nowX.toFixed(1)}" x2="${nowX.toFixed(1)}" y1="${pad.top}" y2="${height - pad.bottom}"></line>`;

    const axisY = height - 8;
    const tickTop = height - pad.bottom;
    const tickBottom = tickTop + 5;
    const ticks = this.timelineTickOffsets(halfHours).map((offset) => {
      const tickDate = new Date(now.getTime() + offset * 60 * 60 * 1000);
      if (tickDate < graphStart || tickDate > graphEnd) return '';
      const xx = x(tickDate.getTime());
      const anchor = Math.abs(offset + halfHours) < 0.01 ? 'start' : Math.abs(offset - halfHours) < 0.01 ? 'end' : 'middle';
      const cls = Math.abs(offset) < 0.001 ? 'tick-label now-label' : 'tick-label';
      return `<line class="tick-line" x1="${xx.toFixed(1)}" x2="${xx.toFixed(1)}" y1="${tickTop}" y2="${tickBottom}"></line><text class="axis-label ${cls}" x="${xx.toFixed(1)}" y="${axisY}" text-anchor="${anchor}">${this.formatTimelineTick(tickDate, offset)}</text>`;
    }).join('');
    const ticksSvg = ticks;

    const missing = [];
    if (showTemp && !tempSeries) missing.push(this.t('temperature'));
    if (showPower && !powerSeries) missing.push(this.t('power'));
    const noData = missing.length ? `<text class="axis-label" x="${pad.left + 8}" y="${lanes.power.bottom + 14}">${this.t('no_history')}: ${missing.join(', ')}</text>` : '';

    const legend = [
      ...(showTemp ? [`<span><i class="dot temp"></i>${this.t('temperature')}</span>`] : []),
      ...(showPower ? [`<span><i class="dot power"></i>${this.t('power')}</span>`] : []),
      ...(showPlan ? [`<span><i class="dot actual"></i>${this.t('historical_runtime')}</span>`, `<span><i class="dot current"></i>${this.t('status.running')}</span>`, `<span><i class="dot plan"></i>${this.t('planned_runtime')}</span>`] : []),
    ].join('');

    const runtime = showRuntime ? this.runtimeHistoryTemplate() : '';

    return `<div class="graph-box">
      <div class="graph-head"><strong>${this.t('timeline')}</strong><span>${this.t('past_future')}</span></div>
      <svg class="history-graph" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
        <rect class="graph-bg" x="${pad.left}" y="${pad.top}" width="${plotWidth}" height="${height - pad.top - pad.bottom}"></rect>
        ${laneGrid}
        ${ticksSvg}
        ${depSvg}
        ${plannedMarkers}
        ${nowSvg}
        ${tempSvg}
        ${powerSvg}
        ${valueLabels}
        ${planSvg}
        ${actualSvg}
        ${noData}
      </svg>
      <div class="graph-legend">${legend}</div>
      ${runtime}
    </div>`;
  }



  runtimeCurveEntity() {
    const e = this.resolvedEntities;
    return e.runtime_curve || this.config.runtime_curve_entity;
  }

  heatCurveData() {
    const entity = this.runtimeCurveEntity();
    const obj = this.obj(entity);
    const attrs = obj?.attributes || {};
    const statusCurve = this.attrPath('runtime.curve');
    const curve = attrs.curve || statusCurve || [];
    const tempLimit = Number(attrs.temperature_limit ?? this.attrPath('runtime.temperature_limit'));
    const mode = String(attrs.mode || this.attrPath('runtime.mode') || obj?.state || '').toLowerCase();
    const curveMode = String(attrs.curve_mode || this.attrPath('runtime.curve_mode') || mode || '').toLowerCase();
    const points = Array.isArray(curve) ? curve.map((point) => {
      let delta;
      let minutes;
      if (Array.isArray(point)) {
        delta = Number(point[0]);
        minutes = Number(point[1]);
      } else if (point && typeof point === 'object') {
        delta = Number(point.delta ?? point.degrees_below_limit ?? point.x ?? point.temperature_delta);
        minutes = Number(point.minutes ?? point.runtime_minutes ?? point.y ?? point.value);
      }
      if (!Number.isFinite(delta) || !Number.isFinite(minutes)) return null;
      return {
        delta,
        minutes,
        temperature: Number.isFinite(tempLimit) ? tempLimit - delta : -delta,
      };
    }).filter(Boolean).sort((a, b) => b.temperature - a.temperature) : [];
    return { entity, points, tempLimit, mode, curveMode };
  }

  heatCurveTemplate() {
    const cfg = this.config || {};
    if (cfg.show_heat_curve === false) return '';
    const data = this.heatCurveData();
    if (!data.points.length) return '';

    const width = 360;
    const height = 118;
    const pad = { left: 28, right: 18, top: 12, bottom: 22 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const temps = data.points.map((p) => p.temperature).filter(Number.isFinite);
    const runtimes = data.points.map((p) => p.minutes).filter(Number.isFinite);
    if (!temps.length || !runtimes.length) return '';
    const minTemp = Math.min(...temps);
    const maxTemp = Math.max(...temps);
    const maxRuntime = Math.max(1, ...runtimes);
    const x = (temperature) => pad.left + ((temperature - minTemp) / Math.max(1, maxTemp - minTemp)) * plotW;
    const y = (minutes) => pad.top + plotH - (Math.max(0, minutes) / maxRuntime) * plotH;
    const path = data.points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.temperature).toFixed(1)} ${y(p.minutes).toFixed(1)}`).join(' ');
    const pointSvg = data.points.map((p) => `<circle class="curve-point" cx="${x(p.temperature).toFixed(1)}" cy="${y(p.minutes).toFixed(1)}" r="2.8"></circle>`).join('');
    const axis = data.points.map((p) => {
      const xx = x(p.temperature).toFixed(1);
      const label = `${p.temperature > 0 ? '+' : ''}${Math.round(p.temperature)}°`;
      return `<text class="curve-axis" x="${xx}" y="${height - 5}" text-anchor="middle">${label}</text>`;
    }).join('');
    const labelMode = data.curveMode.includes('manual') || data.mode.includes('manual') ? this.t('manual_calculation') : this.t('automatic_calculation');
    const currentTemp = Number(this.attrPath('temperature.current') ?? this.state(this.temperatureEntity(), ''));
    const currentRuntime = Number(this.attrPath('runtime.minutes'));
    const currentMarker = Number.isFinite(currentTemp) && currentTemp >= minTemp && currentTemp <= maxTemp
      ? `<line class="curve-current-line" x1="${x(currentTemp).toFixed(1)}" x2="${x(currentTemp).toFixed(1)}" y1="${pad.top}" y2="${height - pad.bottom}"></line>`
      : '';
    const runtimeText = Number.isFinite(currentRuntime) ? ` • ${Math.round(currentRuntime)} min` : '';
    const open = this._heatCurveOpen ? 'open' : '';
    return `<details class="curve-box curve-details" ${open}>
      <summary class="curve-summary">
        <strong>${this.t('heat_curve')}</strong>
        <span>${labelMode}${runtimeText}</span>
      </summary>
      <svg class="curve-graph" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
        <line class="curve-base" x1="${pad.left}" x2="${width - pad.right}" y1="${height - pad.bottom}" y2="${height - pad.bottom}"></line>
        <line class="curve-base" x1="${pad.left}" x2="${pad.left}" y1="${pad.top}" y2="${height - pad.bottom}"></line>
        ${currentMarker}
        <path class="curve-line" d="${path}"></path>
        ${pointSvg}
        ${axis}
      </svg>
    </details>`;
  }

  runtimeHistoryTemplate() {
    const e = this.resolvedEntities;
    const entity = e.heater_switch || e.status || e.power_sensor || this.config.power_sensor;
    const days = this.runtimeHistoryDays();
    const cache = this.history('runtime', entity, days * 24);
    const end = new Date();
    const history = this.attrPath('timeline.history') || this.attrPath('run_history') || [];
    const historyRanges = Array.isArray(history) ? history.map((run) => {
      const a = run?.start ? new Date(run.start) : null;
      const b = run?.stop ? new Date(run.stop) : null;
      return { start: a, stop: b };
    }).filter((r) => r.start && r.stop && !Number.isNaN(r.start.getTime()) && !Number.isNaN(r.stop.getTime()) && r.stop > r.start) : [];
    const previousRange = this.rangeFromPath('timeline.previous', 'previous_start', 'previous_stop');
    const currentRange = this.rangeFromPath('timeline.current', 'current_start', 'current_stop');
    if (currentRange.start && !currentRange.stop && this.isHeaterRunning(e)) currentRange.stop = end;
    const attributeRanges = [...historyRanges, previousRange, currentRange].filter((r) => r.start && r.stop && r.stop > r.start);
    const hasAttributeHistory = attributeRanges.length > 0;
    if (!cache && !hasAttributeHistory) return `<div class="runtime-history"><div class="label">${this.t('runtime_history')}</div><div class="empty">${this.t('loading')}</div></div>`;
    if (cache && !cache.rows.length && !hasAttributeHistory) return `<div class="runtime-history"><div class="label">${this.t('runtime_history')}</div><div class="empty">${this.t('no_history')}</div></div>`;
    const start = new Date(end);
    start.setDate(start.getDate() - days + 1);
    start.setHours(0, 0, 0, 0);
    const dayMs = 24 * 60 * 60 * 1000;
    const buckets = Array.from({ length: days }, (_, i) => {
      const d = new Date(start.getTime() + i * dayMs);
      return { date: d, minutes: 0 };
    });
    const threshold = Number(this.config.power_runtime_threshold ?? 50);
    const isOn = (row) => {
      if (entity?.startsWith('switch.') || entity?.startsWith('binary_sensor.')) return row.state === 'on';
      if (entity === e.status || entity?.includes('status')) return ['running', 'heating', 'manual', 'start_now'].includes(String(row.state).toLowerCase());
      return Number(row.state) > threshold;
    };
    const rows = (cache?.rows || []).map((row) => ({ state: row.state, ts: new Date(row.last_changed || row.last_updated).getTime() })).filter((r) => Number.isFinite(r.ts)).sort((a, b) => a.ts - b.ts);

    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i];
      const nextTs = i + 1 < rows.length ? rows[i + 1].ts : end.getTime();
      if (!isOn(r)) continue;
      let a = Math.max(r.ts, start.getTime());
      const b = Math.min(nextTs, end.getTime());
      while (a < b) {
        const dayIndex = Math.floor((a - start.getTime()) / dayMs);
        if (dayIndex < 0 || dayIndex >= buckets.length) break;
        const dayEnd = Math.min(b, start.getTime() + (dayIndex + 1) * dayMs);
        buckets[dayIndex].minutes += (dayEnd - a) / 60000;
        a = dayEnd;
      }
    }
    attributeRanges.forEach((range) => {
      let a = Math.max(range.start.getTime(), start.getTime());
      const b = Math.min(range.stop.getTime(), end.getTime());
      while (a < b) {
        const dayIndex = Math.floor((a - start.getTime()) / dayMs);
        if (dayIndex < 0 || dayIndex >= buckets.length) break;
        const dayEnd = Math.min(b, start.getTime() + (dayIndex + 1) * dayMs);
        buckets[dayIndex].minutes += (dayEnd - a) / 60000;
        a = dayEnd;
      }
    });
    const maxMinutes = Math.max(1, ...buckets.map((b) => b.minutes));
    const bars = buckets.map((b) => {
      const height = Math.max(2, Math.round((b.minutes / maxMinutes) * 42));
      const label = b.date.toLocaleDateString(this.lang === 'sv' ? 'sv-SE' : 'en-US', { weekday: 'short' });
      const time = b.minutes >= 60 ? `${Math.floor(b.minutes / 60)}h ${Math.round(b.minutes % 60)}m` : `${Math.round(b.minutes)}m`;
      return `<div class="runtime-day" title="${time}"><div class="runtime-bar" style="height:${height}px"></div><span>${label}</span></div>`;
    }).join('');
    return `<div class="runtime-history"><div class="label">${this.t('runtime_history')}</div><div class="runtime-bars">${bars}</div></div>`;
  }

  powerBar(powerEntity) {
    if (!powerEntity) return '';
    const raw = Number(this.state(powerEntity, '0'));
    const min = Number(this.config.power_min ?? 0);
    const max = Number(this.config.power_max ?? 2300);
    const pct = Number.isFinite(raw) && max > min ? Math.max(0, Math.min(100, ((raw - min) / (max - min)) * 100)) : 0;
    return `<div class="tile power-tile" data-action="more" data-entity="${powerEntity}">
      <div class="power-head"><div><div class="label">${this.t('power')}</div><div class="value">${this.fmt(powerEntity)}</div></div><ha-icon icon="mdi:flash"></ha-icon></div>
      <div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>
    </div>`;
  }

  pickerTemplate() {
    if (!this._timePicker) return '';
    return `<div class="picker-overlay">
      <div class="picker">
        <div class="picker-title">${this._timePicker.label}</div>
        <div class="wheel-row">
          <div class="wheel-col"><div class="wheel-label">${this.t('hour')}</div><select id="ch-hour" size="5">${this.numberOptions(23, this._timePicker.hour)}</select></div>
          <div class="colon">:</div>
          <div class="wheel-col"><div class="wheel-label">${this.t('minute')}</div><select id="ch-minute" size="5">${this.numberOptions(59, this._timePicker.minute)}</select></div>
        </div>
        <div class="picker-actions"><button class="picker-cancel">${this.t('cancel')}</button><button class="picker-save">${this.t('save')}</button></div>
      </div>
    </div>`;
  }

  render() {
    if (!this._hass || !this.config) return;
    const e = this.resolvedEntities;
    const title = this.config.title || this.t('title');
    const showSettings = this.config.show_time_settings !== false;

    const heater = this.state(e.heater_switch, '');
    const heaterOn = this.isHeaterRunning(e);
    const enabled = this.state(e.enable_switch, 'off');
    const once = this.state(e.one_time_switch, 'off');
    const status = this.friendlyStatus(this.state(e.status));
    const powerEntity = this.powerEntity();

    const startDisabled = this.isUnavailable(e.start_now_button);
    const stopDisabled = this.isUnavailable(e.stop_button);

    this.shadowRoot.innerHTML = `
      <ha-card>
        <style>
          .wrap { padding: 14px; }
          .head { display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:12px; }
          .title { font-size:20px; font-weight:700; display:flex; align-items:center; gap:8px; }
          .state-pill { padding:6px 10px; border-radius:999px; background:var(--secondary-background-color); font-size:13px; font-weight:700; text-transform:none; display:flex; align-items:center; gap:6px; }
          .state-pill ha-icon { --mdc-icon-size:18px; color:var(--disabled-text-color); }
          .state-pill.on ha-icon { color:#ffeb3b; filter:drop-shadow(0 0 4px rgba(255,235,59,.45)); }
          .times-box { border:1px solid var(--divider-color); border-radius:18px; background:var(--secondary-background-color); padding:12px; margin-bottom:12px; }
          .times-title { font-weight:700; margin-bottom:10px; display:flex; align-items:center; gap:6px; }
          .times { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; }
          .time { border-radius:13px; background:var(--card-background-color); padding:10px; cursor:pointer; min-width:0; }
          .label { font-size:12px; color:var(--secondary-text-color); margin-bottom:4px; white-space:nowrap; }
          .value { font-size:18px; font-weight:800; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

          .graph-box { border:1px solid var(--divider-color); border-radius:18px; background:var(--secondary-background-color); padding:12px; margin-bottom:12px; }
          .graph-head { display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:6px; }
          .graph-head span { color:var(--secondary-text-color); font-size:12px; }
          .history-graph { width:100%; height:214px; border-radius:14px 14px 6px 6px; background:var(--card-background-color); overflow:visible; display:block; }
          .graph-bg { fill:var(--card-background-color); }
          .lane-grid { stroke:var(--divider-color); stroke-width:1; opacity:.75; vector-effect:non-scaling-stroke; }
          .lane-label { fill:var(--secondary-text-color); font-size:11px; font-weight:700; dominant-baseline:middle; }
          .temp-line { fill:none; stroke:var(--info-color, #2196f3); stroke-width:2.6; stroke-linecap:round; stroke-linejoin:round; vector-effect:non-scaling-stroke; }
          .power-line { fill:none; stroke:#7e57c2; stroke-width:2.6; stroke-linecap:round; stroke-linejoin:round; vector-effect:non-scaling-stroke; }
          .power-bar { fill:#ab47bc; opacity:.82; }
          .temp-line-dot { fill:var(--info-color, #2196f3); stroke:var(--card-background-color); stroke-width:2; vector-effect:non-scaling-stroke; }
          .power-line-dot { fill:#7e57c2; stroke:var(--card-background-color); stroke-width:2; vector-effect:non-scaling-stroke; }
          .current-value { fill:var(--primary-text-color); font-size:17px; font-weight:800; dominant-baseline:middle; paint-order:stroke; stroke:var(--card-background-color); stroke-width:4px; stroke-linejoin:round; }
          .temp-value { fill:var(--info-color, #2196f3); }
          .power-value { fill:#ab47bc; }
          .planned-band { fill:rgba(255,152,0,.78); stroke:none; }
          .actual-band { fill:rgba(184,134,11,.86); stroke:none; }
          .current-band { fill:rgba(255,213,79,.94); stroke:none; }
          .now-line { stroke:#66bb6a; stroke-width:1.8; opacity:.95; vector-effect:non-scaling-stroke; }
          .axis-label { fill:var(--secondary-text-color); font-size:11px; dominant-baseline:middle; }
          .now-label { font-size:10px; opacity:.9; font-weight:700; }
          .departure-line { stroke:#42a5f5; stroke-width:1.8; stroke-dasharray:5 4; vector-effect:non-scaling-stroke; }
          .start-line { stroke:#ff9800; stroke-width:1.5; stroke-dasharray:3 4; vector-effect:non-scaling-stroke; }
          .stop-line { stroke:#ef5350; stroke-width:1.5; stroke-dasharray:3 4; vector-effect:non-scaling-stroke; }
          .tick-line { stroke:var(--divider-color); stroke-width:1; vector-effect:non-scaling-stroke; }
          .tick-label { font-size:10px; font-weight:700; }
          .timeline-axis { position:relative; height:20px; margin:3px 16px 0 68px; color:var(--secondary-text-color); font-size:11px; font-weight:700; }
          .timeline-axis span { position:absolute; top:0; transform:translateX(-50%); white-space:nowrap; }
          .timeline-axis span:nth-child(1) { transform:translateX(0); }
          .timeline-axis span:last-child { transform:translateX(-100%); }
          .marker-label { font-size:9px; opacity:.85; }
          .graph-legend { display:flex; flex-wrap:wrap; gap:10px; margin-top:8px; color:var(--secondary-text-color); font-size:12px; }
          .graph-legend span { display:flex; align-items:center; gap:5px; }
          .dot { width:9px; height:9px; border-radius:999px; display:inline-block; }
          .dot.temp { background:var(--info-color, #2196f3); }
          .dot.power { background:#ab47bc; }
          .dot.actual { background:#b8860b; }
          .dot.current { background:#ffd54f; }
          .dot.plan { background:#ff9800; }

          .curve-box { border:1px solid var(--divider-color); border-radius:18px; background:var(--secondary-background-color); padding:0; margin-bottom:12px; overflow:hidden; }
          .curve-summary { display:flex; justify-content:space-between; align-items:center; gap:8px; padding:12px; cursor:pointer; list-style:none; }
          .curve-summary::-webkit-details-marker { display:none; }
          .curve-summary::before { content:'▸'; color:var(--secondary-text-color); transition:transform .18s ease; font-size:12px; }
          .curve-details[open] .curve-summary::before { transform:rotate(90deg); }
          .curve-summary span { color:var(--secondary-text-color); font-size:12px; margin-left:auto; }
          .curve-graph { width:100%; height:120px; background:var(--card-background-color); display:block; border-top:1px solid var(--divider-color); }
          .curve-base { stroke:var(--divider-color); stroke-width:1; opacity:.75; vector-effect:non-scaling-stroke; }
          .curve-line { fill:none; stroke:var(--info-color, #2196f3); stroke-width:2.7; stroke-linecap:round; stroke-linejoin:round; vector-effect:non-scaling-stroke; }
          .curve-point { fill:var(--info-color, #2196f3); stroke:var(--card-background-color); stroke-width:1.5; vector-effect:non-scaling-stroke; }
          .curve-axis { fill:var(--secondary-text-color); font-size:9px; font-weight:700; dominant-baseline:middle; }
          .curve-current-line { stroke:var(--primary-text-color); stroke-width:1.2; stroke-dasharray:3 4; opacity:.7; vector-effect:non-scaling-stroke; }
          .runtime-history { margin-top:10px; }
          .runtime-bars { height:62px; display:flex; align-items:end; gap:7px; padding:8px 2px 0; }
          .runtime-day { flex:1; min-width:0; display:flex; flex-direction:column; align-items:center; gap:4px; color:var(--secondary-text-color); font-size:10px; }
          .runtime-bar { width:100%; max-width:22px; border-radius:6px 6px 2px 2px; background:var(--primary-color); min-height:2px; }
          .empty { color:var(--secondary-text-color); font-size:12px; padding:8px 0; }
          .main { display:grid; grid-template-columns:80px 1fr; gap:10px; margin-bottom:12px; }
          .heater-symbol { border:1px solid var(--divider-color); background:var(--secondary-background-color); border-radius:18px; display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:122px; cursor:default; }
          .heater-symbol ha-icon { --mdc-icon-size:42px; color:var(--disabled-text-color); }
          .heater-symbol.on ha-icon { color:#ffeb3b; filter: drop-shadow(0 0 5px rgba(255,235,59,.45)); }
          .heater-symbol .small { margin-top:5px; font-size:12px; color:var(--secondary-text-color); }
          .info-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
          .tile { border:1px solid var(--divider-color); border-radius:14px; background:var(--secondary-background-color); padding:10px; cursor:pointer; min-width:0; }
          .power-tile { grid-column:1 / -1; }
          .power-head { display:flex; justify-content:space-between; align-items:center; gap:8px; }
          .bar { height:12px; border-radius:999px; background:var(--divider-color); overflow:hidden; margin-top:10px; }
          .bar-fill { height:100%; border-radius:999px; background:var(--primary-color); transition:width .25s ease; }
          .chips { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; margin-bottom:12px; }
          .chip { border:1px solid var(--divider-color); border-radius:14px; background:var(--secondary-background-color); padding:11px; text-align:center; font-weight:800; cursor:pointer; }
          .chip.on { background:var(--primary-color); color:var(--text-primary-color); }
          .sub { display:block; opacity:.75; font-size:11px; font-weight:500; margin-top:2px; }
          .actions { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; margin-bottom:12px; }
          button { border:0; border-radius:14px; padding:12px 8px; font-weight:800; background:var(--secondary-background-color); color:var(--primary-text-color); display:flex; align-items:center; justify-content:center; gap:6px; cursor:pointer; font-family:inherit; }
          button.start { background:rgba(76,175,80,.22); }
          button.stop { background:rgba(244,67,54,.20); }
          button:disabled { opacity:.38; cursor:not-allowed; }
          .settings { border-top:1px solid var(--divider-color); padding-top:12px; display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; }
          .time-set { justify-content:space-between; padding:10px; border:1px solid var(--divider-color); }
          .time-set span { color:var(--secondary-text-color); font-size:12px; }
          .time-set strong { font-size:18px; }
          .picker-overlay { position:fixed; inset:0; z-index:999; background:rgba(0,0,0,.42); display:flex; align-items:center; justify-content:center; padding:20px; }
          .picker { width:min(360px, 100%); background:var(--card-background-color); color:var(--primary-text-color); border-radius:22px; padding:18px; box-shadow:0 12px 36px rgba(0,0,0,.35); }
          .picker-title { font-size:20px; font-weight:800; text-align:center; margin-bottom:12px; }
          .wheel-row { display:grid; grid-template-columns:1fr 24px 1fr; align-items:center; gap:6px; }
          .colon { text-align:center; font-size:32px; font-weight:800; color:var(--secondary-text-color); }
          .wheel-label { text-align:center; font-size:12px; color:var(--secondary-text-color); margin-bottom:4px; }
          select[size] { width:100%; text-align:center; border:1px solid var(--divider-color); border-radius:16px; background:var(--secondary-background-color); color:var(--primary-text-color); font-size:24px; font-weight:800; padding:6px; overflow-y:auto; }
          option { padding:8px; }
          .picker-actions { display:grid; grid-template-columns:repeat(2,1fr); gap:8px; margin-top:14px; }
          .picker-save { background:var(--primary-color); color:var(--text-primary-color); }
          @media (max-width:700px) {
            .times { grid-template-columns:repeat(2,minmax(0,1fr)); }
            .main { grid-template-columns:1fr; }
            .heater-symbol { min-height:80px; }
            .settings { grid-template-columns:1fr; }
          }
        </style>
        <div class="wrap">
          <div class="head">
            <div class="title"><ha-icon icon="mdi:car-clock"></ha-icon>${title}</div>
            <div class="state-pill ${heaterOn ? 'on' : 'off'}">${status}<ha-icon icon="mdi:car-seat-heater"></ha-icon></div>
          </div>

          <div class="times-box">
            <div class="times-title"><ha-icon icon="mdi:clock-outline"></ha-icon>${this.t('times')}</div>
            <div class="times">
              <div class="time" data-action="more" data-entity="${e.departure_time || ''}"><div class="label">${this.t('departure')}</div><div class="value">${this.state(e.departure_time)}</div></div>
              <div class="time" data-action="more" data-entity="${e.start_time || ''}"><div class="label">${this.t('start')}</div><div class="value">${this.state(e.start_time)}</div></div>
              <div class="time" data-action="more" data-entity="${e.stop_time || ''}"><div class="label">${this.t('stop')}</div><div class="value">${this.state(e.stop_time)}</div></div>
              <div class="time" data-action="more" data-entity="${e.running_time || ''}"><div class="label">${this.t('running_time')}</div><div class="value">${this.fmt(e.running_time)}</div></div>
            </div>
          </div>

          ${this.chartTemplate()}
          ${this.heatCurveTemplate()}

          <div class="chips">
            <div class="chip ${enabled === 'on' ? 'on' : ''}" data-action="toggle" data-entity="${e.enable_switch || ''}" >${this.t('enable')}<span class="sub">${enabled === 'on' ? this.t('state.on') : this.t('state.off')}</span></div>
            <div class="chip ${once === 'on' ? 'on' : ''}" data-action="toggle" data-entity="${e.one_time_switch || ''}" >${this.t('one_time')}<span class="sub">${once === 'on' ? this.t('state.on') : this.t('state.off')}</span></div>
          </div>

          <div class="actions">
            <button class="start" ${startDisabled ? 'disabled' : ''} data-action="press" data-entity="${e.start_now_button || ''}"><ha-icon icon="mdi:play"></ha-icon>${this.t('start_now')}</button>
            <button class="stop" ${stopDisabled ? 'disabled' : ''} data-action="press" data-entity="${e.stop_button || ''}"><ha-icon icon="mdi:stop"></ha-icon>${this.t('stop_now')}</button>
          </div>

          ${showSettings ? `<div class="settings">
            ${this.timeSetting(e.manual_departure_time, this.t('manual_departure'))}
            ${this.timeSetting(e.workday_departure_time, this.t('workday_departure'))}
          </div>` : ''}
        </div>
        ${this.pickerTemplate()}
      </ha-card>`;
    this.bind();
    this.bindPicker();
  }
}


class CarHeaterCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._devices = [];
    this._loaded = false;
  }

  setConfig(config) {
    this._config = config || {};
    if (!this._editorRendered || !this.hasActiveEditorFocus()) {
      this.render();
    }
  }

  set hass(hass) {
    this._hass = hass;
    this.loadDevices();
  }

  hasActiveEditorFocus() {
    const active = this.shadowRoot?.activeElement;
    return !!active && active !== this.shadowRoot;
  }

  isCarHeaterDevice(device) {
    const identifiers = Array.from(device?.identifiers || []);
    if (identifiers.some((identifier) => {
      if (Array.isArray(identifier)) return identifier[0] === 'car_heater';
      return String(identifier).includes('car_heater');
    })) return true;
    const name = String(device?.name_by_user || device?.name || '').toLowerCase();
    const manufacturer = String(device?.manufacturer || '').toLowerCase();
    const model = String(device?.model || '').toLowerCase();
    const entryType = String(device?.entry_type || '').toLowerCase();
    return name.includes('car heater') || name.includes('motorvärmare') || model.includes('car heater') || manufacturer.includes('car heater') || entryType.includes('car_heater');
  }

  isCarHeaterRegistryEntity(entry) {
    const platform = String(entry?.platform || '').toLowerCase();
    const uniqueId = String(entry?.unique_id || '').toLowerCase();
    const entityId = String(entry?.entity_id || '').toLowerCase();
    const translationKey = String(entry?.translation_key || '').toLowerCase();
    return platform === 'car_heater'
      || uniqueId.includes('car_heater')
      || uniqueId.includes('_departure')
      || uniqueId.includes('_runtime')
      || uniqueId.includes('_manual_active')
      || entityId.includes('car_heater')
      || translationKey === 'departure'
      || translationKey === 'runtime';
  }

  async loadDevices() {
    if (!this._hass || this._loaded || this._loading) return;
    this._loading = true;
    try {
      const devices = await this._hass.callWS({ type: 'config/device_registry/list' });
      this._devices = devices.filter((device) => this.isCarHeaterDevice(device));
      this._loaded = true;
      this.render();
    } catch (err) {
      console.warn('car-heater-card-editor: could not load devices', err);
    } finally {
      this._loading = false;
    }
  }

  valueChanged(changes) {
    const config = { ...(this._config || {}), ...changes };
    Object.keys(config).forEach((key) => {
      if (config[key] === '' || config[key] === undefined || config[key] === null) delete config[key];
    });
    this._config = config;
    this.dispatchEvent(new CustomEvent('config-changed', {
      detail: { config },
      bubbles: true,
      composed: true,
    }));
  }

  render() {
    if (!this.shadowRoot) return;
    const cfg = this._config || {};
    this._editorRendered = true;
    const deviceOptions = this._devices.map((device) => {
      const name = device.name_by_user || device.name || device.id;
      return `<option value="${device.id}" ${cfg.device_id === device.id ? 'selected' : ''}>${name}</option>`;
    }).join('');
    this.shadowRoot.innerHTML = `
      <style>
        .editor { display:grid; gap:12px; padding:8px 0; }
        label { display:grid; gap:4px; font-size:12px; color:var(--secondary-text-color); }
        input, select { box-sizing:border-box; width:100%; padding:8px; border-radius:8px; border:1px solid var(--divider-color); background:var(--card-background-color); color:var(--primary-text-color); }
        .hint { color:var(--secondary-text-color); font-size:12px; }
      </style>
      <div class="editor">
        <label>Car Heater device
          <select id="device">
            <option value="">Select Car Heater device</option>
            ${deviceOptions}
          </select>
        </label>
        <label>Title
          <input id="title" value="${cfg.title || ''}" placeholder="Car Heater">
        </label>
        <label>Language, optional
          <input id="language" value="${cfg.language || ''}" placeholder="sv / en / auto">
        </label>
        <label>Graph hours
          <input id="graph_hours" type="number" min="1" max="168" value="${cfg.graph_hours ?? 24}">
        </label>
        <label>Timeline axis
          <select id="timeline_axis">
            <option value="relative" ${cfg.timeline_axis !== 'clock' ? 'selected' : ''}>Relative</option>
            <option value="clock" ${cfg.timeline_axis === 'clock' ? 'selected' : ''}>Clock time</option>
          </select>
        </label>
        <label>Runtime history days
          <input id="runtime_days" type="number" min="1" max="31" value="${cfg.runtime_history_days ?? 7}">
        </label>
        <label>
          <span><input id="show_heat_curve" type="checkbox" ${cfg.show_heat_curve !== false ? 'checked' : ''}> Show heating curve</span>
        </label>
        <label>
          <span><input id="show_settings" type="checkbox" ${cfg.show_time_settings !== false ? 'checked' : ''}> Show time settings</span>
        </label>
        <label>
          <span><input id="show_temperature_graph" type="checkbox" ${cfg.show_temperature_graph ? 'checked' : ''}> Show temperature graph</span>
        </label>
        <label>
          <span><input id="show_power_graph" type="checkbox" ${cfg.show_power_graph ? 'checked' : ''}> Show power graph</span>
        </label>
        <label>
          <span><input id="show_planned_runtime" type="checkbox" ${cfg.show_planned_runtime ? 'checked' : ''}> Show planned runtime</span>
        </label>
        <label>
          <span><input id="show_runtime_history" type="checkbox" ${cfg.show_runtime_history ? 'checked' : ''}> Show daily runtime history</span>
        </label>
        <div class="hint">Select the Car Heater device. The card then reads the configured power sensor and timeline data from the integration.</div>
      </div>`;
    this.shadowRoot.querySelector('#device')?.addEventListener('change', (ev) => this.valueChanged({ device_id: ev.target.value, entities: undefined }));
    this.shadowRoot.querySelector('#title')?.addEventListener('input', (ev) => this.valueChanged({ title: ev.target.value }));
        this.shadowRoot.querySelector('#language')?.addEventListener('input', (ev) => this.valueChanged({ language: ev.target.value }));
    this.shadowRoot.querySelector('#show_heat_curve')?.addEventListener('change', (ev) => this.valueChanged({ show_heat_curve: ev.target.checked }));
    this.shadowRoot.querySelector('#show_settings')?.addEventListener('change', (ev) => this.valueChanged({ show_time_settings: ev.target.checked }));
    this.shadowRoot.querySelector('#show_temperature_graph')?.addEventListener('change', (ev) => this.valueChanged({ show_temperature_graph: ev.target.checked }));
    this.shadowRoot.querySelector('#show_power_graph')?.addEventListener('change', (ev) => this.valueChanged({ show_power_graph: ev.target.checked }));
    this.shadowRoot.querySelector('#show_planned_runtime')?.addEventListener('change', (ev) => this.valueChanged({ show_planned_runtime: ev.target.checked }));
    this.shadowRoot.querySelector('#show_runtime_history')?.addEventListener('change', (ev) => this.valueChanged({ show_runtime_history: ev.target.checked }));
    this.shadowRoot.querySelector('#graph_hours')?.addEventListener('input', (ev) => this.valueChanged({ graph_hours: Number(ev.target.value) || 24 }));
    this.shadowRoot.querySelector('#timeline_axis')?.addEventListener('change', (ev) => this.valueChanged({ timeline_axis: ev.target.value }));
    this.shadowRoot.querySelector('#runtime_days')?.addEventListener('input', (ev) => this.valueChanged({ runtime_history_days: Number(ev.target.value) || 7 }));
  }
}

customElements.define('car-heater-card-editor', CarHeaterCardEditor);

customElements.define('car-heater-card', CarHeaterCard);
window.customCards = window.customCards || [];
window.customCards.push({
  type: 'car-heater-card',
  name: 'Car Heater Card',
  description: 'Dashboard card for the Car Heater integration',
});
