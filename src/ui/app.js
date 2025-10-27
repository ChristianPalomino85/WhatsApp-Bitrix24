const API = location.origin;
function val(id){ return document.getElementById(id).value.trim(); }
function out(id, text){ document.getElementById(id).textContent = typeof text==='string'? text : JSON.stringify(text, null, 2); }
async function post(path, body){ const r = await fetch(API+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})}); return r.json(); }
async function get(path){ const r = await fetch(API+path); return r.json(); }
document.getElementById('create').onclick = async ()=>{ try{ const name=val('name'); const template_name=val('template'); const language=val('lang')||'es'; const targets=JSON.parse(val('targets')||'[]'); const resp=await post('/api/campaigns',{name,template_name,language,targets}); out('createOut', resp); if(resp.campaign_id) document.getElementById('cid').value=resp.campaign_id; }catch(e){ out('createOut', String(e)); } };
document.getElementById('dryrun').onclick = async ()=>{ const id = val('cid'); const resp = await post(`/api/campaigns/${id}/dry-run`); out('dryOut', resp); };
document.getElementById('start').onclick = async ()=>{ const id = val('cid'); const resp = await post(`/api/campaigns/${id}/start`); out('dryOut', resp); };
document.getElementById('status').onclick = async ()=>{ const id = val('cid2'); const resp = await get(`/api/campaigns/${id}/status`); out('statusOut', resp); };
