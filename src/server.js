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
function normalizeTargets(targets = []) {
  return targets
    .map((t) => ({
      phone: normalizePhone(t.phone),
      vars: t.vars || {}
    }))
    .filter((t) => t.phone);
}

function createCampaignRecord({ name, template_name, language = DEFAULT_LANG, targets = [], meta = null }) {
  const sender_phone_id = ensureSender();
  const normalizedTargets = normalizeTargets(targets);

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

  return tx();
}

function startCampaign(campaign_id) {
  const camp = db.prepare('SELECT * FROM campaigns WHERE id=?').get(campaign_id);
  if (!camp) throw new Error('Campaña no existe');

  const phone_id = camp.sender_phone_id || ensureSender();
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
function ensureSender() {
  const phone_id = process.env.WA_PHONE_NUMBER_ID;
  if (!phone_id) throw new Error('Falta WA_PHONE_NUMBER_ID en .env');
  const exists = db.prepare('SELECT 1 FROM senders WHERE phone_id=?').get(phone_id);
  if (!exists) {
    db.prepare('INSERT OR IGNORE INTO senders (phone_id, display, qps, created_at) VALUES (?, ?, ?, ?)')
      .run(phone_id, `+${phone_id}`, Number(process.env.SENDER_QPS || 8), nowIso());
  }
  return phone_id;
}

// Crear campaña
app.post('/api/campaigns', (req, res) => {
  try {
    const { name, template_name, language = DEFAULT_LANG, targets, meta } = req.body;
    if (!name || !template_name || !Array.isArray(targets) || targets.length === 0) {
      return res.status(400).json({ error: 'Parámetros inválidos' });
    }

    const { campaign_id, inserted } = createCampaignRecord({ name, template_name, language, targets, meta });
    return res.json({ ok: true, campaign_id, total_targets: inserted });
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
    const { entity = 'lead', ids, template_name, language = DEFAULT_LANG, name, var_fields = {}, auto_start = false, preview = false } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ ok: false, error: 'ids debe ser un arreglo con al menos un ID de Bitrix24' });
    }
    if (!template_name) {
      return res.status(400).json({ ok: false, error: 'Falta template_name' });
    }

    const targets = await fetchTargetsFromBitrix({ entity, ids, varFields: var_fields });
    if (!targets.length) {
      return res.status(400).json({ ok: false, error: 'No se hallaron teléfonos válidos en Bitrix24' });
    }

    if (preview) {
      return res.json({ ok: true, preview: { total: targets.length, sample: targets.slice(0, 10) } });
    }

    const campaignName = name || `${entity.toUpperCase()}-${nowIso()}`;
    const meta = { source: { entity, ids, var_fields } };
    const { campaign_id, inserted } = createCampaignRecord({ name: campaignName, template_name, language, targets, meta });

    let started = null;
    if (auto_start) {
      started = startCampaign(campaign_id);
    }

    res.json({ ok: true, campaign_id, total_targets: inserted, started });
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
