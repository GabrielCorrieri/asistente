# 🚀 Guía de Deploy — Asistente de Vida Personal

## Qué vas a tener al final
- **Web app** en una URL propia (ej: `tu-asistente.railway.app`)
- **Bot de WhatsApp** que te manda briefings a las 7am, 12pm y 7pm
- **Trello** conectado leyendo tus tableros en tiempo real

---

## PASO 1 — Obtener las API Keys

### 1.1 Anthropic (para la IA)
1. Entrá a https://console.anthropic.com
2. Settings → API Keys → Create Key
3. Copiá la key (empieza con `sk-ant-`)

### 1.2 Twilio (para WhatsApp)
1. Creá cuenta gratis en https://www.twilio.com/try-twilio
2. En el dashboard, copiá:
   - **Account SID** (empieza con `AC`)
   - **Auth Token**
3. Activar WhatsApp Sandbox:
   - Messaging → Try it out → Send a WhatsApp message
   - Seguí las instrucciones para unirte al sandbox
   - El número de Twilio es `+14155238886`
4. Guardá el número de sandbox

### 1.3 Trello
1. Entrá a https://trello.com/app-key
2. Copiá la **API Key**
3. Hacé clic en "Token" → Autorizá → Copiá el token
4. El Board ID lo podés conseguir:
   - Abrí tu tablero en Trello
   - Agregá `.json` al final de la URL
   - Buscá el campo `"id"` al principio del JSON

---

## PASO 2 — Subir el código a GitHub

1. Creá cuenta en https://github.com si no tenés
2. Creá un repositorio nuevo llamado `vida-assistant`
3. Subí los archivos:
   ```
   vida-assistant/
   ├── public/index.html
   ├── server.js
   ├── package.json
   ├── .env.example
   └── README.md
   ```
4. **IMPORTANTE**: NO subas el archivo `.env` (tiene tus claves)

---

## PASO 3 — Deploy en Railway (recomendado)

Railway es el hosting más simple. Cuesta ~$5/mes y tiene $5 de crédito gratis.

1. Entrá a https://railway.app
2. "New Project" → "Deploy from GitHub repo"
3. Conectá tu cuenta de GitHub y seleccioná el repo
4. Railway detecta automáticamente que es Node.js
5. En el proyecto, ir a **Variables** y agregar:

```
ANTHROPIC_API_KEY=sk-ant-...
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_WHATSAPP_FROM=+14155238886
WHATSAPP_MY_NUMBER=+549XXXXXXXXXX   ← tu número con código de país
TRELLO_API_KEY=...
TRELLO_TOKEN=...
TRELLO_BOARD_ID=...
PORT=3000
```

6. Railway despliega automáticamente
7. En "Settings" → copiá tu URL pública (algo como `vida-assistant.railway.app`)

---

## PASO 4 — Configurar el webhook de Twilio

Para que Twilio sepa adónde mandar los mensajes de WhatsApp que te lleguen:

1. En Twilio Console → Messaging → Settings → WhatsApp sandbox settings
2. En "When a message comes in" pegá:
   ```
   https://TU-URL.railway.app/whatsapp
   ```
3. Método: **POST**
4. Guardá

---

## PASO 5 — Probar todo

1. **Web app**: Abrí `https://TU-URL.railway.app` en el browser
2. **Trello**: Ir a Ajustes → pegar API Key y Token → Guardar
3. **WhatsApp**: Mandar `briefing` al número de Twilio desde tu WhatsApp

### Primer uso recomendado:
1. Abrí la web app
2. Ir a **Contexto** → escribir tu situación de vida actual → Guardar
3. Ir a **Hoy** → Iniciar check-in → Responder las preguntas
4. Las prioridades ya quedan disponibles para el bot de WhatsApp

---

## PASO 6 — Pasar a producción en WhatsApp (opcional, más adelante)

Para tener tu propio número de WhatsApp (no el sandbox de Twilio):
1. Crear cuenta en Meta Business Suite
2. Solicitar acceso a WhatsApp Business API
3. Actualizar `TWILIO_WHATSAPP_FROM` con el nuevo número

---

## Horarios de briefing automático

El bot te manda mensajes automáticamente (hora Argentina):
- **7:00 AM** → Briefing matutino completo
- **12:00 PM** → Check-in mediodía + finanzas
- **7:00 PM** → Cierre del día (lunes a viernes)

Para cambiar los horarios, editar `server.js` líneas con `cron.schedule`.

---

## Comandos del bot de WhatsApp

| Comando | Respuesta |
|---------|-----------|
| `briefing` | Resumen del día + prioridades |
| `prioridades` | Tus top 3 del día |
| `finanzas` | Cobros, pagos y propuestas |
| `trello` | Tarjetas activas del tablero |
| `ayuda` | Lista de comandos |
| Cualquier texto | Chat libre con el asistente |

---

## ¿Algo no funciona?

- **Error de API Anthropic**: Verificá que la key en Railway sea correcta
- **WhatsApp no responde**: Revisá que el webhook en Twilio sea exactamente `https://TU-URL/whatsapp`
- **Trello no carga**: Asegurate de que el Token tenga permisos de lectura
- **Los horarios no funcionan**: Railway puede estar en UTC — los horarios en server.js están calculados para UTC-3 (Argentina)

---

## Soporte

Cualquier duda, compartí el error y te ayudo a resolverlo.
