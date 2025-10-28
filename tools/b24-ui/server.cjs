#!/usr/bin/env node
const express = require('express');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Load .env if available without crashing when missing
const envPath = path.resolve(__dirname, '../../.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

const app = express();
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));

const PORT = Number(process.env.APP_PORT_UI || process.env.PORT || 3060);
const META_TOKEN = process.env.META_WABA_TOKEN || '';
const BUSINESS_ID = process.env.META_WABA_BUSINESS_ID || process.env.META_WABA_BUSINESSID || '';
const DEFAULT_SENDER_ENV = process.env.DEFAULT_SENDER_PHONE_ID || '';
const API_VERSION = 'v20.0';
const TOKEN_PRESENT = Boolean(META_TOKEN);

const SENDER_OPTIONS = [
  {
    id: process.env.WABA_PHONE_ID_1,
    label: '+51 1 6193638 · Catálogo Azaleia (857608144100041)',
  },
  {
    id: process.env.WABA_PHONE_ID_2,
    label: '+51 1 6193636 · Catálogo (741220429081783)',
  },
  {
    id: process.env.WABA_PHONE_ID_3,
    label: '+51 966 748 784 (8946771777051432)',
  },
].filter((item) => Boolean(item.id));

const DEFAULT_SENDER =
  (DEFAULT_SENDER_ENV && SENDER_OPTIONS.find((sender) => sender.id === DEFAULT_SENDER_ENV)?.id) ||
  (SENDER_OPTIONS[0] ? SENDER_OPTIONS[0].id : '');

const FALLBACK_TEMPLATES = [
  {
    name: 'no_usar_solo_prueba',
    language: 'es_PE',
    category: 'marketing',
    components: [
      {
        type: 'BODY',
        format: 'TEXT',
        text: 'Hola {{1}}, esta es una plantilla de prueba para {{2}}.',
      },
    ],
  },
  {
    name: 'aviso_pago',
    language: 'es_PE',
    category: 'utility',
    components: [
      {
        type: 'BODY',
        format: 'TEXT',
        text: 'Hola {{1}}, tu pago de {{2}} vence el {{3}}.',
      },
    ],
  },
];

const templateCache = {
  expires: 0,
  data: null,
};

function logStartup() {
  console.log('[b24-ui] ------------------------------');
  console.log(`[b24-ui] Inicializando en puerto :${PORT}`);
  console.log(`[b24-ui] META_WABA_TOKEN presente: ${TOKEN_PRESENT ? 'Sí' : 'No'}`);
  console.log(`[b24-ui] META_WABA_BUSINESS_ID: ${BUSINESS_ID || 'no definido'}`);
  console.log(`[b24-ui] Remitentes configurados: ${SENDER_OPTIONS.length}`);
  if (!SENDER_OPTIONS.length) {
    console.warn('[b24-ui] ⚠️ No hay remitentes configurados. Define WABA_PHONE_ID_1/2/3 en el .env.');
  }
}

function extractPlaceholders(text) {
  if (!text) return [];
  const matches = text.match(/{{(\d+)}}/g);
  if (!matches) return [];
  const unique = new Set(matches.map((match) => Number(match.replace(/[^0-9]/g, ''))));
  return Array.from(unique)
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b)
    .map((value) => `{{${value}}}`);
}

function mapTemplateEntry(entry) {
  const components = Array.isArray(entry.components)
    ? entry.components.map((component) => ({
        type: component.type,
        format: component.format,
        text: component.text || '',
        example: component.example || {},
      }))
    : [];

  const bodyComponent = components.find((component) => component.type === 'BODY');
  const headerComponent = components.find((component) => component.type === 'HEADER');

  const bodyPlaceholders = bodyComponent ? extractPlaceholders(bodyComponent.text) : [];
  const headerPlaceholders = headerComponent && headerComponent.format === 'TEXT' ? extractPlaceholders(headerComponent.text) : [];

  const example = {};
  if (bodyPlaceholders.length) {
    example.body = bodyPlaceholders.map((_, index) => `valor${index + 1}`);
  }
  if (headerComponent) {
    if (headerComponent.format === 'TEXT' && headerPlaceholders.length) {
      example.header_text = headerPlaceholders.map((_, index) => `valor${index + 1}`);
    } else if (['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerComponent.format)) {
      example.header_media_url = 'https://ejemplo.com/archivo.jpg';
    }
  }

  return {
    name: entry.name,
    language: entry.language || entry.language_code || 'es_PE',
    category: entry.category || 'marketing',
    components,
    variables: bodyPlaceholders,
    placeholders: {
      body: bodyPlaceholders,
      header: headerPlaceholders,
      headerFormat: headerComponent ? headerComponent.format : null,
    },
    example,
  };
}

async function fetchTemplatesFromMeta() {
  if (!TOKEN_PRESENT || !BUSINESS_ID) {
    return [];
  }
  const url = `https://graph.facebook.com/${API_VERSION}/${BUSINESS_ID}/message_templates?limit=200&access_token=${encodeURIComponent(
    META_TOKEN,
  )}`;
  try {
    const response = await fetch(url);
    const data = await response.json();
    if (!response.ok) {
      console.error('[b24-ui] Error al cargar plantillas desde Meta:', data);
      return [];
    }
    if (!Array.isArray(data.data)) {
      return [];
    }
    return data.data.map(mapTemplateEntry);
  } catch (error) {
    console.error('[b24-ui] Excepción al obtener plantillas de Meta:', error.message);
    return [];
  }
}

async function getTemplates({ force = false } = {}) {
  if (!force && templateCache.data && templateCache.expires > Date.now()) {
    return templateCache.data;
  }
  let templates = await fetchTemplatesFromMeta();
  if (!templates.length) {
    templates = FALLBACK_TEMPLATES.map(mapTemplateEntry);
    console.warn('[b24-ui] Usando plantillas de respaldo (fallback).');
  }
  templateCache.data = templates;
  templateCache.expires = Date.now() + 60 * 1000;
  console.log(`[b24-ui] Plantillas disponibles: ${templates.length}`);
  return templates;
}

function normalizeRecipient(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const cleaned = trimmed.replace(/[^0-9+]/g, '');
  if (!cleaned) return null;
  if (cleaned.startsWith('+')) {
    return `+${cleaned.replace(/[^0-9]/g, '')}`;
  }
  let digits = cleaned.replace(/[^0-9]/g, '');
  if (digits.startsWith('00')) {
    digits = digits.replace(/^0+/, '');
  }
  if (digits.startsWith('51')) {
    return `+${digits}`;
  }
  if (digits.startsWith('9')) {
    return `+51${digits}`;
  }
  if (digits.length >= 8) {
    return `+${digits}`;
  }
  return null;
}

function splitRecipients(input) {
  if (!input || typeof input !== 'string') return [];
  const unique = new Set();
  input
    .split(/\r?\n/)
    .map((line) => normalizeRecipient(line))
    .filter(Boolean)
    .forEach((recipient) => unique.add(recipient));
  return Array.from(unique);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function deriveBodyValues(template, variablesInput) {
  const expected = template.placeholders.body.length;
  if (!expected) return [];
  const values = [];
  if (Array.isArray(variablesInput)) {
    values.push(...variablesInput);
  } else if (variablesInput && typeof variablesInput === 'object') {
    if (Array.isArray(variablesInput.body)) {
      values.push(...variablesInput.body);
    } else if (variablesInput.body && typeof variablesInput.body === 'object') {
      values.push(...Object.values(variablesInput.body));
    } else {
      Object.keys(variablesInput)
        .filter((key) => !['header', 'header_text', 'header_media_url', 'buttons'].includes(key))
        .forEach((key) => {
          values.push(variablesInput[key]);
        });
    }
  }
  while (values.length < expected) {
    values.push('');
  }
  return values.slice(0, expected).map((value) => (value === undefined || value === null ? '' : String(value)));
}

function deriveHeaderValues(template, variablesInput) {
  const header = template.placeholders;
  const headerCount = header.header.length;
  if (!headerCount) return [];
  const values = [];
  if (variablesInput && typeof variablesInput === 'object') {
    if (Array.isArray(variablesInput.header)) {
      values.push(...variablesInput.header);
    } else if (variablesInput.header && typeof variablesInput.header === 'object') {
      values.push(...Object.values(variablesInput.header));
    } else if (variablesInput.header_text !== undefined) {
      const value = variablesInput.header_text;
      if (Array.isArray(value)) {
        values.push(...value);
      } else {
        values.push(value);
      }
    }
  }
  while (values.length < headerCount) {
    values.push('');
  }
  return values.slice(0, headerCount).map((value) => (value === undefined || value === null ? '' : String(value)));
}

function buildComponentsForSend(template, variablesInput) {
  const components = [];
  const bodyValues = deriveBodyValues(template, variablesInput);
  if (bodyValues.length) {
    components.push({
      type: 'body',
      parameters: bodyValues.map((text) => ({ type: 'text', text })),
    });
  }
  const headerFormat = template.placeholders.headerFormat;
  if (headerFormat === 'TEXT' && template.placeholders.header.length) {
    const headerValues = deriveHeaderValues(template, variablesInput);
    components.push({
      type: 'header',
      parameters: headerValues.map((text) => ({ type: 'text', text })),
    });
  }
  if (headerFormat && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(headerFormat)) {
    const url =
      (variablesInput && variablesInput.header_media_url) ||
      (variablesInput && variablesInput.header && variablesInput.header.media_url) ||
      (variablesInput && variablesInput.header && variablesInput.header.url);
    if (!url) {
      throw new Error('Falta header_media_url para la cabecera multimedia de la plantilla.');
    }
    const mediaType = headerFormat.toLowerCase();
    components.push({
      type: 'header',
      parameters: [
        {
          type: mediaType,
          [mediaType]: {
            link: String(url),
          },
        },
      ],
    });
  }
  return components;
}

async function sendTemplate({ phoneId, recipient, template, variablesInput }) {
  const payload = {
    messaging_product: 'whatsapp',
    to: recipient,
    type: 'template',
    template: {
      name: template.name,
      language: { code: template.language },
    },
  };

  const components = buildComponentsForSend(template, variablesInput);
  if (components.length) {
    payload.template.components = components;
  }

  const url = `https://graph.facebook.com/${API_VERSION}/${phoneId}/messages`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${META_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error(`[SEND] ❌ ${phoneId} -> ${recipient} · ${template.name}/${template.language}`, data);
      return { ok: false, status: response.status, error: data, payload };
    }
    console.log(
      `[SEND] ✅ ${phoneId} -> ${recipient} · ${template.name}/${template.language} · status ${response.status}`,
    );
    return { ok: true, status: response.status, data, payload };
  } catch (error) {
    console.error(`[SEND] ❌ ${phoneId} -> ${recipient} · ${template.name}/${template.language}`, error.message);
    return { ok: false, status: 599, error: { message: error.message }, payload };
  }
}

function renderResults(results) {
  if (!Array.isArray(results) || !results.length) {
    return '';
  }
  const rows = results
    .map((result) => {
      const statusCell = result.ok
        ? '<span class="badge success">Enviado</span>'
        : '<span class="badge error">Error</span>';
      const detail = result.ok
        ? escapeHtml(JSON.stringify(result.data, null, 2))
        : escapeHtml(JSON.stringify(result.error, null, 2));
      return `
        <tr>
          <td>${escapeHtml(result.to)}</td>
          <td>${statusCell}</td>
          <td><pre>${detail}</pre></td>
        </tr>
      `;
    })
    .join('');
  return `
    <section class="card results">
      <h2>Resultados del envío</h2>
      <p class="muted">Se muestra la respuesta de Meta para cada destinatario.</p>
      <div class="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Destinatario</th>
              <th>Estado</th>
              <th>Detalle</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </section>
  `;
}
function renderPage({ req, res, placement, templates, formData = {}, alertMessage = '', successMessage = '', results = [] }) {
  const actionPath = req.originalUrl || req.path;
  const templateJson = safeJson(templates);
  const sendersJson = safeJson(SENDER_OPTIONS);
  const initialFormJson = safeJson({
    templateKey: formData.templateKey || '',
    sender: formData.sender || '',
    recipients: formData.recipients || '',
    varsJson: formData.varsJson || '',
  });
  const pageStateJson = safeJson({ tokenPresent: TOKEN_PRESENT, defaultSender: DEFAULT_SENDER });
  const resultsHtml = renderResults(results);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>WhatsApp Azaleia · ${escapeHtml(placement)}</title>
  <style>
    :root {
      color-scheme: light;
      font-family: 'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #f4f7fb;
      color: #111827;
    }
    body {
      margin: 0;
      min-height: 100vh;
      background: linear-gradient(180deg, #eef2ff 0%, #f4f7fb 100%);
      display: flex;
      flex-direction: column;
    }
    header {
      padding: 32px 40px 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    header h1 {
      margin: 0;
      font-size: 1.75rem;
      color: #1f2937;
    }
    header p {
      margin: 0;
      color: #4b5563;
      max-width: 680px;
    }
    .layout {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
      gap: 24px;
      padding: 0 40px 40px;
      flex: 1;
    }
    .card {
      background: #ffffff;
      border-radius: 18px;
      box-shadow: 0 24px 60px rgba(15, 23, 42, 0.1);
      padding: 24px 28px;
    }
    form {
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    label {
      font-weight: 600;
      margin-bottom: 6px;
      display: block;
      color: #1f2937;
    }
    input[type="text"],
    select,
    textarea {
      width: 100%;
      border: 1px solid #d1d5db;
      border-radius: 10px;
      padding: 11px 12px;
      font-size: 0.95rem;
      font-family: inherit;
      resize: vertical;
      background: #fff;
      box-sizing: border-box;
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }
    input[type="text"]:focus,
    select:focus,
    textarea:focus {
      outline: none;
      border-color: #2563eb;
      box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.2);
    }
    textarea {
      min-height: 110px;
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
      box-shadow: 0 10px 25px rgba(37, 99, 235, 0.3);
    }
    .btn-secondary {
      background: #e5e7eb;
      color: #1f2937;
    }
    .btn-secondary:hover {
      background: #d1d5db;
    }
    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      box-shadow: none;
    }
    .muted {
      color: #6b7280;
      font-size: 0.85rem;
      margin: 6px 0 0;
    }
    .alert {
      border-radius: 12px;
      padding: 14px 18px;
      background: #fee2e2;
      color: #b91c1c;
      font-weight: 600;
      border: 1px solid #fecaca;
    }
    .success-banner {
      border-radius: 12px;
      padding: 14px 18px;
      background: #dcfce7;
      color: #166534;
      font-weight: 600;
      border: 1px solid #bbf7d0;
    }
    .badges {
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
    .expected-list {
      margin: 0;
      padding-left: 20px;
      color: #4b5563;
      font-size: 0.9rem;
    }
    .preview-card {
      background: linear-gradient(150deg, #ffffff 0%, #f9fafb 100%);
      border-radius: 22px;
      padding: 28px;
      box-shadow: 0 20px 45px rgba(15, 23, 42, 0.12);
      position: sticky;
      top: 24px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .preview-card h2 {
      margin: 0;
      font-size: 1.2rem;
      color: #1f2937;
    }
    .preview-card .meta {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      color: #4b5563;
      font-size: 0.85rem;
    }
    .preview-body {
      background: #111827;
      color: #f9fafb;
      padding: 18px;
      border-radius: 14px;
      white-space: pre-wrap;
      line-height: 1.6;
      font-size: 0.95rem;
    }
    .preview-body mark {
      background: #fef08a;
      color: #92400e;
      padding: 0 4px;
      border-radius: 4px;
    }
    footer {
      padding: 16px 40px 28px;
      font-size: 0.85rem;
      color: #6b7280;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .badge.success {
      background: #dcfce7;
      color: #15803d;
    }
    .badge.error {
      background: #fee2e2;
      color: #b91c1c;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      border: 1px solid #e5e7eb;
      padding: 10px 12px;
      text-align: left;
      vertical-align: top;
      font-size: 0.9rem;
    }
    th {
      background: #f3f4f6;
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 0.8rem;
      line-height: 1.4;
    }
    .table-wrapper {
      max-height: 360px;
      overflow: auto;
    }
    .json-hint {
      background: #f1f5f9;
      border-radius: 10px;
      padding: 10px 12px;
      font-size: 0.85rem;
      color: #334155;
      white-space: pre-wrap;
    }
    .error-text {
      color: #b91c1c;
      font-size: 0.85rem;
      margin: 4px 0 0;
    }
  </style>
</head>
<body>
  <header>
    <h1>WhatsApp Azaleia · ${escapeHtml(placement)}</h1>
    <p>Envía plantillas aprobadas de WhatsApp Business hacia tus contactos de Bitrix24.</p>
  </header>
  <main class="layout">
    <section class="card">
      <form method="post" action="${escapeHtml(actionPath)}" id="templateForm">
        <div>
          <label for="templateSelect">Plantilla</label>
          <select id="templateSelect" name="template" required></select>
          <div class="badges" id="templateBadges"></div>
        </div>
        <div>
          <label for="senderSelect">Remitente</label>
          <select id="senderSelect" name="sender" required></select>
          <p class="muted">Los envíos se realizarán con el número oficial seleccionado.</p>
        </div>
        <div>
          <label for="recipients">Destinatarios</label>
          <textarea id="recipients" name="recipients" rows="4" placeholder="+51918131082\n+51999988877" required></textarea>
          <p class="muted">Uno por línea. Máximo 50 por envío. Se completará el prefijo +51 si solo ingresas 9 dígitos.</p>
        </div>
        <div>
          <label for="varsJson">Variables (JSON por plantilla)</label>
          <textarea id="varsJson" name="vars_json" rows="6" placeholder='{"body":["Ana","28/10"]}'></textarea>
          <p class="muted">Ejemplo: {"body":["Ana","28/10"]}. Para cabeceras usa header_text o header_media_url.</p>
          <p id="jsonError" class="error-text" style="display:none;">JSON inválido. Corrige el formato.</p>
          <div id="jsonHint" class="json-hint" style="display:none;"></div>
        </div>
        <div>
          <strong>Variables esperadas</strong>
          <ul class="expected-list" id="expectedList"></ul>
        </div>
        <div class="controls-row">
          <button type="submit" class="btn btn-primary">ENVIAR</button>
          <button type="button" id="healthBtn" class="btn btn-secondary">Probar /health</button>
        </div>
        ${alertMessage ? `<div class="alert">${escapeHtml(alertMessage)}</div>` : ''}
        ${successMessage ? `<div class="success-banner">${escapeHtml(successMessage)}</div>` : ''}
      </form>
    </section>
    <aside class="preview-card" id="previewCard">
      <div>
        <h2 id="previewTitle">Selecciona una plantilla</h2>
        <div class="meta" id="previewMeta"></div>
      </div>
      <div class="preview-body" id="previewBody">Aquí verás la vista previa con las variables resaltadas.</div>
    </aside>
  </main>
  ${resultsHtml}
  <footer>
    Estado del token: <strong>${TOKEN_PRESENT ? 'Sí' : 'No'}</strong> · Puerto: ${PORT}
  </footer>
  <script>
    const templates = ${templateJson};
    const senders = ${sendersJson};
    const initialForm = ${initialFormJson};
    const pageState = ${pageStateJson};

    function collectTemplateKey(template) {
      return template.name + '::' + template.language;
    }

    const templateMap = new Map();
    templates.forEach((template) => {
      templateMap.set(collectTemplateKey(template), template);
    });

    const templateSelect = document.getElementById('templateSelect');
    const senderSelect = document.getElementById('senderSelect');
    const recipientsArea = document.getElementById('recipients');
    const varsArea = document.getElementById('varsJson');
    const expectedList = document.getElementById('expectedList');
    const badges = document.getElementById('templateBadges');
    const previewTitle = document.getElementById('previewTitle');
    const previewMeta = document.getElementById('previewMeta');
    const previewBody = document.getElementById('previewBody');
    const jsonHint = document.getElementById('jsonHint');
    const jsonError = document.getElementById('jsonError');
    const form = document.getElementById('templateForm');
    const healthBtn = document.getElementById('healthBtn');

    function renderTemplateOptions() {
      templateSelect.innerHTML = '';
      templates.forEach((template) => {
        const option = document.createElement('option');
        option.value = collectTemplateKey(template);
        option.textContent = template.name + ' · ' + template.language + ' · ' + template.category;
        templateSelect.appendChild(option);
      });
      if (initialForm.templateKey && templateMap.has(initialForm.templateKey)) {
        templateSelect.value = initialForm.templateKey;
      }
      if (!templateSelect.value && templates.length) {
        templateSelect.value = collectTemplateKey(templates[0]);
      }
    }

    function renderSenderOptions() {
      senderSelect.innerHTML = '';
      senders.forEach((sender) => {
        const option = document.createElement('option');
        option.value = sender.id;
        option.textContent = sender.label;
        senderSelect.appendChild(option);
      });
      const candidate = initialForm.sender || pageState.defaultSender;
      if (candidate) {
        senderSelect.value = candidate;
      }
    }

    function renderExpected(template) {
      expectedList.innerHTML = '';
      if (!template) {
        return;
      }
      if (template.placeholders.body.length) {
        const li = document.createElement('li');
        li.textContent = 'BODY: ' + template.placeholders.body.join(', ');
        expectedList.appendChild(li);
      } else {
        const li = document.createElement('li');
        li.textContent = 'BODY: sin variables';
        expectedList.appendChild(li);
      }
      if (template.placeholders.header.length) {
        const li = document.createElement('li');
        li.textContent = 'HEADER (' + (template.placeholders.headerFormat || 'TEXT') + '): ' + template.placeholders.header.join(', ');
        expectedList.appendChild(li);
      } else if (template.placeholders.headerFormat && ['IMAGE','VIDEO','DOCUMENT'].includes(template.placeholders.headerFormat)) {
        const li = document.createElement('li');
        li.textContent = 'HEADER multimedia: usa header_media_url';
        expectedList.appendChild(li);
      }
    }

    function renderBadges(template) {
      badges.innerHTML = '';
      if (!template) return;
      const info = [template.category, template.language];
      info.forEach((item) => {
        if (!item) return;
        const span = document.createElement('span');
        span.className = 'chip';
        span.textContent = item;
        badges.appendChild(span);
      });
    }

    function highlightPlaceholders(text, values) {
      if (!text) return '';
      return text.replace(/{{(\d+)}}/g, (_, index) => {
        const idx = Number(index) - 1;
        const replacement = values[idx];
        if (replacement !== undefined && replacement !== null && replacement !== '') {
          return '<mark>' + String(replacement) + '</mark>';
        }
        return '<mark>{{' + index + '}}</mark>';
      });
    }

    function parseVariables() {
      const raw = varsArea.value.trim();
      if (!raw) return {};
      try {
        jsonError.style.display = 'none';
        return JSON.parse(raw);
      } catch (error) {
        jsonError.style.display = 'block';
        return null;
      }
    }

    function getBodyValues(template, variablesInput) {
      if (!template || !template.placeholders.body.length) return [];
      if (Array.isArray(variablesInput)) return variablesInput;
      if (variablesInput && typeof variablesInput === 'object') {
        if (Array.isArray(variablesInput.body)) return variablesInput.body;
        if (variablesInput.body && typeof variablesInput.body === 'object') return Object.values(variablesInput.body);
        const collected = [];
        Object.keys(variablesInput)
          .filter((key) => !['header', 'header_text', 'header_media_url', 'buttons'].includes(key))
          .forEach((key) => collected.push(variablesInput[key]));
        return collected;
      }
      return [];
    }

    function renderPreview(template) {
      if (!template) {
        previewTitle.textContent = 'Selecciona una plantilla';
        previewMeta.textContent = '';
        previewBody.textContent = 'Aquí verás la vista previa con las variables resaltadas.';
        return;
      }
      previewTitle.textContent = template.name;
      previewMeta.textContent = template.category + ' · ' + template.language;
      const variablesInput = parseVariables();
      const values = variablesInput === null ? [] : getBodyValues(template, variablesInput || {});
      const placeholders = template.placeholders.body.length;
      const finalValues = [];
      for (let i = 0; i < placeholders; i++) {
        finalValues.push(values[i] !== undefined ? values[i] : template.example.body ? template.example.body[i] : '');
      }
      const bodyComponent = template.components.find((component) => component.type === 'BODY');
      if (bodyComponent && bodyComponent.text) {
        previewBody.innerHTML = highlightPlaceholders(bodyComponent.text, finalValues);
      } else {
        previewBody.textContent = 'La plantilla no contiene cuerpo de texto para vista previa.';
      }
    }

    function renderJsonHint(template) {
      if (!template || !template.example || !Object.keys(template.example).length) {
        jsonHint.style.display = 'none';
        jsonHint.textContent = '';
        return;
      }
      jsonHint.style.display = 'block';
      jsonHint.textContent = JSON.stringify(template.example, null, 2);
    }

    function updateTemplateDetails() {
      const template = templateMap.get(templateSelect.value);
      renderBadges(template);
      renderExpected(template);
      renderJsonHint(template);
      renderPreview(template);
    }

    renderTemplateOptions();
    renderSenderOptions();
    recipientsArea.value = initialForm.recipients || '';
    varsArea.value = initialForm.varsJson || '';

    updateTemplateDetails();

    templateSelect.addEventListener('change', updateTemplateDetails);
    varsArea.addEventListener('input', () => {
      const parsed = parseVariables();
      if (parsed !== null) {
        jsonError.style.display = 'none';
      }
      renderPreview(templateMap.get(templateSelect.value));
    });

    form.addEventListener('submit', (event) => {
      const parsed = parseVariables();
      if (parsed === null) {
        event.preventDefault();
        varsArea.focus();
      }
      if (!pageState.tokenPresent) {
        event.preventDefault();
        alert('Configura META_WABA_TOKEN en el servidor antes de enviar.');
      }
    });

    healthBtn.addEventListener('click', async () => {
      healthBtn.disabled = true;
      try {
        const response = await fetch('/b24-ui/health');
        const data = await response.json();
        alert('Respuesta /health: ' + JSON.stringify(data));
      } catch (error) {
        alert('Error al consultar /health: ' + error.message);
      } finally {
        healthBtn.disabled = false;
      }
    });
  </script>
</body>
</html>`);
}

function detectPlacement(pathname) {
  return pathname.includes('deal') ? 'Deal' : 'Contact';
}

async function handleForm(req, res) {
  const placement = detectPlacement(req.path || req.originalUrl || '');
  const templates = await getTemplates();
  const formData = {
    templateKey: '',
    sender: '',
    recipients: '',
    varsJson: '',
  };
  renderPage({ req, res, placement, templates, formData });
}

async function handlePost(req, res) {
  const placement = detectPlacement(req.path || req.originalUrl || '');
  const templates = await getTemplates();
  const formData = {
    templateKey: req.body?.template || '',
    sender: req.body?.sender || '',
    recipients: req.body?.recipients || '',
    varsJson: req.body?.vars_json || '',
  };

  let alertMessage = '';
  let successMessage = '';
  let results = [];

  if (!TOKEN_PRESENT) {
    alertMessage = 'Configura META_WABA_TOKEN en .env para habilitar los envíos.';
    return renderPage({ req, res, placement, templates, formData, alertMessage, results });
  }

  if (!formData.templateKey) {
    alertMessage = 'Selecciona una plantilla válida.';
    return renderPage({ req, res, placement, templates, formData, alertMessage, results });
  }

  const template = templates.find((item) => `${item.name}::${item.language}` === formData.templateKey);
  if (!template) {
    alertMessage = 'La plantilla seleccionada no está disponible.';
    return renderPage({ req, res, placement, templates, formData, alertMessage, results });
  }

  if (!formData.sender) {
    alertMessage = 'Selecciona un remitente.';
    return renderPage({ req, res, placement, templates, formData, alertMessage, results });
  }

  if (!SENDER_OPTIONS.find((sender) => sender.id === formData.sender)) {
    alertMessage = 'El remitente elegido no es válido.';
    return renderPage({ req, res, placement, templates, formData, alertMessage, results });
  }

  const recipients = splitRecipients(formData.recipients);
  if (!recipients.length) {
    alertMessage = 'Debes indicar al menos un destinatario válido.';
    return renderPage({ req, res, placement, templates, formData, alertMessage, results });
  }

  if (recipients.length > 50) {
    alertMessage = 'El límite es de 50 destinatarios por envío.';
    return renderPage({ req, res, placement, templates, formData, alertMessage, results });
  }

  let variablesInput = {};
  if (formData.varsJson && typeof formData.varsJson === 'string' && formData.varsJson.trim()) {
    try {
      variablesInput = JSON.parse(formData.varsJson);
    } catch (error) {
      alertMessage = 'El campo de variables no contiene JSON válido.';
      return renderPage({ req, res, placement, templates, formData, alertMessage, results });
    }
  }

  try {
    buildComponentsForSend(template, variablesInput);
  } catch (error) {
    alertMessage = error.message || 'No se pudo preparar el envío. Revisa las variables.';
    return renderPage({ req, res, placement, templates, formData, alertMessage, results });
  }

  results = [];
  for (const to of recipients) {
    const response = await sendTemplate({
      phoneId: formData.sender,
      recipient: to,
      template,
      variablesInput,
    });
    if (response.ok) {
      results.push({ to, ok: true, data: response.data });
    } else {
      results.push({ to, ok: false, error: response.error });
    }
  }

  const successCount = results.filter((item) => item.ok).length;
  if (successCount === recipients.length) {
    successMessage = `Envío completado: ${successCount} destinatario(s).`;
  } else if (successCount > 0) {
    successMessage = `Envío parcial: ${successCount} de ${recipients.length} destinatarios confirmados.`;
    alertMessage = 'Revisa los errores reportados por Meta para los destinatarios restantes.';
  } else {
    alertMessage = 'Todos los envíos fallaron. Revisa los detalles devueltos por Meta.';
  }

  renderPage({ req, res, placement, templates, formData, alertMessage, successMessage, results });
}

app.get(['/b24-ui/health', '/health'], (req, res) => {
  res.json({ ok: true, service: 'b24-ui', port: String(PORT) });
});

const formRoutes = ['/contact', '/deal', '/b24-ui/contact', '/b24-ui/deal'];

app.get(formRoutes, async (req, res) => {
  await handleForm(req, res);
});

app.post(formRoutes, async (req, res) => {
  await handlePost(req, res);
});

app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/b24-ui') {
    return handleForm(req, res);
  }
  return next();
});

app.listen(PORT, () => {
  logStartup();
  console.log('[b24-ui] Servidor listo.');
});
