import 'dotenv/config';
import db from './lib/db.js';
import { fetchBatch, markDone, markFailed } from './lib/queue.js';
import { sendTemplate, inWindow } from './lib/wa.js';

const TOKEN = process.env.WA_ACCESS_TOKEN;
const LANG = process.env.WA_TEMPLATE_LANG || 'es';
const LOOP_MS = Number(process.env.WORKER_LOOP_MS || 300);
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 20);
const WINDOW = process.env.DELIVERY_WINDOW || '';

if (!TOKEN) {
  console.error('Falta WA_ACCESS_TOKEN en .env');
  process.exit(1);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function tick() {
  try {
    const now = new Date();
    if (!inWindow(now, WINDOW)) return;

    const batch = fetchBatch({ limit: BATCH_SIZE });
    if (!batch.length) return;

    for (const job of batch) {
      const camp = db.prepare('SELECT * FROM campaigns WHERE id=?').get(job.campaign_id);
      if (!camp || ['paused','canceled','done','error'].includes(camp.status)) { markDone(job.id); continue; }

      const target = db.prepare('SELECT * FROM campaign_targets WHERE id=?').get(job.target_id);
      if (!target) { markDone(job.id); continue; }

      if (!/^\d{7,15}$/.test(target.phone)) {
        db.prepare('UPDATE campaign_targets SET status=?, last_error=?, updated_at=? WHERE id=?')
          .run('failed', 'telefono_invalido', new Date().toISOString(), target.id);
        markDone(job.id);
        continue;
      }

      try {
        db.prepare('UPDATE campaign_targets SET status=?, updated_at=? WHERE id=?')
          .run('sending', new Date().toISOString(), target.id);

        const vars = JSON.parse(target.vars_json || '{}');
        const components = [];
        const bodyParams = Object.values(vars).map(v => ({ type: 'text', text: String(v) }));
        if (bodyParams.length) components.push({ type: 'body', parameters: bodyParams });

        const resp = await sendTemplate({
          phone_id: camp.sender_phone_id,
          token: TOKEN,
          to: target.phone,
          template_name: camp.template_name,
          language: camp.language || LANG,
          components
        });

        const wa_id = resp?.messages?.[0]?.id || null;

        const nowIso = new Date().toISOString();
        db.prepare('INSERT INTO messages (campaign_id, target_id, payload_json, result_json, created_at) VALUES (?,?,?,?,?)')
          .run(camp.id, target.id, JSON.stringify({ components }), JSON.stringify(resp), nowIso);
        db.prepare('UPDATE campaign_targets SET status=?, wa_message_id=?, updated_at=? WHERE id=?')
          .run('sent', wa_id, nowIso, target.id);

        markDone(job.id);
        await sleep(1000 / Math.max(1, Number(process.env.SENDER_QPS || 8)));
      } catch (err) {
        const msg = (err?.response?.data && JSON.stringify(err.response.data)) || err.message;
        db.prepare('UPDATE campaign_targets SET status=?, last_error=?, updated_at=? WHERE id=?')
          .run('failed', String(msg).slice(0, 500), new Date().toISOString(), target.id);
        markFailed(job.id, 3000);
      }
    }

    // Si no hay pendientes de cola, marcar campañas como done si corresponde
    const pending = db.prepare("SELECT COUNT(1) c FROM queue WHERE status!='done'").get().c;
    if (pending === 0) {
      const camps = db.prepare("SELECT id FROM campaigns WHERE status='running'").all();
      for (const c of camps) {
        const left = db.prepare("SELECT COUNT(1) c FROM campaign_targets WHERE campaign_id=? AND status IN ('queued','sending','failed')").get(c.id).c;
        if (left === 0) db.prepare("UPDATE campaigns SET status='done' WHERE id=?").run(c.id);
      }
    }
  } catch (e) {
    console.error('[worker] error', e);
  }
}

console.log(`[worker] loop=${LOOP_MS}ms batch=${BATCH_SIZE} window='${WINDOW || 'none'}'`);
setInterval(tick, LOOP_MS);
