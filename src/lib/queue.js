import db from './db.js';

export function enqueueTarget({ campaign_id, target_id, phone_id }) {
  const now = Date.now();
  const stmt = db.prepare(`INSERT INTO queue (campaign_id, target_id, phone_id, available_at)
    VALUES (@campaign_id, @target_id, @phone_id, @available_at)`);
  stmt.run({ campaign_id, target_id, phone_id, available_at: now });
}

export function fetchBatch({ limit = 20 }) {
  const now = Date.now();
  const tx = db.transaction(() => {
    const rows = db.prepare(`SELECT id, campaign_id, target_id, phone_id, attempts
      FROM queue WHERE status='queued' AND available_at<=? ORDER BY id ASC LIMIT ?`).all(now, limit);
    const ids = rows.map(r => r.id);
    if (ids.length) {
      const mark = db.prepare(`UPDATE queue SET status='processing' WHERE id=?`);
      for (const id of ids) mark.run(id);
    }
    return rows;
  });
  return tx();
}

export function markDone(id) {
  db.prepare(`UPDATE queue SET status='done' WHERE id=?`).run(id);
}

export function markFailed(id, backoffMs = 5000) {
  const now = Date.now();
  const row = db.prepare(`SELECT attempts FROM queue WHERE id=?`).get(id);
  const attempts = (row?.attempts ?? 0) + 1;
  const avail = now + backoffMs * Math.min(attempts, 10);
  db.prepare(`UPDATE queue SET status='queued', attempts=?, available_at=? WHERE id=?`).run(attempts, avail, id);
}
