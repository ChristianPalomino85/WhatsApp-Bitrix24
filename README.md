# WhatsApp Bitrix24 Connector

Este proyecto expone un API y un worker que coordinan campañas de WhatsApp Business con Bitrix24.

## Requisitos previos
- Node.js 18+
- Cuenta de WhatsApp Business Cloud con plantillas aprobadas
- Instancia de Bitrix24 con credenciales OAuth para una aplicación personalizada

## Configuración inicial
1. Copia `.env.example` a `.env` y rellena los valores marcados:
   - `WA_ACCESS_TOKEN`: token permanente de Meta para el número que vas a usar.
   - `WA_PHONE_NUMBER_ID`: identificador del número de WhatsApp Business que se tomará como predeterminado si no indicas otro al crear campañas.
   - `WA_APP_SECRET` y `WA_VERIFY_TOKEN`: para validar la firma del webhook y el *handshake* inicial.
   - `B24_*`: credenciales de tu aplicación Bitrix24 o las rutas para obtenerlas desde `tools/b24-auth`.
   - `DEFAULT_COUNTRY_CODE` o `BITRIX_DEFAULT_COUNTRY_CODE`: prefijos para normalizar números si Bitrix no los guarda en formato internacional.
2. Ejecuta `npm install`.
3. Inicia el servidor con `npm run dev` y el worker en otra terminal con `npm run worker`.
4. Publica el endpoint `/webhooks/wa` y configúralo en Meta Developers con los mismos tokens de verificación.

> ℹ️ Antes de lanzar campañas desde Bitrix24 ejecuta `node tools/b24-auth/server.cjs` (con tus variables `B24_*`) y completa el flujo OAuth; el archivo `data/b24_tokens.json` se usará automáticamente por el API y se refrescará cuando sea necesario.

## Integración con Bitrix24

1. **Crear un webhook/automatización** en Bitrix24 que invoque `POST https://<tu-servidor>/api/bitrix/campaigns` con el token configurado en `API_TOKEN` (cabecera `x-api-key`).
2. **Enviar los parámetros mínimos**:
   - `entity`: `lead`, `contact`, etc.
   - `ids`: lista de IDs de Bitrix24 (se acepta CSV, `ids[]=123`, o JSON).
   - `template_name`: nombre exacto de la plantilla aprobada en WhatsApp.
   - Opcionalmente `var_fields[miVariable]=CAMPO.B24` para mapear campos a variables del template.
   - Opcionalmente `sender_phone_id` si quieres usar un número distinto al configurado por defecto.
   - `auto_start=1` para encolar automáticamente la campaña.
3. **Revisar el estado** con `GET /api/campaigns/:id/status` o leyendo los comentarios automáticos en la línea de tiempo de Bitrix24.

Ejemplo con `curl` usando parámetros `application/x-www-form-urlencoded` (el mismo formato que envía Bitrix24):

```bash
curl -X POST "https://tu-servidor/api/bitrix/campaigns" \
  -H "x-api-key: $API_TOKEN" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "entity=lead" \
  -d "ids[]=123" \
  -d "ids[]=456" \
  -d "template_name=mi_template" \
  -d "sender_phone_id=857608144100041" \
  -d "var_fields[first_name]=NAME" \
  -d "var_fields[last_name]=LAST_NAME" \
  -d "auto_start=1"
```

Si prefieres enviar destinatarios directamente (sin buscarlos en Bitrix24) puedes mandar `targets` como JSON o texto plano:

```bash
curl -X POST "https://tu-servidor/api/campaigns" \
  -H "x-api-key: $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
        "name": "campaña manual",
        "template_name": "mi_template",
        "sender_phone_id": "857608144100041",
        "targets": ["5116193638", "5116193636"],
        "meta": { "nota": "lanzada desde Bitrix" }
      }'
```

## Uso con múltiples números
Puedes operar varios remitentes dentro del mismo despliegue siempre que el token de Meta tenga acceso a todos los números:
1. Conserva `WA_PHONE_NUMBER_ID` en `.env` como respaldo (se usará cuando no indiques otro).
2. Al crear campañas (desde Bitrix o de forma manual) envía `sender_phone_id` con el identificador del número deseado. Opcionalmente añade `sender_display` para personalizar el nombre mostrado en los registros locales.
3. El worker reutiliza automáticamente el remitente asignado a cada campaña, por lo que puedes mezclar envíos desde ambos números sin reiniciar servicios.

## Seguridad
- Nunca compartas ni subas a control de versiones tus tokens reales. Mantén `.env` y `data/b24_tokens.json` fuera del repositorio.
- Considera rotar el token permanente en Meta si se expuso públicamente.
- Protege los endpoints con `API_TOKEN` o una red privada.

## Después de hacer cambios
1. Ejecuta las pruebas relevantes (`npm run dev` para validar el arranque, `npm run worker` en una segunda terminal y pruebas unitarias cuando estén disponibles).
2. Revisa los logs para confirmar que el worker toma campañas y detecta errores de configuración antes de publicarlos.
3. Crea un commit descriptivo y abre un Pull Request resumiendo los cambios y las pruebas realizadas.
4. Una vez aprobado, despliega el API y el worker junto con la configuración `.env` que corresponda al número de WhatsApp que vayas a usar.

## Salud de la integración
- Usa `GET /api/bitrix/health` para verificar que el token de Bitrix está vigente.
- Revisa los registros del worker para confirmar que los envíos se procesan correctamente.

