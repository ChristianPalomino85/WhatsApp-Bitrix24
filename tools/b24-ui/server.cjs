#!/usr/bin/env node
const express = require('express');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));

const PORT = Number(process.env.PORT || 3060);
const META_TOKEN = process.env.META_WABA_TOKEN || process.env.META_TOKEN || '';
const WABA_ID = process.env.META_WABA_ID || process.env.META_WABAID || process.env.WABA_ID || '';
const DEFAULT_LANGUAGE = process.env.DEFAULT_LANGUAGE || process.env.DEFAULT_TEMPLATE_LANG || 'es_PE';
const API_VERSION = process.env.META_API_VERSION || 'v20.0';
const FALLBACK_VERSIONS = Array.from(new Set([API_VERSION, 'v20.0', 'v19.0', 'v17.0']));
const CACHE_TTL_MS = 60 * 1000;
const DRY_RUN = String(process.env.DRY_RUN || '').toLowerCase() === 'true';

const TOKEN_PRESENT = Boolean(META_TOKEN);

const PHONE_IDS = (() => {
  const explicit = (process.env.META_PHONE_IDS || '')
    .split(',')
    .map((value) => value && value.trim())
    .filter(Boolean);
  if (explicit.length) return explicit;
  const legacy = [process.env.DEFAULT_SENDER, process.env.PHONE_ID_1, process.env.PHONE_ID_2, process.env.PHONE_ID_3].filter(Boolean);
  return Array.from(new Set(legacy));
})();

const DEFAULT_SENDER = (() => {
  if (process.env.DEFAULT_SENDER && process.env.DEFAULT_SENDER.trim()) {
    return process.env.DEFAULT_SENDER.trim();
  }
  return PHONE_IDS[0] || '';
})();

const cache = {
  senders: null,
  templates: null,
};

const SAFE_VARIABLE_KEYS = new Set(['body', 'header', 'header_text', 'header_media_url', 'header_media', 'buttons']);

function redact(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (lower.includes('token') || lower.includes('secret') || lower.includes('authorization')) {
      return '[redactado]';
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    return Object.keys(value).reduce((acc, key) => {
      const lower = key.toLowerCase();
      if (lower.includes('token') || lower.includes('secret') || lower.includes('auth')) {
        return acc;
      }
      acc[key] = redact(value[key]);
      return acc;
    }, {});
  }
  return value;
}

function safeJson(data) {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function normalizeRecipient(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const allowed = trimmed.replace(/[^0-9+]/g, '');
  if (!allowed) return null;
  if (allowed.startsWith('+')) {
    return `+${allowed.replace(/[^0-9]/g, '')}`;
  }
  let clean = allowed.replace(/[^0-9]/g, '');
  if (clean.startsWith('00')) {
    clean = clean.replace(/^0+/, '');
  }
  if (clean.startsWith('51')) {
    return `+${clean}`;
  }
  if (clean.startsWith('9')) {
    return `+51${clean}`;
  }
  if (clean.length >= 8) {
    return `+${clean}`;
  }
  return null;
}

function splitRecipients(input) {
  if (!input || typeof input !== 'string') return [];
  const unique = new Set();
  input
    .split(/\r?\n/)
    .map((entry) => normalizeRecipient(entry))
    .filter(Boolean)
    .forEach((recipient) => unique.add(recipient));
  return Array.from(unique);
}

function placeholderSlots(text) {
  if (!text || typeof text !== 'string') return [];
  const matches = text.match(/{{(\d+)}}/g);
  if (!matches) return [];
  return Array.from(new Set(matches.map((match) => Number(match.replace(/[^0-9]/g, '')))))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
}

function extractBodyValues(variables, expected) {
  if (!variables || expected === 0) return [];
  if (Array.isArray(variables)) return variables;
  if (Array.isArray(variables.body)) return variables.body;
  if (variables.body && typeof variables.body === 'object') {
    return Array.isArray(variables.body)
      ? variables.body
      : Object.values(variables.body);
  }
  const keys = Object.keys(variables).filter((key) => !SAFE_VARIABLE_KEYS.has(key));
  if (keys.length) {
    return keys.map((key) => variables[key]);
  }
  return [];
}

function extractHeaderValues(variables) {
  if (!variables) return [];
  if (Array.isArray(variables.header)) return variables.header;
  if (variables.header && typeof variables.header === 'object') {
    return Array.isArray(variables.header)
      ? variables.header
      : Object.values(variables.header);
  }
  if (variables.header_text !== undefined) {
    const value = variables.header_text;
    return Array.isArray(value) ? value : [value];
  }
  return [];
}

function extractButtonValue(variables, index) {
  if (!variables) return undefined;
  if (Array.isArray(variables.buttons)) return variables.buttons[index];
  if (variables.buttons && typeof variables.buttons === 'object') {
    if (Array.isArray(variables.buttons.url)) return variables.buttons.url[index];
    if (Array.isArray(variables.buttons.text)) return variables.buttons.text[index];
    const direct = variables.buttons[index] ?? variables.buttons[String(index)] ?? variables.buttons[`button_${index + 1}`];
    if (direct !== undefined) return direct;
  }
  return undefined;
}

function buildComponents(template, variables) {
  const components = [];
  const body = template.components.find((component) => component.type === 'BODY');
  if (body && body.text) {
    const slots = placeholderSlots(body.text);
    if (slots.length) {
      const bodyValues = extractBodyValues(variables, slots.length);
      if (!bodyValues || bodyValues.length < slots.length) {
        throw new Error(`Variables incompletas para BODY: se esperaban ${slots.length} y llegaron ${bodyValues ? bodyValues.length : 0}`);
      }
      const parameters = slots.map((_, idx) => ({ type: 'text', text: `${bodyValues[idx]}` }));
      components.push({ type: 'body', parameters });
    }
  }

  const header = template.components.find((component) => component.type === 'HEADER');
  if (header) {
    if (header.format === 'TEXT' && header.text) {
      const slots = placeholderSlots(header.text);
      if (slots.length) {
        const headerValues = extractHeaderValues(variables);
        if (!headerValues || headerValues.length < slots.length) {
          throw new Error(`Variables incompletas para HEADER: se esperaban ${slots.length} y llegaron ${headerValues ? headerValues.length : 0}`);
        }
        const parameters = slots.map((_, idx) => ({ type: 'text', text: `${headerValues[idx]}` }));
        components.push({ type: 'header', parameters });
      }
    } else if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(header.format)) {
      const mediaUrl = variables?.header_media_url || variables?.header?.media_url || variables?.header?.url;
      if (!mediaUrl) {
        throw new Error('Falta header_media_url para la cabecera de la plantilla.');
      }
      const mediaType = header.format.toLowerCase();
      const parameter = { type: mediaType };
      parameter[mediaType] = { link: mediaUrl };
      components.push({ type: 'header', parameters: [parameter] });
    }
  }

  const buttonsComponent = template.components.find((component) => component.type === 'BUTTONS');
  if (buttonsComponent && Array.isArray(buttonsComponent.buttons)) {
    buttonsComponent.buttons.forEach((button, index) => {
      if (button.type === 'URL' && button.example && button.example.length) {
        const buttonValue = extractButtonValue(variables, index);
        if (!buttonValue) {
          throw new Error(`Falta variable para el botón ${index + 1}`);
        }
        components.push({
          type: 'button',
          sub_type: 'url',
          index,
          parameters: [{ type: 'text', text: `${buttonValue}` }],
        });
      }
    });
  }

  return components;
}

function buildSenderLabel(sender) {
  if (sender.display_phone_number) {
    return `${sender.display_phone_number} · ${sender.id}`;
  }
  if (sender.phone_number) {
    return `${sender.phone_number} · ${sender.id}`;
  }
  return sender.id;
}

async function graphRequest(path, options = {}, { version = API_VERSION, useQueryToken = false } = {}) {
  if (!TOKEN_PRESENT) {
    return { ok: false, status: 401, data: { error: 'missing-token' } };
  }
  const baseUrl = path.startsWith('http') ? path : `https://graph.facebook.com/${version}${path.startsWith('/') ? path : `/${path}`}`;
  const finalUrl = useQueryToken
    ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(META_TOKEN)}`
    : baseUrl;
  const headers = Object.assign({}, options.headers || {});
  let body = options.body;
  if (!useQueryToken) {
    headers.Authorization = `Bearer ${META_TOKEN}`;
  } else {
    delete headers.Authorization;
  }
  if (body && typeof body === 'object' && !(body instanceof Buffer)) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    body = JSON.stringify(body);
  }
  headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  try {
    const response = await fetch(finalUrl, {
      method: options.method || 'GET',
      headers,
      body: options.method && options.method.toUpperCase() === 'GET' ? undefined : body,
    });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch (error) {
      data = { raw: text };
    }
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    return { ok: false, status: 599, data: { error: error.message } };
  }
}

async function fetchSenders({ force = false } = {}) {
  if (!force && cache.senders && cache.senders.expires > Date.now()) {
    return cache.senders.value;
  }
  const resolved = [];
  let baseList = PHONE_IDS.length ? PHONE_IDS.slice() : [];
  if (!baseList.length && TOKEN_PRESENT && WABA_ID) {
    for (const version of FALLBACK_VERSIONS) {
      const response = await graphRequest(`/${WABA_ID}/phone_numbers`, {}, { version });
      if (response.ok && Array.isArray(response.data?.data) && response.data.data.length) {
        baseList = response.data.data.map((item) => item.id || item.phone_number_id || item.phone_number).filter(Boolean);
        response.data.data.forEach((item) => {
          resolved.push({
            id: item.id || item.phone_number_id || item.phone_number,
            display_phone_number: item.display_phone_number || item.phone_number,
            verified_name: item.verified_name,
          });
        });
        break;
      }
    }
  }
  if (!TOKEN_PRESENT || !baseList.length) {
    baseList.forEach((id) => {
      if (!resolved.find((entry) => entry.id === id)) resolved.push({ id });
    });
  } else {
    for (const phoneId of baseList) {
      let display;
      for (const version of FALLBACK_VERSIONS) {
        const result = await graphRequest(`/${phoneId}?fields=display_phone_number,verified_name`, {}, { version });
        if (result.ok && result.data) {
          display = {
            id: phoneId,
            display_phone_number: result.data.display_phone_number,
            verified_name: result.data.verified_name,
          };
          break;
        }
      }
      const existing = resolved.find((entry) => entry.id === phoneId);
      if (existing) {
        if (display?.display_phone_number) existing.display_phone_number = display.display_phone_number;
        if (display?.verified_name) existing.verified_name = display.verified_name;
      } else {
        resolved.push(display || { id: phoneId });
      }
    }
  }
  cache.senders = { value: resolved, expires: Date.now() + CACHE_TTL_MS };
  return resolved;
}

function normalizeTemplateEntry(entry) {
  return {
    id: entry.id,
    name: entry.name,
    language: entry.language || entry.language_code,
    status: entry.status,
    category: entry.category,
    namespace: entry.namespace,
    components: Array.isArray(entry.components) ? entry.components.map((component) => ({
      type: component.type,
      format: component.format,
      text: component.text,
      example: component.example,
      buttons: component.buttons,
    })) : [],
  };
}

async function fetchTemplates({ force = false } = {}) {
  if (!TOKEN_PRESENT || !WABA_ID) {
    return [];
  }
  if (!force && cache.templates && cache.templates.expires > Date.now()) {
    return cache.templates.value;
  }
  for (const version of FALLBACK_VERSIONS) {
    const templates = [];
    let next = `https://graph.facebook.com/${version}/${WABA_ID}/message_templates?limit=200`;
    while (next) {
      const result = await graphRequest(next, {}, { version });
      if (!result.ok) {
        next = null;
        break;
      }
      if (Array.isArray(result.data?.data)) {
        result.data.data.forEach((item) => templates.push(normalizeTemplateEntry(item)));
      }
      next = result.data?.paging?.next || null;
    }
    if (templates.length) {
      cache.templates = { value: templates, expires: Date.now() + CACHE_TTL_MS };
      return templates;
    }
  }
  return [];
}

function templatesByName(templates) {
  return templates.reduce((acc, template) => {
    if (!acc[template.name]) acc[template.name] = [];
    acc[template.name].push(template);
    return acc;
  }, {});
}

function determineLanguageCandidates(templates, selectedName, requestedLanguage) {
  const byName = templatesByName(templates);
  const variants = byName[selectedName] || [];
  const candidates = [];
  if (requestedLanguage) {
    const direct = variants.find((variant) => variant.language === requestedLanguage);
    if (direct) candidates.push(direct);
  }
  if (DEFAULT_LANGUAGE && variants.some((variant) => variant.language === DEFAULT_LANGUAGE)) {
    const fallbackDefault = variants.find((variant) => variant.language === DEFAULT_LANGUAGE);
    if (fallbackDefault && !candidates.includes(fallbackDefault)) {
      candidates.push(fallbackDefault);
    }
  }
  variants.forEach((variant) => {
    if (!candidates.includes(variant)) candidates.push(variant);
  });
  return candidates;
}

async function sendTemplateMessage({ senderId, template, language, components, recipient }) {
  const payload = {
    messaging_product: 'whatsapp',
    to: recipient,
    type: 'template',
    template: {
      name: template.name,
      language: { code: language },
      components,
    },
  };
  if (template.namespace) {
    payload.template.namespace = template.namespace;
  }
  let lastError = null;
  for (const version of FALLBACK_VERSIONS) {
    const direct = await graphRequest(`/${senderId}/messages`, { method: 'POST', body: payload }, { version, useQueryToken: false });
    if (direct.ok) {
      return { ok: true, data: direct.data, version, via: 'authorization' };
    }
    lastError = { version, response: direct };
    const query = await graphRequest(`/${senderId}/messages`, { method: 'POST', body: payload }, { version, useQueryToken: true });
    if (query.ok) {
      return { ok: true, data: query.data, version, via: 'query' };
    }
    lastError = { version, response: query };
  }
  return { ok: false, error: lastError };
}

function sanitizeError(error) {
  if (!error) return { message: 'Error desconocido' };
  if (error.response && error.response.data && error.response.data.error) {
    const details = error.response.data.error;
    return {
      message: details.message || 'Error en Meta Graph',
      code: details.code,
      type: details.type,
    };
  }
  if (error.data && error.data.error) {
    const details = error.data.error;
    return {
      message: details.message || 'Error en Meta Graph',
      code: details.code,
      type: details.type,
    };
  }
  return { message: typeof error === 'string' ? error : JSON.stringify(error) };
}

function templateSummaryForClient(template) {
  return {
    id: template.id,
    name: template.name,
    language: template.language,
    status: template.status,
    category: template.category,
    namespace: template.namespace,
    components: template.components,
  };
}

async function renderPlacement(req, res, placement) {
  const senders = await fetchSenders().catch(() => []);
  const debugPayload = redact({ method: req.method, query: req.query, body: req.body });
  const state = {
    placement,
    tokenPresent: TOKEN_PRESENT && !DRY_RUN,
    dryRun: DRY_RUN,
    defaultLanguage: DEFAULT_LANGUAGE,
    defaultSender: DEFAULT_SENDER,
    senders: senders.map((sender) => ({
      id: sender.id,
      display_phone_number: sender.display_phone_number,
      verified_name: sender.verified_name,
      label: buildSenderLabel(sender),
    })),
    warnings: {
      missingToken: !TOKEN_PRESENT,
      missingWaba: !WABA_ID,
    },
  };

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>WhatsApp Azaleia · ${placement}</title>
  <style>
    :root {
      color-scheme: light;
      font-family: 'Segoe UI', Roboto, sans-serif;
    }
    body {
      margin: 0;
      padding: 0;
      background: #f3f4f6;
      color: #111827;
    }
    header {
      padding: 24px 32px 16px;
      background: #111827;
      color: #f9fafb;
    }
    header h1 {
      margin: 0;
      font-size: 1.75rem;
      font-weight: 600;
    }
    header p {
      margin: 4px 0 0;
      color: #d1d5db;
    }
    .banner {
      margin: 0;
      padding: 12px 32px;
      background: #fee2e2;
      color: #b91c1c;
      font-weight: 600;
    }
    .layout {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 24px;
      padding: 24px 32px 48px;
    }
    .card {
      background: #ffffff;
      border-radius: 16px;
      box-shadow: 0 12px 24px rgba(15, 23, 42, 0.12);
      padding: 24px;
    }
    .form-grid {
      display: grid;
      gap: 16px;
    }
    label {
      display: block;
      font-weight: 600;
      margin-bottom: 6px;
    }
    input[type="text"],
    select,
    textarea {
      width: 100%;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      padding: 10px 12px;
      font-size: 0.95rem;
      font-family: inherit;
      resize: vertical;
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
      background: #fff;
    }
    input[type="text"]:focus,
    select:focus,
    textarea:focus {
      outline: none;
      border-color: #2563eb;
      box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.2);
    }
    textarea {
      min-height: 120px;
    }
    .controls-row {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }
    .btn {
      padding: 12px 20px;
      border-radius: 10px;
      font-weight: 600;
      border: 1px solid transparent;
      cursor: pointer;
      font-size: 0.95rem;
      transition: background 0.2s ease, box-shadow 0.2s ease;
    }
    .btn-primary {
      background: #2563eb;
      color: #fff;
    }
    .btn-primary:hover {
      background: #1d4ed8;
      box-shadow: 0 8px 20px rgba(37, 99, 235, 0.3);
    }
    .btn-secondary {
      background: #e5e7eb;
      color: #1f2937;
    }
    .btn-secondary:hover {
      background: #d1d5db;
    }
    .btn:disabled {
      cursor: not-allowed;
      opacity: 0.6;
      box-shadow: none;
    }
    .chips {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 8px;
    }
    .chip {
      padding: 4px 10px;
      border-radius: 999px;
      background: #e0e7ff;
      color: #3730a3;
      font-size: 0.8rem;
      font-weight: 600;
    }
    .chip.warn {
      background: #fee2e2;
      color: #b91c1c;
    }
    .muted {
      color: #6b7280;
      font-size: 0.85rem;
      margin-top: 4px;
    }
    .preview-card {
      background: linear-gradient(145deg, #ffffff 0%, #f8fafc 100%);
      border-radius: 20px;
      padding: 24px;
      box-shadow: 0 15px 35px rgba(15, 23, 42, 0.14);
      position: sticky;
      top: 24px;
    }
    .preview-card h2 {
      margin: 0;
      font-size: 1.25rem;
      font-weight: 600;
      color: #1f2937;
    }
    .preview-card .preview-body {
      margin-top: 16px;
      line-height: 1.6;
      white-space: pre-wrap;
      font-size: 0.95rem;
      color: #111827;
    }
    .preview-card mark {
      background: #fef08a;
      color: #92400e;
      padding: 0 4px;
      border-radius: 4px;
    }
    .expected {
      margin: 0;
      padding-left: 18px;
      color: #4b5563;
      font-size: 0.9rem;
    }
    .alert {
      margin-top: 12px;
      padding: 12px 16px;
      border-radius: 10px;
      background: #fee2e2;
      color: #b91c1c;
      font-weight: 600;
    }
    .success {
      margin-top: 12px;
      padding: 12px 16px;
      border-radius: 10px;
      background: #dcfce7;
      color: #166534;
      font-weight: 600;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 16px;
    }
    th, td {
      border: 1px solid #e5e7eb;
      padding: 10px;
      text-align: left;
      font-size: 0.9rem;
    }
    th {
      background: #f3f4f6;
    }
    .debug {
      margin: 0 32px 48px;
    }
    .debug button {
      background: none;
      border: none;
      color: #2563eb;
      font-weight: 600;
      cursor: pointer;
      padding: 0;
    }
    .debug pre {
      background: #0f172a;
      color: #e0f2fe;
      padding: 16px;
      border-radius: 12px;
      overflow-x: auto;
      margin-top: 12px;
      display: none;
    }
    .hidden {
      display: none !important;
    }
  </style>
</head>
<body>
  <header>
    <h1>WhatsApp Azaleia · ${placement}</h1>
    <p>Envía plantillas aprobadas de WhatsApp Business Cloud directamente desde Bitrix24.</p>
  </header>
  ${!TOKEN_PRESENT ? '<div class="banner">Falta META_WABA_TOKEN en el entorno. Completa el .env para habilitar el envío real.</div>' : ''}
  ${DRY_RUN ? '<div class="banner">DRY_RUN está activado. Desactívalo para que los mensajes se entreguen.</div>' : ''}
  <main class="layout">
    <section class="card">
      <form id="sendForm" class="form-grid">
        <div>
          <label for="templateSearch">Buscar plantilla</label>
          <input type="text" id="templateSearch" placeholder="Escribe para filtrar por nombre" autocomplete="off" />
        </div>
        <div>
          <label for="templateSelect">Plantilla</label>
          <select id="templateSelect" required></select>
          <div class="chips" id="templateChips"></div>
        </div>
        <div>
          <label for="senderSelect">Remitente</label>
          <select id="senderSelect" required></select>
          <p class="muted">Selecciona uno de tus números habilitados en Meta.</p>
        </div>
        <div>
          <label for="recipients">Destinatarios</label>
          <textarea id="recipients" placeholder="+51918131082\n+51999888777" required></textarea>
          <p class="muted">Uno por línea, incluye prefijo. Si escribes 918131082 se completará como +51918131082.</p>
        </div>
        <div>
          <label for="variables">Variables (JSON por plantilla)</label>
          <textarea id="variables" placeholder='{"body":["Ana","28/10"]}'></textarea>
          <p class="muted">Usa objetos o arrays. Ej: {"body":["Ana"]} o {"name":"Ana"}. Para cabeceras usa header_text o header_media_url.</p>
        </div>
        <div>
          <strong>Variables esperadas</strong>
          <ul class="expected" id="expectedList"></ul>
        </div>
        <div class="controls-row">
          <button type="submit" id="submitBtn" class="btn btn-primary">Enviar</button>
          <button type="button" id="healthBtn" class="btn btn-secondary">Probar /health</button>
        </div>
        <div id="formMessages"></div>
        <div id="results" class="hidden"></div>
      </form>
    </section>
    <aside class="preview-card" id="preview">
      <h2 id="previewTitle">Selecciona una plantilla</h2>
      <div class="preview-body" id="previewBody">Aquí verás el contenido formateado y los marcadores de posición.</div>
    </aside>
  </main>
  <section class="debug">
    <button type="button" id="debugToggle">DEBUG: payload Bitrix (click)</button>
    <pre id="debugPayload">${JSON.stringify(debugPayload, null, 2)}</pre>
  </section>
  <script>
    const INITIAL_STATE = ${safeJson(state)};
  </script>
  <script>
    (function () {
      const state = INITIAL_STATE;
      const templateSelect = document.getElementById('templateSelect');
      const templateSearch = document.getElementById('templateSearch');
      const senderSelect = document.getElementById('senderSelect');
      const recipientsArea = document.getElementById('recipients');
      const variablesArea = document.getElementById('variables');
      const expectedList = document.getElementById('expectedList');
      const previewTitle = document.getElementById('previewTitle');
      const previewBody = document.getElementById('previewBody');
      const chipsContainer = document.getElementById('templateChips');
      const submitBtn = document.getElementById('submitBtn');
      const healthBtn = document.getElementById('healthBtn');
      const formMessages = document.getElementById('formMessages');
      const resultsContainer = document.getElementById('results');
      const debugToggle = document.getElementById('debugToggle');
      const debugPayload = document.getElementById('debugPayload');

      if (!state.tokenPresent) {
        submitBtn.disabled = true;
        submitBtn.title = 'Configura META_WABA_TOKEN para habilitar el envío real.';
      }
      if (state.dryRun) {
        submitBtn.disabled = true;
        submitBtn.title = 'DRY_RUN está activo. Desactívalo en el .env para enviar.';
      }

      function populateSenders() {
        senderSelect.innerHTML = '';
        state.senders.forEach((sender) => {
          const option = document.createElement('option');
          option.value = sender.id;
          option.textContent = sender.label;
          if (sender.id === state.defaultSender) {
            option.selected = true;
          }
          senderSelect.appendChild(option);
        });
      }

      let templates = [];
      let filteredTemplates = [];

      function renderTemplateOptions() {
        templateSelect.innerHTML = '';
        filteredTemplates.forEach((template) => {
          const option = document.createElement('option');
          option.value = template.name + '::' + template.language;
          option.textContent = template.name + ' · ' + template.language;
          templateSelect.appendChild(option);
        });
        if (!filteredTemplates.length) {
          const option = document.createElement('option');
          option.textContent = state.tokenPresent ? 'No hay plantillas disponibles' : 'Conecta el token para listar plantillas';
          option.disabled = true;
          option.selected = true;
          templateSelect.appendChild(option);
        }
      }

      function collectPlaceholders(component) {
        if (!component || !component.text) return [];
        const matches = component.text.match(/{{(\d+)}}/g) || [];
        const values = Array.from(new Set(matches.map((match) => match.replace(/[^0-9]/g, ''))));
        return values.map((value) => '{{' + value + '}}');
      }

      function renderExpected(template) {
        expectedList.innerHTML = '';
        if (!template) return;
        const body = template.components.find((component) => component.type === 'BODY');
        const header = template.components.find((component) => component.type === 'HEADER');
        if (body) {
          const item = document.createElement('li');
          const placeholders = collectPlaceholders(body);
          item.textContent = 'BODY (' + placeholders.length + '): ' + (placeholders.join(', ') || 'sin variables');
          expectedList.appendChild(item);
        }
        if (header) {
          const item = document.createElement('li');
          const placeholders = collectPlaceholders(header);
          if (header.format === 'TEXT') {
            item.textContent = 'HEADER texto (' + placeholders.length + '): ' + (placeholders.join(', ') || 'sin variables');
          } else {
            item.textContent = 'HEADER ' + header.format.toLowerCase() + ': usa header_media_url';
          }
          expectedList.appendChild(item);
        }
        const buttons = template.components.find((component) => component.type === 'BUTTONS');
        if (buttons && buttons.buttons && buttons.buttons.length) {
          const item = document.createElement('li');
          item.textContent = 'BOTONES: ' + buttons.buttons.length + ' (' + buttons.buttons
            .map((button, index) => (index + 1) + '. ' + button.type)
            .join(' · ') + ')';
          expectedList.appendChild(item);
        }
      }

      function highlightPlaceholders(text, variables, componentType) {
        if (!text) return '';
        const collected = [];
        const source = (variables && typeof variables === 'object') ? variables : {};
        if (Array.isArray(variables)) {
          collected.push(...variables);
        }
        if (componentType === 'header') {
          if (Array.isArray(source.header)) collected.push(...source.header);
          else if (source.header && typeof source.header === 'object') collected.push(...Object.values(source.header));
          else if (source.header_text !== undefined) {
            const value = source.header_text;
            collected.push(...(Array.isArray(value) ? value : [value]));
          }
        } else {
          if (Array.isArray(source.body)) collected.push(...source.body);
          else if (source.body && typeof source.body === 'object') collected.push(...Object.values(source.body));
          else {
            Object.keys(source)
              .filter((key) => !['header', 'header_text', 'header_media_url', 'buttons'].includes(key))
              .forEach((key) => collected.push(source[key]));
          }
        }
        return text.replace(/{{(\d+)}}/g, function (_, rawIndex) {
          const index = Number(rawIndex);
          const value = collected[index - 1];
          return value !== undefined ? '<mark>' + String(value) + '</mark>' : '<mark>{{' + rawIndex + '}}</mark>';
        });
      }

      function parseVariables() {
        const raw = variablesArea.value.trim();
        if (!raw) return {};
        try {
          return JSON.parse(raw);
        } catch (error) {
          return {};
        }
      }

      function renderPreview(template) {
        if (!template) {
          previewTitle.textContent = 'Selecciona una plantilla';
          previewBody.textContent = 'Aquí verás el contenido formateado y los marcadores de posición.';
          return;
        }
        previewTitle.textContent = template.name + ' · ' + template.language;
        const vars = parseVariables();
        const body = template.components.find((component) => component.type === 'BODY');
        const header = template.components.find((component) => component.type === 'HEADER');
        const previewParts = [];
        if (header && header.text) {
          previewParts.push('<strong>' + highlightPlaceholders(header.text, vars, 'header') + '</strong>');
        }
        if (body && body.text) {
          previewParts.push(highlightPlaceholders(body.text, vars, 'body'));
        }
        if (!previewParts.length) {
          previewParts.push('La plantilla no contiene texto de vista previa.');
        }
        previewBody.innerHTML = previewParts.join('\n\n');
      }

      function renderChips(template) {
        chipsContainer.innerHTML = '';
        if (!template) return;
        const chipData = [
          { label: template.status, className: 'chip ' + (template.status === 'APPROVED' ? '' : 'warn') },
          { label: template.category, className: 'chip' },
          { label: template.language, className: 'chip' },
        ];
        chipData.forEach((chip) => {
          if (!chip.label) return;
          const span = document.createElement('span');
          span.className = chip.className;
          span.textContent = chip.label;
          chipsContainer.appendChild(span);
        });
      }

      function setVariablesPlaceholder(template) {
        if (!template) return;
        const example = {};
        const body = template.components.find((component) => component.type === 'BODY');
        if (body) {
          const slots = collectPlaceholders(body);
          if (slots.length) {
            example.body = body.example?.body_text?.[0] || new Array(slots.length).fill('valor');
          }
        }
        const header = template.components.find((component) => component.type === 'HEADER');
        if (header) {
          if (header.format === 'TEXT') {
            const slots = collectPlaceholders(header);
            if (slots.length) {
              example.header_text = header.example?.header_text?.[0] || new Array(slots.length).fill('valor');
            }
          } else if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(header.format)) {
            example.header_media_url = 'https://ejemplo.com/archivo.jpg';
          }
        }
        const buttons = template.components.find((component) => component.type === 'BUTTONS');
        if (buttons && buttons.buttons && buttons.buttons.some((button) => button.type === 'URL' && button.example && button.example.length)) {
          example.buttons = { url: buttons.buttons.map((button, index) => button.example?.[0] || 'https://ejemplo.com/' + (index + 1)) };
        }
        if (Object.keys(example).length) {
          variablesArea.placeholder = JSON.stringify(example, null, 2);
        }
      }

      function updateTemplateDetails() {
        const selected = templateSelect.value;
        const template = filteredTemplates.find((item) => item.name + '::' + item.language === selected);
        renderChips(template);
        renderExpected(template);
        renderPreview(template);
        setVariablesPlaceholder(template);
      }

      function filterTemplates() {
        const value = templateSearch.value.trim().toLowerCase();
        if (!value) {
          filteredTemplates = templates.slice();
        } else {
          filteredTemplates = templates.filter((template) => template.name.toLowerCase().includes(value));
        }
        renderTemplateOptions();
        updateTemplateDetails();
      }

      async function loadTemplates() {
        if (!state.tokenPresent) {
          templates = [];
          filteredTemplates = [];
          renderTemplateOptions();
          updateTemplateDetails();
          return;
        }
        try {
          const response = await fetch('/meta/templates');
          if (!response.ok) throw new Error('No se pudo obtener la lista de plantillas');
          const data = await response.json();
          templates = Array.isArray(data.templates) ? data.templates : [];
          filteredTemplates = templates.slice();
          renderTemplateOptions();
          updateTemplateDetails();
        } catch (error) {
          formMessages.innerHTML = '<div class="alert">' + error.message + '</div>';
          templates = [];
          filteredTemplates = [];
          renderTemplateOptions();
          updateTemplateDetails();
        }
      }

      populateSenders();
      loadTemplates();

      templateSelect.addEventListener('change', updateTemplateDetails);
      templateSearch.addEventListener('input', filterTemplates);
      variablesArea.addEventListener('input', () => {
        const selected = templateSelect.value;
        const template = filteredTemplates.find((item) => item.name + '::' + item.language === selected);
        renderPreview(template);
      });

      debugToggle.addEventListener('click', () => {
        const hidden = debugPayload.style.display === 'none' || !debugPayload.style.display;
        debugPayload.style.display = hidden ? 'block' : 'none';
      });

      healthBtn.addEventListener('click', async () => {
        formMessages.innerHTML = '';
        resultsContainer.classList.add('hidden');
        try {
          const response = await fetch('/health');
          const data = await response.json();
          formMessages.innerHTML = '<div class="success">/health respondió: ' + JSON.stringify(data) + '</div>';
        } catch (error) {
          formMessages.innerHTML = '<div class="alert">/health falló: ' + error.message + '</div>';
        }
      });

      document.getElementById('sendForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        formMessages.innerHTML = '';
        resultsContainer.classList.add('hidden');
        if (!state.tokenPresent) {
          formMessages.innerHTML = '<div class="alert">Completa META_WABA_TOKEN para habilitar el envío.</div>';
          return;
        }
        if (state.dryRun) {
          formMessages.innerHTML = '<div class="alert">DRY_RUN está activo. Desactívalo en el .env.</div>';
          return;
        }
        if (!templateSelect.value) {
          formMessages.innerHTML = '<div class="alert">Selecciona una plantilla.</div>';
          return;
        }
        const [templateName, language] = templateSelect.value.split('::');
        if (!senderSelect.value) {
          formMessages.innerHTML = '<div class="alert">Selecciona un remitente.</div>';
          return;
        }
        const recipients = recipientsArea.value;
        if (!recipients.trim()) {
          formMessages.innerHTML = '<div class="alert">Ingresa al menos un destinatario.</div>';
          return;
        }
        let variablesPayload = variablesArea.value.trim();
        try {
          variablesPayload = variablesPayload ? JSON.stringify(JSON.parse(variablesPayload)) : '';
        } catch (error) {
          formMessages.innerHTML = '<div class="alert">El JSON de variables no es válido.</div>';
          return;
        }
        submitBtn.disabled = true;
        submitBtn.textContent = 'Enviando...';
        try {
          const response = await fetch('/send-template', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              template: templateName,
              language,
              sender_phone_id: senderSelect.value,
              recipients,
              variables_json: variablesPayload,
            }),
          });
          const payload = await response.json();
          if (!response.ok) {
            formMessages.innerHTML = '<div class="alert">' + (payload.error || 'No se pudo enviar la plantilla.') + '</div>';
          } else {
            renderResults(payload);
          }
        } catch (error) {
          formMessages.innerHTML = '<div class="alert">Error al enviar: ' + error.message + '</div>';
        } finally {
          submitBtn.disabled = state.dryRun || !state.tokenPresent;
          submitBtn.textContent = 'Enviar';
        }
      });

      function renderResults(payload) {
        if (!payload || !Array.isArray(payload.results)) {
          formMessages.innerHTML = '<div class="alert">No se recibió un reporte válido.</div>';
          return;
        }
        let html = '<table><thead><tr><th>Destinatario</th><th>Estado</th><th>ID / Error</th></tr></thead><tbody>';
        payload.results.forEach((row) => {
          html += '<tr><td>' + row.to + '</td><td>' + (row.ok ? 'OK' : 'Error') + '</td><td>' + (row.ok ? (row.id || 'N/A') : (row.error?.message || row.error)) + '</td></tr>';
        });
        html += '</tbody></table>';
        if (payload.notice) {
          html = '<div class="muted">' + payload.notice + '</div>' + html;
        }
        resultsContainer.innerHTML = html;
        resultsContainer.classList.remove('hidden');
        formMessages.innerHTML = '<div class="success">Envío procesado. Revisa la tabla de resultados.</div>';
      }
    })();
  </script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'b24-ui', port: PORT });
});

app.get(['/deal', '/contact'], (req, res) => {
  const placement = req.path.includes('deal') ? 'Deal' : 'Contact';
  renderPlacement(req, res, placement);
});

app.post(['/deal', '/contact'], (req, res) => {
  const placement = req.path.includes('deal') ? 'Deal' : 'Contact';
  renderPlacement(req, res, placement);
});

app.get('/meta/templates', async (req, res) => {
  try {
    const templates = await fetchTemplates();
    res.json({ ok: true, templates: templates.map(templateSummaryForClient) });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'No se pudieron cargar las plantillas' });
  }
});

app.post('/send-template', async (req, res) => {
  if (!TOKEN_PRESENT) {
    return res.status(400).json({ ok: false, error: 'Falta META_WABA_TOKEN' });
  }
  if (DRY_RUN) {
    return res.status(400).json({ ok: false, error: 'DRY_RUN está activo, desactívalo para enviar' });
  }
  const templateName = req.body?.template;
  const language = req.body?.language;
  const senderId = (req.body?.sender_phone_id || '').trim();
  const rawRecipients = req.body?.recipients;
  const variablesJson = req.body?.variables_json;

  if (!templateName) {
    return res.status(400).json({ ok: false, error: 'Falta template' });
  }
  if (!senderId) {
    return res.status(400).json({ ok: false, error: 'Falta sender_phone_id' });
  }
  const recipients = splitRecipients(rawRecipients);
  if (!recipients.length) {
    return res.status(400).json({ ok: false, error: 'Debes indicar al menos un destinatario válido' });
  }
  let variables = {};
  if (variablesJson && typeof variablesJson === 'string' && variablesJson.trim()) {
    try {
      variables = JSON.parse(variablesJson);
    } catch (error) {
      return res.status(400).json({ ok: false, error: 'variables_json no es JSON válido' });
    }
  } else if (typeof variablesJson === 'object') {
    variables = variablesJson;
  }

  try {
    const templates = await fetchTemplates();
    if (!templates.length) {
      return res.status(400).json({ ok: false, error: 'No se pudieron obtener plantillas desde Meta' });
    }
    const candidates = determineLanguageCandidates(templates, templateName, language);
    if (!candidates.length) {
      return res.status(400).json({ ok: false, error: 'No existe una plantilla con ese nombre/lenguaje' });
    }
    const results = [];
    for (const recipient of recipients) {
      let sent = null;
      let lastError = null;
      for (const candidate of candidates) {
        let components;
        try {
          components = buildComponents(candidate, variables);
        } catch (error) {
          lastError = { message: error.message };
          break;
        }
        const response = await sendTemplateMessage({
          senderId,
          template: candidate,
          language: candidate.language,
          components,
          recipient,
        });
        if (response.ok) {
          sent = {
            to: recipient,
            ok: true,
            id: response.data?.messages?.[0]?.id,
            language: candidate.language,
            version: response.version,
            via: response.via,
          };
          break;
        }
        lastError = sanitizeError(response.error);
      }
      if (sent) {
        results.push(sent);
      } else {
        results.push({ to: recipient, ok: false, error: lastError || { message: 'No se pudo enviar' } });
      }
    }
    res.json({ ok: true, results });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'Error inesperado al enviar la plantilla' });
  }
});

app.listen(PORT, () => {
  console.log(`[b24-ui] escuchando en :${PORT}`);
});

// QA rápida:
// node tools/b24-ui/server.cjs &
// curl -s http://localhost:3060/health
// curl -s http://localhost:3060/meta/templates
// curl -s -X POST http://localhost:3060/send-template -H 'Content-Type: application/json' -d '{"template":"demo","language":"es_PE","sender_phone_id":"857608144100041","recipients":"+51918131082","variables_json":"{\"body\":[\"Ana\"]}"}'
