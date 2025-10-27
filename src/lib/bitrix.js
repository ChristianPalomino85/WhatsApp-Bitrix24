import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { normalizePhone, isLikelyValidPhone } from './phone.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TOKENS_PATH = path.join(__dirname, '../../data/b24_tokens.json');
const DEFAULT_CHUNK = 50;
const CLOCK_SKEW_S = 60;

let cachedTokens = null;

function readTokensFile() {
  if (!fs.existsSync(TOKENS_PATH)) {
    throw new Error('No se encontró data/b24_tokens.json. Ejecuta tools/b24-auth primero.');
  }
  const raw = fs.readFileSync(TOKENS_PATH, 'utf-8');
  cachedTokens = JSON.parse(raw);
  return cachedTokens;
}

function getTokens() {
  if (cachedTokens) return cachedTokens;
  return readTokensFile();
}

function persistTokens(tokens) {
  cachedTokens = { ...tokens };
  fs.mkdirSync(path.dirname(TOKENS_PATH), { recursive: true });
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(cachedTokens, null, 2));
  return cachedTokens;
}

function getBaseUrl(tokens) {
  const envBase = process.env.B24_BASE_URL;
  const tokenBase = tokens?.server_endpoint;
  const base = (envBase || tokenBase || '').replace(/\/+$/, '');
  if (!base) {
    throw new Error('No se puede determinar B24_BASE_URL ni server_endpoint desde tokens.');
  }
  return base;
}

function getRestEndpoint(tokens) {
  const endpoint = (tokens?.client_endpoint || '').replace(/\/+$/, '');
  if (!endpoint) {
    throw new Error('El token de Bitrix24 no incluye client_endpoint.');
  }
  return endpoint;
}

function tokenExpTs(tokens) {
  const obtainedAt = Number(tokens?.obtained_at || 0);
  const expiresIn = Number(tokens?.expires_in || 0) * 1000;
  if (!obtainedAt || !expiresIn) return 0;
  return obtainedAt + expiresIn;
}

function tokenNeedsRefresh(tokens) {
  const expiresTs = tokenExpTs(tokens);
  if (!expiresTs) return false;
  return Date.now() >= (expiresTs - CLOCK_SKEW_S * 1000);
}

function ensureClientCreds(tokens) {
  const clientId = process.env.B24_CLIENT_ID || tokens?.client_id;
  const clientSecret = process.env.B24_CLIENT_SECRET || tokens?.client_secret;
  if (!clientId || !clientSecret) {
    throw new Error('Faltan B24_CLIENT_ID y/o B24_CLIENT_SECRET para refrescar el token.');
  }
  return { clientId, clientSecret };
}

async function refreshToken(tokens) {
  if (!tokens?.refresh_token) {
    throw new Error('El token de Bitrix24 no incluye refresh_token.');
  }
  const { clientId, clientSecret } = ensureClientCreds(tokens);
  const base = getBaseUrl(tokens);
  const url = `${base}/oauth/token/`;
  const payload = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: tokens.refresh_token
  });

  const response = await axios.post(url, payload.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  if (!response.data?.access_token) {
    throw new Error('Bitrix24 no devolvió access_token al refrescar.');
  }

  const updated = {
    ...tokens,
    ...response.data,
    obtained_at: Date.now()
  };
  return persistTokens(updated);
}

function isTokenError(err) {
  const data = err?.response?.data;
  const code = data?.error || data?.error_description;
  if (!code) return false;
  return /expired|invalid/i.test(String(code));
}

async function requestWithToken(tokens, method, params) {
  const endpoint = getRestEndpoint(tokens);
  const token = tokens.access_token;
  if (!token) throw new Error('El token de Bitrix24 no incluye access_token.');

  const url = `${endpoint}/${method}?auth=${encodeURIComponent(token)}`;
  const response = await axios.post(url, params, {
    headers: { 'Content-Type': 'application/json' }
  });

  if (response.data?.error) {
    const { error, error_description } = response.data;
    const msg = `${error}: ${error_description || 'sin descripción'}`;
    const err = new Error(`Bitrix24 respondió error: ${msg}`);
    err.response = response;
    throw err;
  }

  return response.data;
}

export async function ensureAccessToken() {
  let tokens = getTokens();
  if (tokenNeedsRefresh(tokens)) {
    tokens = await refreshToken(tokens);
  }
  return { accessToken: tokens.access_token, tokens };
}

export async function callBitrix(method, params = {}) {
  let tokens = getTokens();
  if (tokenNeedsRefresh(tokens)) {
    tokens = await refreshToken(tokens);
  }

  try {
    return await requestWithToken(tokens, method, params);
  } catch (err) {
    if (isTokenError(err)) {
      tokens = await refreshToken(tokens);
      return await requestWithToken(tokens, method, params);
    }
    throw err;
  }
}

const ENTITY_METHODS = {
  lead: 'crm.lead.list',
  contact: 'crm.contact.list'
};

export async function fetchEntities({ entity = 'lead', ids = [] }) {
  const method = ENTITY_METHODS[entity];
  if (!method) {
    throw new Error(`Entidad Bitrix24 no soportada: ${entity}`);
  }
  const uniqueIds = Array.from(new Set((ids || []).map(String).filter(Boolean)));
  if (!uniqueIds.length) return [];

  const out = [];
  for (let i = 0; i < uniqueIds.length; i += DEFAULT_CHUNK) {
    const chunk = uniqueIds.slice(i, i + DEFAULT_CHUNK);
    const payload = {
      filter: { ID: chunk },
      select: ['ID', 'TITLE', 'NAME', 'LAST_NAME', 'SECOND_NAME', 'PHONE', 'COMPANY_TITLE', 'ASSIGNED_BY_ID', 'UF_*']
    };
    const data = await callBitrix(method, payload);
    if (Array.isArray(data?.result)) {
      out.push(...data.result);
    }
  }
  return out;
}

function resolveFieldValue(obj, path) {
  if (!path) return undefined;
  const segments = String(path).split('.');
  let current = obj;
  for (const seg of segments) {
    if (current == null) return undefined;
    const match = seg.match(/^([^\[]+)(?:\[(\d+)\])?$/);
    if (!match) return undefined;
    const key = match[1];
    const index = match[2] !== undefined ? Number(match[2]) : null;
    current = current?.[key];
    if (index != null) {
      if (!Array.isArray(current)) return undefined;
      current = current[index];
    }
  }
  return current;
}

function extractPhoneFromEntity(entity, defaultCountryCode) {
  const list = Array.isArray(entity?.PHONE) ? entity.PHONE : [];
  for (const item of list) {
    if (!item) continue;
    const phone = item.VALUE || item.value;
    const normalized = normalizePhone(phone, { defaultCountryCode });
    if (normalized) return normalized;
  }
  const fallback = entity?.PHONE || entity?.phone || '';
  return normalizePhone(fallback, { defaultCountryCode });
}

export async function fetchTargetsFromBitrix({ entity = 'lead', ids = [], varFields = {} }) {
  const defaultCountryCode = (process.env.BITRIX_DEFAULT_COUNTRY_CODE || '').replace(/\D/g, '');
  const rows = await fetchEntities({ entity, ids });
  const targets = [];
  for (const row of rows) {
    const phone = extractPhoneFromEntity(row, defaultCountryCode);
    if (!isLikelyValidPhone(phone)) continue;

    const vars = {};
    for (const [varName, fieldPath] of Object.entries(varFields || {})) {
      const val = resolveFieldValue(row, fieldPath);
      if (val !== undefined && val !== null && String(varName || '').trim()) {
        vars[varName] = val;
      }
    }

    vars._bitrix = { entity, id: row.ID };
    targets.push({ phone, vars });
  }
  return targets;
}

export async function bitrixHealth() {
  const { accessToken, tokens } = await ensureAccessToken();
  const profile = await callBitrix('profile', {});
  return {
    hasToken: Boolean(accessToken),
    expires_at: tokenExpTs(tokens) || null,
    profile: profile?.result || null
  };
}

export async function pushTimelineComment({ entity, entityId, comment }) {
  if (!entity || !entityId || !comment) return null;
  const fields = {
    ENTITY_ID: Number(entityId),
    ENTITY_TYPE: entity,
    COMMENT: comment
  };
  return callBitrix('crm.timeline.comment.add', { fields });
}

