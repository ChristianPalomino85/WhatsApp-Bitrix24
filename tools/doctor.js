import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';
import db from '../src/lib/db.js';
import { bitrixHealth } from '../src/lib/bitrix.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

const results = [];

function addResult(status, message, fix = null) {
  results.push({ status, message, fix });
  const prefix = status === 'ok' ? '✅' : status === 'warn' ? '⚠️' : '❌';
  console.log(`${prefix} ${message}`);
  if (fix) {
    console.log(`   Sugerencia: ${fix}`);
  }
}

function requireEnv(name, description, { validator = null, fix = null } = {}) {
  const value = process.env[name];
  if (!value) {
    addResult('fail', `[${name}] ${description} (no establecido)`, fix || `Añade ${name}=... en tu archivo .env`);
    return null;
  }
  if (validator && !validator(value)) {
    addResult('fail', `[${name}] ${description} (valor inválido: ${value})`, fix || `Revisa el valor de ${name} en tu archivo .env`);
    return null;
  }
  addResult('ok', `[${name}] ${description}`);
  return value;
}

function optionalEnv(name, description, { fix = null } = {}) {
  const value = process.env[name];
  if (!value) {
    addResult('warn', `[${name}] ${description} (sin definir)`, fix || `Añade ${name}=... en tu archivo .env si quieres habilitarlo`);
    return null;
  }
  addResult('ok', `[${name}] ${description}`);
  return value;
}

function hasDigits(value) {
  return /^\d+$/.test(String(value || ''));
}

async function checkWhatsApp(token, phoneId) {
  try {
    const url = `https://graph.facebook.com/v21.0/${phoneId}`;
    const response = await axios.get(url, {
      params: { fields: 'display_phone_number,verified_name' },
      headers: { Authorization: `Bearer ${token}` }
    });
    const info = response.data || {};
    const display = info.display_phone_number || info.verified_name || phoneId;
    addResult('ok', `WhatsApp Business API responde para ${display}`);
  } catch (err) {
    const message = err?.response?.data?.error?.message || err?.message || 'error desconocido';
    addResult('fail', 'No se pudo validar la conexión con WhatsApp Business API', `Verifica el token y el número configurado. Error: ${message}`);
  }
}

function checkDatabase() {
  try {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='campaigns'").get();
    if (row) {
      addResult('ok', 'Base de datos SQLite inicializada en data/wsp_campaigns.db');
    } else {
      addResult('fail', 'La base de datos no tiene la tabla campaigns', 'Verifica src/schema.sql e inicia el servidor una vez para aplicar el esquema.');
    }
  } catch (err) {
    addResult('fail', 'No se pudo acceder a la base de datos local', err.message);
  }
}

function checkCountryCode() {
  const manual = process.env.DEFAULT_COUNTRY_CODE;
  const bitrix = process.env.BITRIX_DEFAULT_COUNTRY_CODE;
  if (!manual && !bitrix) {
    addResult('warn', 'No se definió DEFAULT_COUNTRY_CODE ni BITRIX_DEFAULT_COUNTRY_CODE', 'Define alguno para normalizar teléfonos sin prefijo.');
  } else {
    addResult('ok', 'Configuración de prefijo telefónico presente');
  }
}

async function checkBitrix(tokensPath) {
  if (!fs.existsSync(tokensPath)) {
    addResult('fail', 'No existe data/b24_tokens.json con credenciales de Bitrix24', 'Ejecuta node tools/b24-auth/server.cjs y completa el flujo OAuth.');
    return;
  }
  try {
    const raw = fs.readFileSync(tokensPath, 'utf-8');
    const tokens = JSON.parse(raw);
    if (!tokens?.access_token) {
      addResult('fail', 'El archivo data/b24_tokens.json no contiene access_token', 'Repite la autenticación en tools/b24-auth.');
      return;
    }
    addResult('ok', 'Se encontró data/b24_tokens.json con credenciales');
  } catch (err) {
    addResult('fail', 'No se pudo leer data/b24_tokens.json', err.message);
    return;
  }

  try {
    const info = await bitrixHealth();
    const profile = info?.profile || {};
    const formattedName = profile.NAME_FORMATTED || profile.FORMATTED_NAME;
    const joinedName = [profile.NAME, profile.LAST_NAME].filter(Boolean).join(' ').trim();
    const name = formattedName || (joinedName || null);
    const expires = info?.expires_at ? new Date(info.expires_at).toISOString() : null;
    let message = 'Bitrix24 responde correctamente';
    if (name) {
      message += ` (usuario: ${name})`;
    }
    if (expires) {
      message += `, token válido hasta ${expires}`;
    }
    addResult('ok', message);
    if (!info?.hasToken) {
      addResult('warn', 'No se detectó access_token activo para Bitrix24', 'Revisa que data/b24_tokens.json tenga access_token y refresh_token vigentes.');
    }
  } catch (err) {
    const message = err?.response?.data?.error_description || err?.message || 'error desconocido';
    addResult('fail', 'No se pudo validar el token de Bitrix24', `Renueva las credenciales con tools/b24-auth. Detalle: ${message}`);
  }
}

async function main() {
  const waToken = requireEnv('WA_ACCESS_TOKEN', 'Token de acceso de WhatsApp Business');
  const waPhoneId = requireEnv('WA_PHONE_NUMBER_ID', 'Identificador del número de WhatsApp Business', {
    validator: hasDigits,
    fix: 'Copia el "Identificador de número de teléfono" desde el panel de Meta.'
  });

  optionalEnv('WA_APP_SECRET', 'Se usará para validar la firma del webhook', {
    fix: 'Añade la clave secreta de tu app de Meta como WA_APP_SECRET en .env.'
  });
  optionalEnv('WA_VERIFY_TOKEN', 'Necesario para completar el handshake del webhook', {
    fix: 'Define una cadena y regístrala en Meta Developers como token de verificación.'
  });
  optionalEnv('API_TOKEN', 'Protege los endpoints del API con x-api-key');

  checkCountryCode();
  checkDatabase();

  if (waToken && waPhoneId) {
    await checkWhatsApp(waToken, waPhoneId);
  }

  const tokensPath = path.join(rootDir, 'data', 'b24_tokens.json');
  await checkBitrix(tokensPath);

  if (typeof db.close === 'function') {
    db.close();
  }

  const totals = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});

  console.log('\nResumen:');
  console.log(`  ✅ ${totals.ok || 0} correctos`);
  console.log(`  ⚠️ ${totals.warn || 0} advertencias`);
  console.log(`  ❌ ${totals.fail || 0} pendientes`);

  if (totals.fail > 0) {
    console.log('\nCorrige los elementos marcados como ❌ antes de lanzar campañas.');
    process.exitCode = 1;
  } else if ((totals.warn || 0) > 0) {
    console.log('\nRevisa las advertencias ⚠️ para completar la configuración.');
  } else {
    console.log('\nTodo listo para usar el conector con Bitrix24.');
  }
}

main();
