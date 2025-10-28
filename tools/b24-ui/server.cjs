#!/usr/bin/env node
const express = require('express');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const GRAPH_VERSIONS = ['v20.0', 'v19.0', 'v17.0'];
const CACHE_TTL_MS = 60 * 1000;
const META_TOKEN = process.env.META_TOKEN;
const WABA_ID = process.env.WABA_ID;
const DEFAULT_TEMPLATE_LANG = process.env.DEFAULT_TEMPLATE_LANG || 'es_PE';
const DEFAULT_SENDER = process.env.DEFAULT_SENDER || process.env.PHONE_ID_1 || process.env.PHONE_ID_2 || process.env.PHONE_ID_3 || '';
const DRY_RUN = String(process.env.DRY_RUN || '').toLowerCase() === 'true';
const PORT = Number(process.env.PORT || 3060);

const PHONE_IDS = [process.env.PHONE_ID_1, process.env.PHONE_ID_2, process.env.PHONE_ID_3].filter(Boolean);

const missingEnv = [];
['META_TOKEN', 'WABA_ID'].forEach((key) => {
  if (!process.env[key]) missingEnv.push(key);
});
if (!DEFAULT_SENDER) missingEnv.push('DEFAULT_SENDER');

const cache = {
  senders: null,
  templates: null,
};

function redactTokens(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (value.toLowerCase().includes('token') || value.toLowerCase().includes('secret')) return '[redactado]';
    return value;
  }
  if (Array.isArray(value)) return value.map(redactTokens);
  if (typeof value === 'object') {
    return Object.keys(value).reduce((acc, key) => {
      const lower = key.toLowerCase();
      if (lower.includes('token') || lower.includes('secret') || lower.includes('auth')) return acc;
      acc[key] = redactTokens(value[key]);
      return acc;
    }, {});
  }
  return value;
}

function normalizeRecipient(raw) {
  if (!raw) return null;
  const digits = raw.replace(/[^0-9+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) {
    return `+${digits.replace(/[^0-9]/g, '')}`;
  }
  const clean = digits.replace(/[^0-9]/g, '');
  if (clean.startsWith('51')) return `+${clean}`;
  if (clean.startsWith('9')) return `+51${clean}`;
  if (clean.length > 0) return `+${clean}`;
  return null;
}

async function graphFetch(url, { method = 'GET', headers = {}, body } = {}, useQueryToken = false) {
  const finalHeaders = { ...headers };
  if (!useQueryToken) {
    finalHeaders.Authorization = `Bearer ${META_TOKEN}`;
  }
  finalHeaders['Content-Type'] = finalHeaders['Content-Type'] || 'application/json';
  try {
    const response = await fetch(url, {
      method,
      headers: finalHeaders,
      body,
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

async function resolvePhoneDisplay(phoneId) {
  for (const version of GRAPH_VERSIONS) {
    const base = `https://graph.facebook.com/${version}/${phoneId}?fields=display_phone_number`;
    const { ok, data } = await graphFetch(base, {}, false);
    if (ok && data && data.display_phone_number) {
      return { id: phoneId, display_phone_number: data.display_phone_number };
    }
    if (ok && data && data.phone_number) {
      return { id: phoneId, display_phone_number: data.phone_number };
    }
  }
  return { id: phoneId };
}

async function loadSenders() {
  if (cache.senders && cache.senders.expires > Date.now()) {
    return cache.senders.value;
  }
  const senders = [];
  if (PHONE_IDS.length) {
    for (const id of PHONE_IDS) {
      senders.push(await resolvePhoneDisplay(id));
    }
  } else if (WABA_ID) {
    for (const version of GRAPH_VERSIONS) {
      const url = `https://graph.facebook.com/${version}/${WABA_ID}/phone_numbers`;
      const { ok, data } = await graphFetch(url);
      if (ok && data && Array.isArray(data.data)) {
        data.data.forEach((item) => {
          senders.push({ id: item.id || item.phone_number_id || item.phone_number, display_phone_number: item.display_phone_number || item.phone_number });
        });
        break;
      }
    }
  }
  cache.senders = { value: senders, expires: Date.now() + CACHE_TTL_MS };
  return senders;
}

function mapTemplate(template) {
  return {
    id: template.id,
    name: template.name,
    language: template.language || template.language_code,
    category: template.category,
    components: Array.isArray(template.components) ? template.components.map((component) => ({
      type: component.type,
      format: component.format,
      example: component.example,
      text: component.text,
      buttons: component.buttons,
      variables: component.example || component.text,
    })) : [],
  };
}

async function loadTemplates() {
  if (cache.templates && cache.templates.expires > Date.now()) {
    return cache.templates.value;
  }
  for (const version of GRAPH_VERSIONS) {
    const url = `https://graph.facebook.com/${version}/${WABA_ID}/message_templates?limit=200`;
    const { ok, data } = await graphFetch(url);
    if (ok && data && Array.isArray(data.data)) {
      const templates = data.data.map(mapTemplate);
      cache.templates = { value: templates, expires: Date.now() + CACHE_TTL_MS };
      return templates;
    }
  }
  return [];
}

function buildComponentsFromVariables(vars) {
  if (!vars || typeof vars !== 'object') return [];
  const clone = { ...vars };
  const components = [];
  if (clone.header_media_url) {
    components.push({
      type: 'header',
      parameters: [
        {
          type: 'image',
          image: { link: String(clone.header_media_url) },
        },
      ],
    });
    delete clone.header_media_url;
  }
  if (clone.header_text) {
    components.push({
      type: 'header',
      parameters: [
        {
          type: 'text',
          text: String(clone.header_text),
        },
      ],
    });
    delete clone.header_text;
  }
  let bodyValues;
  if (Array.isArray(clone.body)) {
    bodyValues = clone.body;
    delete clone.body;
  } else if (clone.body && typeof clone.body === 'object') {
    bodyValues = Object.values(clone.body);
    delete clone.body;
  }
  if (!bodyValues) {
    const remainingKeys = Object.keys(clone).filter((key) => !/^button/i.test(key));
    if (remainingKeys.length) {
      bodyValues = remainingKeys.map((key) => clone[key]);
      remainingKeys.forEach((key) => delete clone[key]);
    }
  }
  if (bodyValues && bodyValues.length) {
    components.push({
      type: 'body',
      parameters: bodyValues.map((value) => ({ type: 'text', text: String(value) })),
    });
  }
  const buttonMatches = Object.keys(clone).filter((key) => key.startsWith('button_'));
  buttonMatches.forEach((key) => {
    const value = clone[key];
    const match = key.match(/^button_(url|payload)_?(\d+)?$/i);
    if (!match) return;
    const [, type, indexRaw] = match;
    const index = indexRaw ? String(Number(indexRaw) - 1) : '0';
    if (type.toLowerCase() === 'url') {
      components.push({
        type: 'button',
        sub_type: 'url',
        index,
        parameters: [{ type: 'text', text: String(value) }],
      });
    } else {
      components.push({
        type: 'button',
        sub_type: 'quick_reply',
        index,
        parameters: [{ type: 'payload', payload: String(value) }],
      });
    }
    delete clone[key];
  });
  return components;
}

async function sendTemplateMessage(recipient, { template, language, sender }) {
  const components = buildComponentsFromVariables(template.variables || {});
  const payload = {
    messaging_product: 'whatsapp',
    to: recipient,
    type: 'template',
    template: {
      name: template.name,
      language: { code: language },
    },
  };
  if (components.length) {
    payload.template.components = components;
  }
  const versions = GRAPH_VERSIONS;
  const attempts = [];
  for (const version of versions) {
    const baseUrl = `https://graph.facebook.com/${version}/${sender}/messages`;
    for (const useQueryToken of [false, true]) {
      const url = useQueryToken ? `${baseUrl}?access_token=${encodeURIComponent(META_TOKEN)}` : baseUrl;
      const { ok, status, data } = await graphFetch(url, {
        method: 'POST',
        body: JSON.stringify(payload),
      }, useQueryToken);
      attempts.push({ version, useQueryToken, status, data });
      if (ok) {
        const message = Array.isArray(data.messages) && data.messages[0] ? data.messages[0] : null;
        return {
          success: true,
          status: message && message.status ? message.status : 'sent',
          id: message && message.id ? message.id : undefined,
        };
      }
    }
  }
  const last = attempts[attempts.length - 1] || {};
  return {
    success: false,
    status: last.status,
    error: last.data && last.data.error ? last.data.error.message || JSON.stringify(last.data.error) : JSON.stringify(last.data || {}),
  };
}

function parseVariables(jsonText) {
  if (!jsonText) return {};
  try {
    const value = JSON.parse(jsonText);
    if (value && typeof value === 'object') return value;
    return {};
  } catch (error) {
    throw new Error('JSON inválido en Variables. Ejemplo: {"name":"Ana"}');
  }
}

function renderLayout({ title, placement, content, error, success, debugPayload }) {
  const messageBlock = error
    ? `<div class="alert alert-error">${error}</div>`
    : success
      ? `<div class="alert alert-success">${success}</div>`
      : '';
  const missingBlock = missingEnv.length
    ? `<div class="alert alert-error">Faltan variables de entorno: ${missingEnv.join(', ')}</div>`
    : '';
  const dryRunBlock = DRY_RUN ? '<div class="alert alert-error">DRY_RUN está activo: no se enviarán mensajes reales.</div>' : '';
  const debug = debugPayload
    ? `<details class="debug"><summary>DEBUG: payload Bitrix (click)</summary><pre>${debugPayload}</pre></details>`
    : '';
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
body { font-family: "Segoe UI", Roboto, sans-serif; background: #f5f6f9; margin: 0; padding: 0; color: #1d1d1f; }
header { background: #1a73e8; color: #fff; padding: 1.5rem; }
main { padding: 1.5rem; }
.container { max-width: 960px; margin: 0 auto; background: #fff; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.08); padding: 2rem; }
h1 { margin: 0; font-size: 1.8rem; }
form { display: grid; gap: 1.5rem; }
label { font-weight: 600; display: block; margin-bottom: 0.5rem; }
select, textarea, input[type="text"] { width: 100%; padding: 0.75rem; border: 1px solid #cbd2d9; border-radius: 8px; font-size: 1rem; resize: vertical; }
textarea { min-height: 120px; }
.grid { display: grid; gap: 1.5rem; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
.buttons { display: flex; gap: 1rem; flex-wrap: wrap; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 0.5rem; border-radius: 999px; padding: 0.75rem 1.5rem; font-weight: 600; text-decoration: none; border: none; cursor: pointer; transition: box-shadow 0.2s ease, transform 0.2s ease; }
.btn-primary { background: #1a73e8; color: #fff; }
.btn-secondary { background: #e4e7eb; color: #111827; }
.btn:hover { box-shadow: 0 4px 12px rgba(26,115,232,0.3); transform: translateY(-1px); }
.alert { padding: 1rem 1.5rem; border-radius: 8px; margin-bottom: 1rem; }
.alert-error { background: #fdecea; color: #c0392b; }
.alert-success { background: #ecfdf3; color: #1b5e20; }
details.debug { margin-top: 1.5rem; background: #f1f5f9; padding: 1rem; border-radius: 8px; }
details.debug pre { white-space: pre-wrap; word-break: break-word; font-size: 0.9rem; }
#template-info { background: #f9fafc; border-radius: 8px; padding: 1rem; font-size: 0.95rem; }
#template-info ul { margin: 0.5rem 0 0 1rem; padding: 0; }
table.results { width: 100%; border-collapse: collapse; margin-top: 1.5rem; }
table.results th, table.results td { border: 1px solid #d9e2ec; padding: 0.75rem; text-align: left; }
table.results th { background: #f1f5f9; }
footer { margin-top: 2rem; font-size: 0.85rem; color: #6b7280; text-align: center; }
</style>
</head>
<body>
<header><h1>WhatsApp Azaleia · ${placement}</h1></header>
<main>
<div class="container">
${missingBlock}
${dryRunBlock}
${messageBlock}
${content}
${debug}
</div>
<footer>Meta WABA · Bitrix24 UI helper</footer>
</main>
<script>
const state = {
  defaultSender: ${JSON.stringify(DEFAULT_SENDER)},
  defaultLanguage: ${JSON.stringify(DEFAULT_TEMPLATE_LANG)},
};
async function loadUiData() {
  const response = await fetch('./ui-data');
  if (!response.ok) throw new Error('No se pudo cargar ui-data');
  return response.json();
}
function populateSelect(select, items, formatter) {
  select.innerHTML = '';
  if (!items.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Sin opciones disponibles';
    option.disabled = true;
    option.selected = true;
    select.appendChild(option);
    return;
  }
  items.forEach((item) => {
    const option = document.createElement('option');
    const { value, label } = formatter(item);
    option.value = value;
    option.textContent = label;
    select.appendChild(option);
  });
}
function renderTemplateInfo(container, template) {
  container.innerHTML = '';
  if (!template) {
    container.innerHTML = '<em>Selecciona una plantilla para ver sus variables.</em>';
    return;
  }
  const title = document.createElement('div');
  title.innerHTML = '<strong>Variables esperadas por plantilla</strong>';
  container.appendChild(title);
  if (!Array.isArray(template.components) || !template.components.length) {
    const empty = document.createElement('div');
    empty.textContent = 'La plantilla no expone componentes parametrizables.';
    container.appendChild(empty);
    return;
  }
  const list = document.createElement('ul');
  template.components.forEach((component) => {
    const item = document.createElement('li');
    const compTitle = component.type + (component.format ? ' · ' + component.format : '');
    let detail = '';
    if (component.example) {
      detail = JSON.stringify(component.example);
    } else if (component.text) {
      detail = component.text;
    }
    item.textContent = compTitle + (detail ? ': ' + detail : '');
    list.appendChild(item);
  });
  container.appendChild(list);
}
function setupUi() {
  const templateSelect = document.querySelector('#template');
  const languageSelect = document.querySelector('#language');
  const senderSelect = document.querySelector('#sender');
  const infoContainer = document.querySelector('#template-info');
  loadUiData().then((data) => {
    const templates = data.templates || [];
    const senders = data.senders || [];
    populateSelect(templateSelect, templates, (tpl) => ({ value: tpl.name + '::' + (tpl.language || state.defaultLanguage), label: tpl.name + ' · ' + (tpl.language || state.defaultLanguage) + ' · ' + (tpl.category || 'SIN CATEGORÍA') }));
    populateSelect(languageSelect, templates.reduce((acc, tpl) => {
      if (!acc.some((item) => item.language === tpl.language)) {
        acc.push({ language: tpl.language });
      }
      return acc;
    }, []).sort((a, b) => (a.language || '').localeCompare(b.language || '')), (item) => ({ value: item.language, label: item.language }));
    if (languageSelect.options.length && state.defaultLanguage) {
      const option = Array.from(languageSelect.options).find((opt) => opt.value === state.defaultLanguage);
      if (option) languageSelect.value = state.defaultLanguage;
    }
    populateSelect(senderSelect, senders.length ? senders : [{ id: state.defaultSender }], (sender) => {
      const label = sender.display_phone_number ? sender.display_phone_number + ' · ' + sender.id : sender.id;
      return { value: sender.id, label };
    });
    if (state.defaultSender) {
      const option = Array.from(senderSelect.options).find((opt) => opt.value === state.defaultSender);
      if (option) senderSelect.value = state.defaultSender;
    }
    const templateMap = new Map();
    templates.forEach((tpl) => {
      templateMap.set(tpl.name + '::' + (tpl.language || state.defaultLanguage), tpl);
    });
    function updateTemplateInfo() {
      const key = templateSelect.value;
      const template = templateMap.get(key);
      if (template && template.language) {
        const opt = Array.from(languageSelect.options).find((option) => option.value === template.language);
        if (opt) {
          languageSelect.value = template.language;
        }
      }
      renderTemplateInfo(infoContainer, template);
    }
    templateSelect.addEventListener('change', updateTemplateInfo);
    updateTemplateInfo();
    document.querySelector('#health-btn').addEventListener('click', async (event) => {
      event.preventDefault();
      try {
        const res = await fetch('./health');
        const json = await res.json();
        alert('Health check: ' + JSON.stringify(json));
      } catch (error) {
        alert('Health check falló: ' + error.message);
      }
    });
  }).catch((error) => {
    infoContainer.innerHTML = '<span style="color:#c0392b">No se pudo cargar /ui-data: ' + error.message + '</span>';
  });
}
document.addEventListener('DOMContentLoaded', setupUi);
</script>
</body>
</html>`;
}

function renderFormPage({ placement, error, success, debugPayload }) {
  const form = `<form method="post" action="./send">
  <input type="hidden" name="placement" value="${placement}" />
  <div class="grid">
    <div>
      <label for="template">Plantilla</label>
      <select id="template" name="template" required>
        <option value="">Cargando plantillas...</option>
      </select>
    </div>
    <div>
      <label for="language">Idioma</label>
      <select id="language" name="language" required>
        <option value="">Cargando...</option>
      </select>
    </div>
  </div>
  <div class="grid">
    <div>
      <label for="sender">Remitente</label>
      <select id="sender" name="sender_phone_id" required>
        <option value="">Cargando remitentes...</option>
      </select>
    </div>
  </div>
  <div>
    <label for="recipients">Destinatarios (uno por línea)</label>
    <textarea id="recipients" name="recipients" placeholder="+51918131082\n+51912345678" required></textarea>
  </div>
  <div>
    <label for="variables">Variables (JSON por plantilla)</label>
    <textarea id="variables" name="variables_json" placeholder='{"name":"Ana","promo_fecha":"28/10"}'></textarea>
  </div>
  <div id="template-info"></div>
  <div class="buttons">
    <button class="btn btn-primary" type="submit">ENVIAR</button>
    <button class="btn btn-secondary" id="health-btn">Probar /health</button>
  </div>
</form>`;
  return renderLayout({
    title: `WhatsApp Azaleia · ${placement}`,
    placement,
    content: form,
    error,
    success,
    debugPayload,
  });
}

function renderResultPage({ placement, results }) {
  const rows = results.map((item) => `<tr><td>${item.to}</td><td>${item.success ? 'OK' : 'Error'}</td><td>${item.success ? (item.id || item.status) : (item.error || item.status)}</td></tr>`).join('');
  const content = `
  <div>
    <h2>Resultado del envío</h2>
    <table class="results">
      <thead><tr><th>Destinatario</th><th>Estado</th><th>ID / Error</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="buttons" style="margin-top:1.5rem">
      <a class="btn btn-secondary" href="javascript:history.back();">Volver</a>
    </div>
  </div>`;
  return renderLayout({ title: `WhatsApp Azaleia · ${placement}`, placement, content });
}

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'b24-ui', port: PORT, dryRun: DRY_RUN });
});

async function handlePlacement(req, res, placement) {
  const debugPayload = Object.keys(req.body || {}).length ? JSON.stringify(redactTokens(req.body), null, 2) : null;
  res.send(renderFormPage({ placement, debugPayload }));
}

app.get(['/contact', '/deal'], (req, res) => {
  const placement = req.path === '/deal' ? 'Deal' : 'Contact';
  handlePlacement(req, res, placement);
});
app.post(['/contact', '/deal'], (req, res) => {
  const placement = req.path === '/deal' ? 'Deal' : 'Contact';
  handlePlacement(req, res, placement);
});

app.get('/ui-data', async (req, res) => {
  if (!META_TOKEN || !WABA_ID) {
    res.status(400).json({ error: 'Config incompleta' });
    return;
  }
  try {
    const [senders, templates] = await Promise.all([loadSenders(), loadTemplates()]);
    res.json({
      senders,
      templates,
      defaults: {
        sender: DEFAULT_SENDER,
        language: DEFAULT_TEMPLATE_LANG,
      },
    });
  } catch (error) {
    console.error('ui-data error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/send', async (req, res) => {
  const placement = req.body.placement || 'Contact';
  const templateSelection = req.body.template;
  const language = req.body.language || DEFAULT_TEMPLATE_LANG;
  const sender = req.body.sender_phone_id || DEFAULT_SENDER;
  const recipientsRaw = req.body.recipients || '';
  const variablesText = req.body.variables_json || '';

  const errors = [];
  if (!sender) errors.push('Falta seleccionar el remitente.');
  if (!templateSelection) errors.push('Selecciona una plantilla.');
  const recipients = recipientsRaw
    .split(/\r?\n/)
    .map((value) => normalizeRecipient(value.trim()))
    .filter(Boolean);
  if (!recipients.length) {
    errors.push('Proporciona al menos un destinatario válido.');
  }
  let variables;
  try {
    variables = parseVariables(variablesText);
  } catch (error) {
    errors.push(error.message);
  }
  if (missingEnv.length) {
    errors.push(`Config incompleta: ${missingEnv.join(', ')}`);
  }
  if (errors.length) {
    const debugPayload = Object.keys(req.body || {}).length ? JSON.stringify(redactTokens(req.body), null, 2) : null;
    res.status(400).send(renderFormPage({ placement, error: errors.join(' '), debugPayload }));
    return;
  }
  const [templateName] = templateSelection.split('::');
  const templatePayload = { name: templateName, variables };
  const results = [];
  if (DRY_RUN) {
    recipients.forEach((to) => {
      results.push({ to, success: true, status: 'dry_run' });
    });
    res.send(renderResultPage({ placement, results }));
    return;
  }
  for (const to of recipients) {
    try {
      const outcome = await sendTemplateMessage(to, { template: templatePayload, language, sender });
      results.push({ to, ...outcome });
    } catch (error) {
      results.push({ to, success: false, status: 500, error: error.message });
    }
  }
  res.send(renderResultPage({ placement, results }));
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`b24-ui server listening on port ${PORT}`);
});

// --- PRUEBAS MANUALES ---
// curl -sSI http://localhost:3060/health
// curl -s http://localhost:3060/ui-data
// Abrir http://localhost:3060/contact en el navegador y enviar plantilla de prueba.
