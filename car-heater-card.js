const DEFAULT_LANGUAGE = 'en';

class CarHeaterCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._timePicker = null;
    this._translations = {};
    this._loadedLanguages = new Set();
    this._loadingLanguages = new Set();
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
      const device = devices.find((d) =>
        (d.identifiers || []).some((identifier) => Array.isArray(identifier) && identifier[0] === 'car_heater')
      );
      targetDeviceId = device?.id;
    }
    if (!targetDeviceId) return {};
    const deviceEntities = entities.filter((entry) => entry.device_id === targetDeviceId);
    const byKey = (key) => {
      const found = deviceEntities.find((entry) => {
        const uid = String(entry.unique_id || '');
        const tkey = String(entry.translation_key || '');
        return uid.endsWith(`_${key}`) || tkey === key;
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

    const heater = this.state(e.heater_switch, 'off');
    const heaterOn = heater === 'on';
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
          .state-pill { padding:6px 10px; border-radius:999px; background:var(--secondary-background-color); font-size:13px; font-weight:700; text-transform:none; }
          .times-box { border:1px solid var(--divider-color); border-radius:18px; background:var(--secondary-background-color); padding:12px; margin-bottom:12px; }
          .times-title { font-weight:700; margin-bottom:10px; display:flex; align-items:center; gap:6px; }
          .times { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; }
          .time { border-radius:13px; background:var(--card-background-color); padding:10px; cursor:pointer; min-width:0; }
          .label { font-size:12px; color:var(--secondary-text-color); margin-bottom:4px; white-space:nowrap; }
          .value { font-size:18px; font-weight:800; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
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
            <div class="state-pill">${status}</div>
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

          <div class="main">
            <div class="heater-symbol ${heaterOn ? 'on' : ''}">
              <ha-icon icon="mdi:car-seat-heater"></ha-icon>
              <div class="small">${heaterOn ? this.t('state.on') : this.t('state.off')}</div>
            </div>
            <div class="info-grid">
              <div class="tile" data-action="more" data-entity="${e.temperature || ''}"><div class="label">${this.t('temperature')}</div><div class="value">${this.fmt(e.temperature)}</div></div>
              <div class="tile" data-action="more" data-entity="${e.temperature_source || ''}"><div class="label">${this.t('temperature_source')}</div><div class="value">${this.state(e.temperature_source)}</div></div>
              ${this.powerBar(powerEntity)}
            </div>
          </div>

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
    this.render();
  }

  set hass(hass) {
    this._hass = hass;
    this.loadDevices();
    this.render();
  }

  async loadDevices() {
    if (!this._hass || this._loaded || this._loading) return;
    this._loading = true;
    try {
      const devices = await this._hass.callWS({ type: 'config/device_registry/list' });
      this._devices = devices.filter((device) =>
        (device.identifiers || []).some((identifier) => Array.isArray(identifier) && identifier[0] === 'car_heater')
      );
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
    this.render();
  }

  render() {
    if (!this.shadowRoot) return;
    const cfg = this._config || {};
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
        <label>
          <span><input id="show_settings" type="checkbox" ${cfg.show_time_settings !== false ? 'checked' : ''}> Show time settings</span>
        </label>
        <div class="hint">The card detects entities from the selected Car Heater device. Use YAML only if you want to override individual entity IDs.</div>
      </div>`;
    this.shadowRoot.querySelector('#device')?.addEventListener('change', (ev) => this.valueChanged({ device_id: ev.target.value, entities: undefined }));
    this.shadowRoot.querySelector('#title')?.addEventListener('change', (ev) => this.valueChanged({ title: ev.target.value }));
    this.shadowRoot.querySelector('#power')?.addEventListener('change', (ev) => this.valueChanged({ power_sensor: ev.target.value }));
    this.shadowRoot.querySelector('#language')?.addEventListener('change', (ev) => this.valueChanged({ language: ev.target.value }));
    this.shadowRoot.querySelector('#show_settings')?.addEventListener('change', (ev) => this.valueChanged({ show_time_settings: ev.target.checked }));
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
