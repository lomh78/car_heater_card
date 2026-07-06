const DEFAULT_LANGUAGE = 'en';

const CAR_HEATER_CARD_VERSION = '0.4.6';
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
    if (!this._hass || this._autoLoading || Object.keys(this.config?.entities || {}).length) return;
    const key = this.config?.device_id || '__first_car_heater_device__';
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
      disabled: this.t('status.disabled'),
      unavailable: this.t('status.unavailable'),
      unknown: this.t('status.unknown'),
    };
    return map[value] || String(raw || '—').replaceAll('_', ' ');
  }

  isHeaterRunning(e) {
    const attrs = this.statusAttributes();
    if (typeof attrs.heater_switch_is_on === 'boolean') return attrs.heater_switch_is_on;
    const attrState = String(attrs.heater_switch_state || '').toLowerCase();
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
    const e = this.resolvedEntities;
    if (this.config.show_temperature_graph) this.loadHistory('temperature', e.temperature, this.graphHours());
    if (this.config.show_power_graph) this.loadHistory('power', e.power_sensor || this.config.power_sensor, this.graphHours());
    if (this.config.show_planned_runtime) this.loadHistory('runtime_graph', e.heater_switch || e.status || e.power_sensor || this.config.power_sensor, this.graphHours(), true);
    if (this.config.show_runtime_history) this.loadHistory('runtime', e.heater_switch || e.status || e.power_sensor || this.config.power_sensor, this.runtimeHistoryDays() * 24, true);
  }

  async loadHistory(kind, entity, hours, forceFull = false) {
    if (!entity || !this._hass) return;
    const now = new Date();
    const cacheKey = `${kind}:${entity}:${hours}`;
    const cached = this._historyCache[cacheKey];
    if (cached && now.getTime() - cached.loaded < 5 * 60 * 1000) return;
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
      this._historyCache[cacheKey] = { loaded: now.getTime(), start, end: now, entity, rows, forceFull };
      if (!this._timePicker) this.render();
    } catch (err) {
      console.warn(`car-heater-card: could not load ${kind} history`, err);
    } finally {
      this._historyLoading.delete(cacheKey);
    }
  }

  extractHistoryRows(result, entity) {
    if (Array.isArray(result)) {
      if (Array.isArray(result[0])) return result[0];
      if (result.length && (result[0]?.state !== undefined || result[0]?.last_changed)) return result;
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

  numericPoints(cache, entity, start, end) {
    const points = [];
    if (cache) {
      cache.rows.forEach((row) => {
        const value = Number(row.state);
        const ts = new Date(row.last_changed || row.last_updated).getTime();
        if (Number.isFinite(value) && Number.isFinite(ts)) points.push({ ts, value });
      });
    }
    const current = Number(this.state(entity, ''));
    if (Number.isFinite(current)) {
      const nowTs = end instanceof Date ? end.getTime() : Date.now();
      if (!points.length || Math.abs(points[points.length - 1].ts - nowTs) > 30000) points.push({ ts: nowTs, value: current });
    }
    return points.filter((p, i, arr) => i === 0 || p.ts !== arr[i - 1].ts).sort((a, b) => a.ts - b.ts);
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

  dateAttr(name) {
    return this.parseDate(this.statusAttributes()?.[name]);
  }

  clipRange(range, start, end) {
    if (!range?.start || !range?.stop) return null;
    const clippedStart = new Date(Math.max(range.start.getTime(), start.getTime()));
    const clippedStop = new Date(Math.min(range.stop.getTime(), end.getTime()));
    if (clippedStop <= clippedStart) return null;
    return { start: clippedStart, stop: clippedStop };
  }

  scheduledRanges(start, end) {
    const e = this.resolvedEntities;
    const startAttr = this.dateAttr('start_datetime');
    const stopAttr = this.dateAttr('stop_datetime');
    const departureAttr = this.dateAttr('departure_datetime');
    const attrRange = this.clipRange({ start: startAttr, stop: stopAttr }, start, end);
    const attrDeparture = departureAttr && departureAttr >= start && departureAttr <= end ? [departureAttr] : [];
    if (attrRange || attrDeparture.length) {
      return { ranges: attrRange ? [attrRange] : [], departures: attrDeparture };
    }

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
    const departures = this.timeToDateInRange(depVal, start, end);
    return { ranges, departures };
  }

  actualRuntimeRanges(start, end) {
    const e = this.resolvedEntities;
    const lastStart = this.dateAttr('last_start');
    let lastStop = this.dateAttr('last_stop');
    const running = this.isHeaterRunning(e);

    // Prefer the integration's own exact timestamps. History can be sparse,
    // especially while the heater is currently running, but these attributes
    // are updated when the integration turns the output on/off.
    if (lastStart) {
      if (!lastStop || (running && lastStop < lastStart)) lastStop = new Date();
      const exact = this.clipRange({ start: lastStart, stop: lastStop }, start, end);
      if (exact) return [exact];
    }

    const entity = e.heater_switch || e.status || e.power_sensor || this.config.power_sensor;
    const cache = this.history('runtime_graph', entity, this.graphHours());
    const rows = (cache?.rows || [])
      .map((row) => ({ state: row.state, ts: new Date(row.last_changed || row.last_updated).getTime() }))
      .filter((r) => Number.isFinite(r.ts))
      .sort((a, b) => a.ts - b.ts);
    const threshold = Number(this.config.power_runtime_threshold ?? 50);
    const isOn = (state) => {
      if (entity?.startsWith('switch.') || entity?.startsWith('binary_sensor.')) return state === 'on';
      if (entity === e.status || entity?.includes('status')) return ['running', 'heating', 'manual', 'start_now'].includes(String(state).toLowerCase());
      return Number(state) > threshold;
    };
    if (!rows.length) return [];

    const ranges = [];
    for (let i = 0; i < rows.length; i += 1) {
      if (!isOn(rows[i].state)) continue;
      const a = new Date(Math.max(rows[i].ts, start.getTime()));
      const b = new Date(Math.min(i + 1 < rows.length ? rows[i + 1].ts : end.getTime(), end.getTime()));
      if (b > a) ranges.push({ start: a, stop: b });
    }
    return ranges;
  }

  linePath(points, x, y) {
    return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.ts).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ');
  }

  chartTemplate() {
    const e = this.resolvedEntities;
    const showTemp = !!this.config.show_temperature_graph;
    const showPower = !!this.config.show_power_graph;
    const showRuntime = !!this.config.show_runtime_history;
    const showPlan = !!this.config.show_planned_runtime;
    if (!showTemp && !showPower && !showRuntime && !showPlan) return '';

    const hours = this.graphHours();
    const halfHours = hours / 2;
    const now = new Date();
    const graphStart = new Date(now.getTime() - halfHours * 60 * 60 * 1000);
    const graphEnd = new Date(now.getTime() + halfHours * 60 * 60 * 1000);
    const width = 600;
    const height = 196;
    const pad = { left: 42, right: 14, top: 16, bottom: 44 };
    const plotBottom = height - pad.bottom;
    const plotHeight = plotBottom - pad.top;
    const x = (ts) => pad.left + ((ts - graphStart.getTime()) / (graphEnd.getTime() - graphStart.getTime())) * (width - pad.left - pad.right);
    const nowX = x(now.getTime());

    const buildSeries = (key, label, entity, cacheKind, cls, unit) => {
      if (!entity) return null;
      const cache = this.history(cacheKind, entity, hours);
      const points = this.numericPoints(cache, entity, graphStart, now).filter((p) => p.ts >= graphStart.getTime() && p.ts <= now.getTime());
      if (!points.length) return null;
      let min = Infinity;
      let max = -Infinity;
      points.forEach((p) => { min = Math.min(min, p.value); max = Math.max(max, p.value); });
      if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
      if (min === max) { min -= 1; max += 1; }
      const range = max - min;
      min -= range * 0.10;
      max += range * 0.10;
      return { key, label, entity, points, min, max, unit, cls };
    };

    const series = [];
    if (showTemp) {
      const tempSeries = buildSeries('temperature', this.t('temperature'), e.temperature, 'temperature', 'temp-line', this.unit(e.temperature) || '°C');
      if (tempSeries) series.push(tempSeries);
    }
    if (showPower) {
      const pEntity = e.power_sensor || this.config.power_sensor;
      const powerSeries = buildSeries('power', this.t('power'), pEntity, 'power', 'power-line', this.unit(pEntity) || 'W');
      if (powerSeries) series.push(powerSeries);
    }

    const yForSeries = (s, value) => pad.top + (1 - (value - s.min) / (s.max - s.min)) * plotHeight;
    const linesSvg = series.map((s) => {
      if (s.points.length > 1) return `<path class="${s.cls}" d="${this.linePath(s.points, x, (v) => yForSeries(s, v))}"></path>`;
      const p = s.points[0];
      return `<circle class="${s.cls}-dot" cx="${x(p.ts).toFixed(1)}" cy="${yForSeries(s, p.value).toFixed(1)}" r="3.5"></circle>`;
    }).join('');

    const seriesLabels = series.map((s, index) => {
      const y = pad.top + 13 + index * 16;
      const current = s.points[s.points.length - 1]?.value;
      const decimals = Math.abs(current) < 20 ? 1 : 0;
      const text = Number.isFinite(current) ? `${s.label}: ${current.toFixed(decimals)} ${s.unit}` : s.label;
      return `<text class="axis-label ${s.key}-label" x="${width - pad.right - 4}" y="${y}" text-anchor="end">${text}</text>`;
    }).join('');

    const { ranges, departures } = this.scheduledRanges(graphStart, graphEnd);
    const actualRanges = showPlan ? this.actualRuntimeRanges(graphStart, now) : [];
    const bandHeight = 8;
    const actualY = plotBottom + 7;
    const plannedY = plotBottom + 20;

    const bandRect = (cls, r, yPos) => {
      const x1 = Math.max(pad.left, x(r.start.getTime()));
      const x2 = Math.min(width - pad.right, x(r.stop.getTime()));
      if (x2 <= x1) return '';
      return `<rect class="${cls}" x="${x1.toFixed(1)}" y="${yPos}" width="${(x2 - x1).toFixed(1)}" height="${bandHeight}" rx="4"></rect>`;
    };

    const marker = (cls, date, label, y2 = plotBottom + 31) => {
      if (!date || date < graphStart || date > graphEnd) return '';
      const xx = x(date.getTime()).toFixed(1);
      return `<line class="${cls}" x1="${xx}" x2="${xx}" y1="${pad.top}" y2="${y2}"></line><text class="axis-label marker-label" x="${xx}" y="${pad.top - 4}" text-anchor="middle">${label}</text>`;
    };

    const actualSvg = showPlan ? actualRanges.map((r) => bandRect('actual-band', r, actualY)).join('') : '';
    const planSvg = showPlan ? ranges.map((r) => bandRect('planned-band', r, plannedY)).join('') : '';

    const plannedMarkers = showPlan ? ranges.map((r) => `${marker('start-line', r.start, this.t('start'))}${marker('stop-line', r.stop, this.t('stop'))}`).join('') : '';
    const actualMarkers = showPlan ? actualRanges.map((r) => `${marker('actual-start-line', r.start, this.t('start'))}${marker('actual-stop-line', r.stop, this.t('stop'))}`).join('') : '';
    const depSvg = showPlan ? departures.map((d) => marker('departure-line', d, this.t('departure'))).join('') : '';
    const nowSvg = `<line class="now-line" x1="${nowX.toFixed(1)}" x2="${nowX.toFixed(1)}" y1="${pad.top}" y2="${plotBottom + 31}"></line><text class="axis-label now-label" x="${nowX.toFixed(1)}" y="${height - 5}" text-anchor="middle">${this.t('now')}</text>`;

    const tickStep = halfHours <= 4 ? 1 : halfHours <= 8 ? 2 : halfHours <= 12 ? 3 : 6;
    const ticks = [];
    for (let h = -Math.floor(halfHours); h <= Math.floor(halfHours); h += tickStep) {
      if (h === 0) continue;
      const tickDate = new Date(now.getTime() + h * 60 * 60 * 1000);
      if (tickDate < graphStart || tickDate > graphEnd) continue;
      const xx = x(tickDate.getTime()).toFixed(1);
      const label = h < 0 ? `${h}h` : `+${h}h`;
      ticks.push(`<line class="tick-line" x1="${xx}" x2="${xx}" y1="${plotBottom}" y2="${plotBottom + 4}"></line><text class="axis-label tick-label" x="${xx}" y="${height - 5}" text-anchor="middle">${label}</text>`);
    }
    const ticksSvg = ticks.join('');

    const axisText = series.length === 1
      ? `<text class="axis-label" x="4" y="${pad.top + 4}">${series[0].max.toFixed(series[0].max < 20 ? 1 : 0)} ${series[0].unit}</text><text class="axis-label" x="4" y="${plotBottom + 4}">${series[0].min.toFixed(series[0].min < 20 ? 1 : 0)} ${series[0].unit}</text>`
      : '';

    const noData = (showTemp || showPower) && !series.length
      ? `<text class="axis-label" x="${width / 2}" y="${pad.top + plotHeight / 2}" text-anchor="middle">${this.t('no_history')}</text>`
      : '';

    const legend = [
      ...(showTemp ? [`<span><i class="dot temp"></i>${this.t('temperature')}</span>`] : []),
      ...(showPower ? [`<span><i class="dot power"></i>${this.t('power')}</span>`] : []),
      ...(showPlan ? [`<span><i class="dot actual"></i>${this.t('actual_runtime')}</span>`, `<span><i class="dot plan"></i>${this.t('planned_runtime')}</span>`] : []),
    ].join('');

    const runtime = showRuntime ? this.runtimeHistoryTemplate() : '';

    return `<div class="graph-box">
      <div class="graph-head"><strong>${this.t('graph')}</strong><span>${this.t('past_future')}</span></div>
      <svg class="history-graph" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
        <line class="grid" x1="${pad.left}" x2="${width - pad.right}" y1="${pad.top}" y2="${pad.top}"></line>
        <line class="grid" x1="${pad.left}" x2="${width - pad.right}" y1="${plotBottom}" y2="${plotBottom}"></line>
        ${axisText}
        ${ticksSvg}
        ${depSvg}
        ${plannedMarkers}
        ${actualMarkers}
        ${nowSvg}
        ${linesSvg}
        ${seriesLabels}
        ${actualSvg}
        ${planSvg}
        ${noData}
      </svg>
      <div class="graph-legend">${legend}</div>
      ${runtime}
    </div>`;
  }

  runtimeHistoryTemplate() {
    const e = this.resolvedEntities;
    const entity = e.heater_switch || e.status || e.power_sensor || this.config.power_sensor;
    const days = this.runtimeHistoryDays();
    const cache = this.history('runtime', entity, days * 24);
    const end = new Date();
    const lastStart = this.dateAttr('last_start');
    const lastStop = this.dateAttr('last_stop') || (this.isHeaterRunning(e) ? end : null);
    const hasAttributeHistory = !!(lastStart && lastStop && lastStop > lastStart);
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
    if (hasAttributeHistory) {
      let a = Math.max(lastStart.getTime(), start.getTime());
      const b = Math.min(lastStop.getTime(), end.getTime());
      while (a < b) {
        const dayIndex = Math.floor((a - start.getTime()) / dayMs);
        if (dayIndex < 0 || dayIndex >= buckets.length) break;
        const dayEnd = Math.min(b, start.getTime() + (dayIndex + 1) * dayMs);
        buckets[dayIndex].minutes += (dayEnd - a) / 60000;
        a = dayEnd;
      }
    }
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
    const powerEntity = e.power_sensor || this.config.power_sensor;

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
          .history-graph { width:100%; height:150px; border-radius:14px; background:var(--card-background-color); }
          .grid { stroke:var(--divider-color); stroke-width:1; }
          .temp-line { fill:none; stroke:var(--info-color, #2196f3); stroke-width:3; stroke-linecap:round; stroke-linejoin:round; vector-effect:non-scaling-stroke; }
          .power-line { fill:none; stroke:#ab47bc; stroke-width:3; stroke-linecap:round; stroke-linejoin:round; vector-effect:non-scaling-stroke; }
          .temp-line-dot { fill:var(--info-color, #2196f3); stroke:var(--card-background-color); stroke-width:2; vector-effect:non-scaling-stroke; }
          .power-line-dot { fill:#ab47bc; stroke:var(--card-background-color); stroke-width:2; vector-effect:non-scaling-stroke; }
          .planned-band { fill:rgba(255,193,7,.75); stroke:none; }
          .actual-band { fill:rgba(255,152,0,.80); stroke:none; }
          .now-line { stroke:#4caf50; stroke-width:1.6; opacity:.95; vector-effect:non-scaling-stroke; }
          .axis-label { fill:var(--secondary-text-color); font-size:11px; dominant-baseline:middle; }
          .now-label { font-size:10px; opacity:.85; }
          .departure-line { stroke:#42a5f5; stroke-width:1.8; stroke-dasharray:5 4; vector-effect:non-scaling-stroke; }
          .start-line, .actual-start-line { stroke:#ff9800; stroke-width:1.6; stroke-dasharray:3 4; vector-effect:non-scaling-stroke; }
          .stop-line, .actual-stop-line { stroke:#ef5350; stroke-width:1.6; stroke-dasharray:3 4; vector-effect:non-scaling-stroke; }
          .tick-line { stroke:var(--divider-color); stroke-width:1; vector-effect:non-scaling-stroke; }
          .tick-label { font-size:9.5px; }
          .marker-label { font-size:9px; opacity:.85; }
          .graph-legend { display:flex; flex-wrap:wrap; gap:10px; margin-top:8px; color:var(--secondary-text-color); font-size:12px; }
          .graph-legend span { display:flex; align-items:center; gap:5px; }
          .dot { width:9px; height:9px; border-radius:999px; display:inline-block; }
          .dot.temp { background:var(--info-color, #2196f3); }
          .dot.power { background:#ab47bc; }
          .dot.actual { background:#ff9800; }
          .dot.plan { background:#ffeb3b; }
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
            <option value="">Auto detect</option>
            ${deviceOptions}
          </select>
        </label>
        <label>Title
          <input id="title" value="${cfg.title || ''}" placeholder="Car Heater">
        </label>
        <label>Power sensor, optional
          <input id="power" value="${cfg.power_sensor || cfg.entities?.power_sensor || ''}" placeholder="sensor.motorvarmare_forbrukning">
        </label>
        <label>Language, optional
          <input id="language" value="${cfg.language || ''}" placeholder="sv / en / auto">
        </label>
        <label>Graph hours
          <input id="graph_hours" type="number" min="1" max="168" value="${cfg.graph_hours ?? 24}">
        </label>
        <label>Runtime history days
          <input id="runtime_days" type="number" min="1" max="31" value="${cfg.runtime_history_days ?? 7}">
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
        <div class="hint">The card detects entities from the selected Car Heater device. Use YAML only if you want to override individual entity IDs.</div>
      </div>`;
    this.shadowRoot.querySelector('#device')?.addEventListener('change', (ev) => this.valueChanged({ device_id: ev.target.value, entities: undefined }));
    this.shadowRoot.querySelector('#title')?.addEventListener('change', (ev) => this.valueChanged({ title: ev.target.value }));
    this.shadowRoot.querySelector('#power')?.addEventListener('change', (ev) => this.valueChanged({ power_sensor: ev.target.value }));
    this.shadowRoot.querySelector('#language')?.addEventListener('change', (ev) => this.valueChanged({ language: ev.target.value }));
    this.shadowRoot.querySelector('#show_settings')?.addEventListener('change', (ev) => this.valueChanged({ show_time_settings: ev.target.checked }));
    this.shadowRoot.querySelector('#show_temperature_graph')?.addEventListener('change', (ev) => this.valueChanged({ show_temperature_graph: ev.target.checked }));
    this.shadowRoot.querySelector('#show_power_graph')?.addEventListener('change', (ev) => this.valueChanged({ show_power_graph: ev.target.checked }));
    this.shadowRoot.querySelector('#show_planned_runtime')?.addEventListener('change', (ev) => this.valueChanged({ show_planned_runtime: ev.target.checked }));
    this.shadowRoot.querySelector('#show_runtime_history')?.addEventListener('change', (ev) => this.valueChanged({ show_runtime_history: ev.target.checked }));
    this.shadowRoot.querySelector('#graph_hours')?.addEventListener('change', (ev) => this.valueChanged({ graph_hours: Number(ev.target.value) || 24 }));
    this.shadowRoot.querySelector('#runtime_days')?.addEventListener('change', (ev) => this.valueChanged({ runtime_history_days: Number(ev.target.value) || 7 }));
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
