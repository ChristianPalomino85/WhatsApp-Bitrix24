import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import morgan from 'morgan';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import db from './lib/db.js';
import { enqueueTarget } from './lib/queue.js';
import { fetchTargetsFromBitrix, bitrixHealth, pushTimelineComment } from './lib/bitrix.js';
import { normalizePhone, isLikelyValidPhone } from './lib/phone.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json({
  limit: '2mb',
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(morgan('dev'));

const PORT = process.env.PORT || 3001;
const API_TOKEN = process.env.API_TOKEN || '';
const DEFAULT_LANG = process.env.WA_TEMPLATE_LANG || 'es';
const DEFAULT_COUNTRY_CODE = (process.env.DEFAULT_COUNTRY_CODE || process.env.BITRIX_DEFAULT_COUNTRY_CODE || '')
  .replace(/\D/g, '');

if (API_TOKEN) {
  app.use('/api', (req, res, next) => {
    const token = req.get('x-api-key') || req.get('authorization')?.replace(/^Bearer\s+/i, '') || req.query.api_key;
    if (token !== API_TOKEN) {
      return res.status(401).json({ error: 'API token inválido' });
    }
    return next();
  });
}

// UI estática
app.use('/', express.static(path.join(__dirname, 'ui')));

// Helpers
function nowIso() { return new Date().toISOString(); }
function parseJsonValue(raw, { fallback = null, allowPlainString = true } = {}) {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  try {
    return JSON.parse(trimmed);
  } catch {
    return allowPlainString ? trimmed : fallback;
  }
}

function coerceBoolean(val, defaultValue = false) {
  if (val === undefined || val === null || val === '') return defaultValue;
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') return val !== 0;
  if (typeof val === 'string') {
    const normalized = val.trim().toLowerCase();
    if (!normalized) return defaultValue;
    return ['1', 'true', 'yes', 'on'].includes(normalized);
  }
  return defaultValue;
}

function arrayFrom(raw) {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'object') return arrayFrom(Object.values(raw));
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      return arrayFrom(JSON.parse(trimmed));
    } catch {
      return trimmed.split(/[\s,;\n]+/g);
    }
  }
  return [];
}

function parseIds(raw) {
  return arrayFrom(raw).map(String).map((s) => s.trim()).filter(Boolean);
}

function parseVarFields(raw) {
  const parsed = parseJsonValue(raw, { fallback: {}, allowPlainString: false });
  const source = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    const name = String(key || '').trim();
    if (!name) continue;
    if (value === undefined || value === null) continue;
    out[name] = String(value).trim();
  }
  return out;
}

function parseSenderId(raw) {
  if (raw === undefined || raw === null) return null;
  const str = String(raw).trim();
  return str || null;
}

function parseSenderDisplay(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed || null;
  }
  const str = String(raw).trim();
  return str || null;
}

function toTargetObject(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') {
    const trimmed = entry.trim();
    if (!trimmed) return null;
    return { phone: trimmed, vars: {} };
  }
  if (typeof entry === 'object') {
    const phone = entry.phone || entry.number || entry.to;
    if (!phone) return null;
    const rawVars = entry.vars || entry.values || entry.meta || {};
    const varsParsed = parseJsonValue(rawVars, { fallback: {}, allowPlainString: false });
    return {
      phone: String(phone).trim(),
      vars: (varsParsed && typeof varsParsed === 'object' && !Array.isArray(varsParsed)) ? varsParsed : {}
    };
  }
  return null;
}

function parseTargetsInput(raw) {
  const parsed = parseJsonValue(raw, { fallback: raw });
  const base = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' && parsed.phone ? [parsed] : parsed);
  const list = arrayFrom(base);
  const targets = [];
  for (const item of list) {
    const target = toTargetObject(item);
    if (target) targets.push(target);
  }
  return targets;
}

function normalizeTargets(targets = []) {
  const normalized = [];
  let skipped = 0;

  for (const target of targets || []) {
    const phone = normalizePhone(target?.phone, { defaultCountryCode: DEFAULT_COUNTRY_CODE });
    if (!isLikelyValidPhone(phone)) {
      skipped += 1;
      continue;
    }
    normalized.push({
      phone,
      vars: target?.vars || {}
    });
  }

  return { normalized, skipped };
}

function createCampaignRecord({
  name,
  template_name,
  language = DEFAULT_LANG,
  targets = [],
  meta = null,
  sender_phone_id: requestedSender,
  sender_display: requestedDisplay
}) {
  const sender_phone_id = ensureSender(requestedSender, { display: requestedDisplay });
  const { normalized: normalizedTargets, skipped } = normalizeTargets(targets);

  if (!normalizedTargets.length) {
    throw new Error('No hay destinatarios válidos para la campaña');
  }

  const tx = db.transaction(() => {
    const stmt = db.prepare(`INSERT INTO campaigns (name, template_name, language, sender_phone_id, status, created_at, total_targets, meta_json)
      VALUES (?, ?, ?, ?, 'draft', ?, ?, ?)`);
    const info = stmt.run(name, template_name, language, sender_phone_id, nowIso(), normalizedTargets.length, meta ? JSON.stringify(meta) : null);
    const campaign_id = info.lastInsertRowid;

    const tStmt = db.prepare(`INSERT INTO campaign_targets (campaign_id, phone, vars_json, status, created_at, updated_at)
      VALUES (?, ?, ?, 'queued', ?, ?)`);

    let inserted = 0;
    const now = nowIso();
    for (const t of normalizedTargets) {
      try {
        tStmt.run(campaign_id, t.phone, JSON.stringify(t.vars || {}), now, now);
        inserted += 1;
      } catch (err) {
        if (err?.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw err;
      }
    }

    db.prepare('UPDATE campaigns SET total_targets=? WHERE id=?').run(inserted, campaign_id);
    return { campaign_id, inserted, sender_phone_id };
  });

  const result = tx();
  const duplicates = normalizedTargets.length - result.inserted;
  const senderRow = db.prepare('SELECT display FROM senders WHERE phone_id=?').get(result.sender_phone_id);
  return {
    ...result,
    skipped_invalid: skipped,
    duplicates: duplicates > 0 ? duplicates : 0,
    sender_display: senderRow?.display || null
  };
}

function startCampaign(campaign_id) {
  const camp = db.prepare('SELECT * FROM campaigns WHERE id=?').get(campaign_id);
  if (!camp) throw new Error('Campaña no existe');

  const phone_id = ensureSender(camp.sender_phone_id);
  const targets = db.prepare(`SELECT id FROM campaign_targets WHERE campaign_id=? AND status IN ('queued','failed')`).all(campaign_id);

  const tx = db.transaction(() => {
    db.prepare(`UPDATE campaigns SET status='running', sender_phone_id=? WHERE id=?`).run(phone_id, campaign_id);
    for (const t of targets) {
      enqueueTarget({ campaign_id, target_id: t.id, phone_id });
    }
  });
  tx();

  return { enqueued: targets.length };
}

function recordEvent({ waMessageId = null, type, payload }) {
  db.prepare('INSERT INTO events (wa_message_id, type, payload_json, created_at) VALUES (?,?,?,?)')
    .run(waMessageId, type, JSON.stringify(payload || {}), nowIso());
}

function extractBitrixMeta(target) {
  if (!target) return null;
  try {
    const vars = JSON.parse(target.vars_json || '{}');
    return vars?._bitrix || null;
  } catch {
    return null;
  }
}

async function notifyBitrix(target, comment) {
  const meta = extractBitrixMeta(target);
  if (!meta?.entity || !meta?.id || !comment) return;
  try {
    await pushTimelineComment({ entity: meta.entity, entityId: meta.id, comment });
  } catch (err) {
    console.error('[bitrix] No se pudo registrar comentario:', err?.message || err);
  }
}

function buildStatusComment(target, status, errorMsg) {
  const ts = status?.timestamp ? new Date(Number(status.timestamp) * 1000).toISOString() : nowIso();
  let text = `[WhatsApp] Estado ${String(status?.status || 'desconocido').toUpperCase()} para ${target?.phone || 'destinatario'} (${ts}).`;
  if (errorMsg) {
    text += ` Motivo: ${errorMsg}`;
  }
  return text;
}

function buildReplyComment(message, target) {
  const from = message?.from ? `+${message.from}` : 'Cliente';
  const body = message?.text?.body || message?.button?.text || message?.interactive?.button_reply?.title || '';
  const trimmed = String(body || '[sin texto]').trim().slice(0, 400);
  return `[WhatsApp] ${from} respondió a la campaña ${target?.campaign_id || ''}: ${trimmed}`;
}

function verifyWaSignature(req) {
  const secret = process.env.WA_APP_SECRET;
  if (!secret) return true;
  const signature = req.get('x-hub-signature-256');
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(req.rawBody || Buffer.alloc(0)).digest('hex');
  const expectedHeader = `sha256=${expected}`;
  const provided = signature.trim();
  if (expectedHeader.length !== provided.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expectedHeader), Buffer.from(provided));
}
function ensureSender(phone_id, { display } = {}) {
  const resolved = parseSenderId(phone_id) || parseSenderId(process.env.WA_PHONE_NUMBER_ID);
  if (!resolved) {
    throw new Error('Debes configurar WA_PHONE_NUMBER_ID en .env o enviar sender_phone_id.');
  }

  const existing = db.prepare('SELECT display, qps FROM senders WHERE phone_id=?').get(resolved);
  const desiredDisplay = parseSenderDisplay(display) || existing?.display || `+${resolved}`;
  const desiredQps = Number(process.env.SENDER_QPS || existing?.qps || 8);

  if (!existing) {
    db.prepare('INSERT OR IGNORE INTO senders (phone_id, display, qps, created_at) VALUES (?, ?, ?, ?)')
      .run(resolved, desiredDisplay, desiredQps, nowIso());
  } else {
    if (desiredDisplay && desiredDisplay !== existing.display) {
      db.prepare('UPDATE senders SET display=? WHERE phone_id=?').run(desiredDisplay, resolved);
    }
    if (desiredQps && desiredQps !== existing.qps) {
      db.prepare('UPDATE senders SET qps=? WHERE phone_id=?').run(desiredQps, resolved);
    }
  }

  return resolved;
}

// Crear campaña
app.post('/api/campaigns', (req, res) => {
  try {
    const name = req.body?.name;
    const template_name = req.body?.template_name || req.body?.template;
    const language = req.body?.language || DEFAULT_LANG;
    const rawTargets = req.body?.targets ?? req.body?.phones ?? req.body?.numbers;
    const meta = parseJsonValue(req.body?.meta, { fallback: null });
    const targets = parseTargetsInput(rawTargets);
    const sender_phone_id = parseSenderId(req.body?.sender_phone_id ?? req.body?.sender ?? req.body?.phone_id);
    const sender_display = parseSenderDisplay(req.body?.sender_display ?? req.body?.sender_name ?? req.body?.senderName);

    if (!name || !template_name || !targets.length) {
      return res.status(400).json({ error: 'Parámetros inválidos' });
    }

    const { campaign_id, inserted, skipped_invalid, duplicates, sender_phone_id: finalSender, sender_display: finalDisplay } = createCampaignRecord({
      name,
      template_name,
      language,
      targets,
      meta,
      sender_phone_id,
      sender_display
    });
    return res.json({
      ok: true,
      campaign_id,
      total_targets: inserted,
      skipped_invalid,
      duplicates,
      sender_phone_id: finalSender,
      sender_display: finalDisplay
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
});

// Dry-run
app.post('/api/campaigns/:id/dry-run', (req, res) => {
  try {
    const id = Number(req.params.id);
    const camp = db.prepare('SELECT * FROM campaigns WHERE id=?').get(id);
    if (!camp) return res.status(404).json({ error: 'Campaña no existe' });

    const rows = db.prepare('SELECT phone, vars_json FROM campaign_targets WHERE campaign_id=?').all(id);
    const total = rows.length;
    const valid = rows.filter(r => isLikelyValidPhone(r.phone)).length;
    const invalid = total - valid;

    return res.json({ ok: true, total, valid, invalid, sample: rows.slice(0, 5) });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// Start ahora mismo
app.post('/api/campaigns/:id/start', (req, res) => {
  try {
    const id = Number(req.params.id);
    const result = startCampaign(id);
    return res.json({ ok: true, ...result });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// Pausa/Reanuda/Cancelar
app.post('/api/campaigns/:id/pause', (req, res) => {
  const id = Number(req.params.id);
  db.prepare(`UPDATE campaigns SET status='paused' WHERE id=?`).run(id);
  res.json({ ok: true });
});
app.post('/api/campaigns/:id/resume', (req, res) => {
  const id = Number(req.params.id);
  db.prepare(`UPDATE campaigns SET status='running' WHERE id=?`).run(id);
  res.json({ ok: true });
});
app.post('/api/campaigns/:id/cancel', (req, res) => {
  const id = Number(req.params.id);
  db.prepare(`UPDATE campaigns SET status='canceled' WHERE id=?`).run(id);
  db.prepare(`UPDATE campaign_targets SET status='canceled' WHERE campaign_id=? AND status IN ('queued','sending')`).run(id);
  res.json({ ok: true });
});

// Estado/progreso
app.get('/api/campaigns/:id/status', (req, res) => {
  const id = Number(req.params.id);
  const camp = db.prepare('SELECT * FROM campaigns WHERE id=?').get(id);
  if (!camp) return res.status(404).json({ error: 'Campaña no existe' });
  const by = db.prepare(`SELECT status, COUNT(1) c FROM campaign_targets WHERE campaign_id=? GROUP BY status`).all(id);
  const last = db.prepare(`SELECT id, status, last_error FROM campaign_targets WHERE campaign_id=? ORDER BY updated_at DESC LIMIT 20`).all(id);
  res.json({ ok: true, campaign: camp, buckets: by, last });
});

app.get('/api/bitrix/health', async (_req, res) => {
  try {
    const info = await bitrixHealth();
    res.json({ ok: true, info });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/bitrix/campaigns', async (req, res) => {
  try {
    const entity = String(req.body?.entity || req.query?.entity || 'lead').toLowerCase();
    const template_name = req.body?.template_name || req.body?.template || req.body?.templateName;
    const language = req.body?.language || req.body?.lang || DEFAULT_LANG;
    const var_fields = parseVarFields(req.body?.var_fields ?? req.body?.varFields);
    const ids = parseIds(req.body?.ids ?? req.body?.id ?? req.body?.entity_id ?? req.query?.ids);
    const name = req.body?.name || req.body?.campaign_name;
    const auto_start = coerceBoolean(req.body?.auto_start ?? req.body?.autoStart ?? req.query?.auto_start);
    const preview = coerceBoolean(req.body?.preview ?? req.body?.dry ?? req.query?.preview);
    const rawTargets = req.body?.targets ?? req.body?.phones;
    let targets = parseTargetsInput(rawTargets);
    let meta = parseJsonValue(req.body?.meta, { fallback: null });
    const sender_phone_id = parseSenderId(req.body?.sender_phone_id ?? req.body?.sender ?? req.body?.phone_id ?? req.query?.sender_phone_id);
    const sender_display = parseSenderDisplay(req.body?.sender_display ?? req.body?.sender_name ?? req.query?.sender_display);

    if (!template_name) {
      return res.status(400).json({ ok: false, error: 'Falta template_name' });
    }

    if (!targets.length) {
      if (!ids.length) {
        return res.status(400).json({ ok: false, error: 'Debes indicar ids o targets para crear la campaña' });
      }

      targets = await fetchTargetsFromBitrix({ entity, ids, varFields: var_fields });
      meta = meta || { source: { entity, ids, var_fields } };
    } else if (!meta) {
      meta = { source: { entity: 'direct', origin: 'bitrix' } };
    }

    if (!targets.length) {
      return res.status(400).json({ ok: false, error: 'No se hallaron teléfonos válidos en Bitrix24' });
    }

    if (preview) {
      return res.json({ ok: true, preview: { total: targets.length, sample: targets.slice(0, 10) } });
    }

    const campaignName = name || `${entity.toUpperCase()}-${nowIso()}`;
    const { campaign_id, inserted, skipped_invalid, duplicates, sender_phone_id: finalSender, sender_display: finalDisplay } = createCampaignRecord({
      name: campaignName,
      template_name,
      language,
      targets,
      meta,
      sender_phone_id,
      sender_display
    });

    let started = null;
    if (auto_start) {
      started = startCampaign(campaign_id);
    }

    res.json({
      ok: true,
      campaign_id,
      total_targets: inserted,
      skipped_invalid,
      duplicates,
      sender_phone_id: finalSender,
      sender_display: finalDisplay,
      started
    });
  } catch (e) {
    console.error('[bitrix] error creando campaña', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/webhooks/wa', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && challenge && token === process.env.WA_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.status(403).send('forbidden');
});

app.post('/webhooks/wa', async (req, res) => {
  try {
    if (!verifyWaSignature(req)) {
      return res.status(403).json({ ok: false, error: 'Firma inválida' });
    }

    const entries = Array.isArray(req.body?.entry) ? req.body.entry : [];
    for (const entry of entries) {
      const changes = Array.isArray(entry?.changes) ? entry.changes : [];
      for (const change of changes) {
        const value = change?.value || {};
        const statuses = Array.isArray(value.statuses) ? value.statuses : [];
        for (const status of statuses) {
          const messageId = status?.id;
          if (!messageId) continue;
          recordEvent({ waMessageId: messageId, type: status.status || 'status', payload: status });
          const target = db.prepare('SELECT * FROM campaign_targets WHERE wa_message_id=?').get(messageId);
          if (!target) continue;

          const statusMap = { sent: 'sent', delivered: 'delivered', read: 'read', failed: 'failed' };
          const newStatus = statusMap[status.status] || null;
          const now = nowIso();
          if (newStatus === 'failed') {
            const errText = Array.isArray(status.errors)
              ? status.errors.map((e) => e.title || e.message).filter(Boolean).join('; ')
              : status.status || '';
            db.prepare('UPDATE campaign_targets SET status=?, last_error=?, updated_at=? WHERE id=?')
              .run('failed', String(errText).slice(0, 300), now, target.id);
            await notifyBitrix(target, buildStatusComment(target, status, errText));
          } else if (newStatus) {
            db.prepare('UPDATE campaign_targets SET status=?, updated_at=? WHERE id=?')
              .run(newStatus, now, target.id);
            await notifyBitrix(target, buildStatusComment(target, status));
          } else {
            db.prepare('UPDATE campaign_targets SET updated_at=? WHERE id=?').run(now, target.id);
          }
        }

        const messages = Array.isArray(value.messages) ? value.messages : [];
        for (const message of messages) {
          const messageId = message?.id;
          recordEvent({ waMessageId: messageId, type: 'reply', payload: message });

          const contextId = message?.context?.id;
          let target = null;
          if (contextId) {
            target = db.prepare('SELECT * FROM campaign_targets WHERE wa_message_id=?').get(contextId);
          }
          if (!target && message?.from) {
            const normalized = normalizePhone(message.from);
            target = db.prepare('SELECT * FROM campaign_targets WHERE phone=? ORDER BY updated_at DESC LIMIT 1').get(normalized);
          }

          if (target) {
            db.prepare('UPDATE campaign_targets SET updated_at=? WHERE id=?').run(nowIso(), target.id);
            await notifyBitrix(target, buildReplyComment(message, target));
          }
        }
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[webhook:wa] error', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[API] listening on :${PORT}`);
});
