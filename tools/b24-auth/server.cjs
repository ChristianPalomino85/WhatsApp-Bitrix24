/**
 * Mini-servicio OAuth Bitrix24 (puerto 3032 por defecto)
 * Rutas:
 *  - GET /auth/start[?dry=1] -> redirige a autorización (o devuelve URL si dry=1)
 *  - GET /auth/callback?code=...&state=... -> intercambia code por tokens y guarda en data/b24_tokens.json
 *  - GET /health -> OK
 * No requiere paquetes nuevos: usa express (ya presente) y fetch nativo de Node 18+.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const app = express();

/* Carga .env.b24 manual (sin dependencias) */
(function loadEnvB24() {
  const envPath = path.join(process.cwd(), '.env.b24');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) {
        let val = m[2].replace(/^['"]|['"]$/g, '');
        process.env[m[1]] = val;
      }
    }
  }
})();

const PORT = Number(process.env.PORT || 3032);
const BASE = (process.env.B24_BASE_URL || '').replace(/\/+$/,'');
const CID  = process.env.B24_CLIENT_ID || '';
const SEC  = process.env.B24_CLIENT_SECRET || '';
const RED  = process.env.B24_REDIRECT_URI || '';
const SCOPE= process.env.B24_SCOPE || 'imopenlines,imconnector,user';

function assertEnv(res) {
  const missing = [];
  if (!BASE) missing.push('B24_BASE_URL');
  if (!CID)  missing.push('B24_CLIENT_ID');
  if (!SEC)  missing.push('B24_CLIENT_SECRET');
  if (!RED)  missing.push('B24_REDIRECT_URI');
  if (missing.length) {
    res.status(500).json({ ok:false, error:'Faltan variables en .env.b24', missing });
    return false;
  }
  return true;
}

app.get('/health', (_req,res)=>res.json({ok:true, service:'b24-oauth', port:PORT}));

app.get('/auth/start', (req,res)=>{
  if (!assertEnv(res)) return;
  const state = Math.random().toString(36).slice(2);
  const authUrl = `${BASE}/oauth/authorize/?client_id=${encodeURIComponent(CID)}&response_type=code&redirect_uri=${encodeURIComponent(RED)}&scope=${encodeURIComponent(SCOPE)}&state=${encodeURIComponent(state)}`;
  if (req.query.dry === '1') {
    return res.json({ ok:true, authUrl, note:'Visita esta URL para autorizar la app en Bitrix24.' });
  }
  res.redirect(authUrl);
});

app.get('/auth/callback', async (req,res)=>{
  if (!assertEnv(res)) return;
  const { code, state } = req.query;
  if (!code) return res.status(400).json({ ok:false, error:'Falta ?code=' });

  // Intercambio de code por tokens
  const tokenUrl = `${BASE}/oauth/token/`;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CID,
    client_secret: SEC,
    redirect_uri: RED,
    code: code
  });

  try {
    const r = await fetch(tokenUrl, {
      method:'POST',
      headers:{ 'Content-Type':'application/x-www-form-urlencoded' },
      body
    });
    const data = await r.json();
    if (!r.ok || !data.access_token) {
      return res.status(500).json({ ok:false, error:'Token exchange falló', status:r.status, data });
    }
    const outDir = path.join(process.cwd(), 'data');
    fs.mkdirSync(outDir, { recursive:true });
    const outPath = path.join(outDir, 'b24_tokens.json');
    fs.writeFileSync(outPath, JSON.stringify({ obtained_at: Date.now(), ...data }, null, 2));
    res.json({ ok:true, saved: outPath, token_type: data.token_type || 'bearer', expires_in: data.expires_in || null });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
});

app.listen(PORT, ()=> {
  console.log(`[B24 OAuth] listening on :${PORT}`);
});
