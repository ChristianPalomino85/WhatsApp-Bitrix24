import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';
import db from './lib/db.js';
import { enqueueTarget } from './lib/queue.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '2mb' }));
app.use(morgan('dev'));

const PORT = process.env.PORT || 3001;

// UI estática
app.use('/', express.static(path.join(__dirname, 'ui')));

// Helpers
function nowIso() { return new Date().toISOString(); }
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
    const { name, template_name, language = process.env.WA_TEMPLATE_LANG || 'es', targets } = req.body;
    if (!name || !template_name || !Array.isArray(targets) || targets.length === 0) {
      return res.status(400).json({ error: 'Parámetros inválidos' });
    }
    const sender_phone_id = ensureSender();

    const tx = db.transaction(() => {
      const stmt = db.prepare(`INSERT INTO campaigns (name, template_name, language, sender_phone_id, status, created_at, total_targets)
        VALUES (?, ?, ?, ?, 'draft', ?, ?)`);
      const info = stmt.run(name, template_name, language, sender_phone_id, nowIso(), targets.length);
      const campaign_id = info.lastInsertRowid;

      const tStmt = db.prepare(`INSERT INTO campaign_targets (campaign_id, phone, vars_json, status, created_at, updated_at)
        VALUES (?, ?, ?, 'queued', ?, ?)`);

      for (const t of targets) {
        const phone = String(t.phone).replace(/\D/g, '').replace(/^0+/, '');
        const vars_json = JSON.stringify(t.vars || {});
        try { tStmt.run(campaign_id, phone, vars_json, nowIso(), nowIso()); } catch { /* dedupe */ }
      }
      return campaign_id;
    });

    const campaign_id = tx();
    return res.json({ ok: true, campaign_id });
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
    const valid = rows.filter(r => /^\d{7,15}$/.test(r.phone)).length;
    const invalid = total - valid;

    return res.json({ ok: true, total, valid, invalid, sample: rows.slice(0, 5) });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// Start ahora mismo
app.post('/api/campaigns/:id/start', (req, res) => {
  try {
    const id = Number(req.params.id);
    const camp = db.prepare('SELECT * FROM campaigns WHERE id=?').get(id);
    if (!camp) return res.status(404).json({ error: 'Campaña no existe' });

    const phone_id = camp.sender_phone_id || ensureSender();
    const targets = db.prepare(`SELECT id FROM campaign_targets WHERE campaign_id=? AND status IN ('queued','failed')`).all(id);

    const tx = db.transaction(() => {
      db.prepare(`UPDATE campaigns SET status='running' WHERE id=?`).run(id);
      for (const t of targets) {
        enqueueTarget({ campaign_id: id, target_id: t.id, phone_id });
      }
    });
    tx();

    return res.json({ ok: true, enqueued: targets.length });
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

// Webhook WA (placeholder)
app.post('/webhooks/wa', (req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`[API] listening on :${PORT}`);
});
