require('dotenv').config();
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const cron    = require('node-cron');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });


// ── Google Calendar ───────────────────────────────────────────────
const { google } = require('googleapis');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

const SCOPES = ['https://www.googleapis.com/auth/calendar'];
const REDIRECT_URI = `${process.env.BASE_URL || 'https://asistentepersonal.up.railway.app'}/auth/google/callback`;

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);

// Store tokens in DB
async function saveTokens(tokens) {
  const data = await loadData();
  data.googleTokens = tokens;
  await saveData(data);
}
async function getTokens() {
  const data = await loadData();
  return data.googleTokens || null;
}
async function getCalendarClient() {
  const tokens = await getTokens();
  if (!tokens) return null;
  oauth2Client.setCredentials(tokens);
  if (tokens.expiry_date && tokens.expiry_date < Date.now()) {
    try {
      const { credentials } = await oauth2Client.refreshAccessToken();
      await saveTokens(credentials);
      oauth2Client.setCredentials(credentials);
    } catch(e) { return null; }
  }
  return google.calendar({ version: 'v3', auth: oauth2Client });
}

app.use(session({ secret: process.env.SESSION_SECRET || 'gus-secret-2026', resave: false, saveUninitialized: false }));

// ── Auth routes ───────────────────────────────────────────────────
app.get('/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { tokens } = await oauth2Client.getToken(req.query.code);
    await saveTokens(tokens);
    res.send('<html><body style="font-family:sans-serif;text-align:center;padding:3rem"><h2>✅ Google Calendar conectado</h2><p>Ya podés cerrar esta ventana y usar GUS.</p></body></html>');
  } catch(e) {
    res.send('<html><body style="font-family:sans-serif;text-align:center;padding:3rem"><h2>❌ Error</h2><p>' + e.message + '</p></body></html>');
  }
});

app.get('/auth/status', async (req, res) => {
  const tokens = await getTokens();
  res.json({ connected: !!tokens });
});

// ── PostgreSQL setup ──────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gus_data (
      id TEXT PRIMARY KEY DEFAULT 'main',
      data JSONB NOT NULL DEFAULT '{}'
    )
  `);
  // Insert default row if not exists
  await pool.query(`
    INSERT INTO gus_data (id, data) VALUES ('main', '{}')
    ON CONFLICT (id) DO NOTHING
  `);
  console.log('✅ PostgreSQL conectado');
}
initDB().catch(e => console.error('DB init error:', e.message));

// ── Data helpers ──────────────────────────────────────────────────
async function loadData() {
  try {
    const res = await pool.query("SELECT data FROM gus_data WHERE id='main'");
    return res.rows[0]?.data || {};
  } catch(e) {
    console.error('loadData error:', e.message);
    return {};
  }
}
async function saveData(d) {
  try {
    await pool.query(
      "INSERT INTO gus_data (id, data) VALUES ('main', $1) ON CONFLICT (id) DO UPDATE SET data=$1",
      [JSON.stringify(d)]
    );
  } catch(e) { console.error('saveData error:', e.message); }
}

// ── REST API ──────────────────────────────────────────────────────
app.get('/api/data',  async (_, res) => res.json(await loadData()));
app.post('/api/data', async (req, res) => { await saveData(req.body); res.json({ ok: true }); });

// Anthropic proxy — full agent context for web chat
app.post('/api/ai', async (req, res) => {
  try {
    const { prompt, context, contextVida, priorities, prioritiesVida } = req.body;
    const data = await loadData();
    
    const systemPrompt = `Sos GUS, el asistente personal e inteligente de Gabriel. Respondés desde la web app de forma clara y útil.

CONTEXTO LABORAL:
${context || data.context || 'Sin contexto cargado.'}

CONTEXTO PERSONAL:
${contextVida || data.contextVida || 'Sin contexto de vida.'}

PRIORIDADES LABORALES HOY:
${(priorities || data.prioritiesLab || []).join('\n') || 'Sin check-in de hoy'}

PRIORIDADES DE VIDA HOY:
${(prioritiesVida || data.prioritiesVida || []).join('\n') || 'Sin check-in de vida'}

Respondé en español rioplatense. Máximo 200 palabras. Claro y directo.`;

    const msg = await ai.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 600,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }]
    });
    res.json({ text: msg.content[0]?.text || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Trello proxy
app.get('/api/trello/boards', async (req, res) => {
  const { key, token } = req.query;
  try {
    const r = await fetch(`https://api.trello.com/1/members/me/boards?key=${key}&token=${token}&filter=open&fields=name,id,url,desc`);
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/trello/cards', async (req, res) => {
  const { key, token, boardId } = req.query;
  try {
    const [cardsR, listsR] = await Promise.all([
      fetch(`https://api.trello.com/1/boards/${boardId}/cards?key=${key}&token=${token}&fields=name,idList,due,dueComplete,url,desc,labels`),
      fetch(`https://api.trello.com/1/boards/${boardId}/lists?key=${key}&token=${token}&fields=name,id`)
    ]);
    const [cards, lists] = await Promise.all([cardsR.json(), listsR.json()]);
    res.json({ cards, lists });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Multi-board summary (daily boards)
app.get('/api/trello/daily-summary', async (req, res) => {
  const { key, token, boardIds } = req.query;
  if (!key || !token || !boardIds) return res.json({ boards: [] });
  const ids = boardIds.split(',').filter(Boolean);
  try {
    const results = await Promise.all(ids.map(async (bid) => {
      const [br, cr, lr] = await Promise.all([
        fetch(`https://api.trello.com/1/boards/${bid}?key=${key}&token=${token}&fields=name,id`),
        fetch(`https://api.trello.com/1/boards/${bid}/cards?key=${key}&token=${token}&fields=name,idList,due,dueComplete,labels`),
        fetch(`https://api.trello.com/1/boards/${bid}/lists?key=${key}&token=${token}&fields=name,id`)
      ]);
      const [board, cards, lists] = await Promise.all([br.json(), cr.json(), lr.json()]);
      const today = new Date(); today.setHours(23,59,59,999);
      const overdue = cards.filter(c => !c.dueComplete && c.due && new Date(c.due) < new Date());
      const dueToday = cards.filter(c => !c.dueComplete && c.due && new Date(c.due) <= today && new Date(c.due) >= new Date(new Date().setHours(0,0,0,0)));
      const active = cards.filter(c => !c.dueComplete);
      return { board, cards, lists, summary: { overdue: overdue.length, dueToday: dueToday.length, active: active.length, overdueCards: overdue, dueTodayCards: dueToday } };
    }));
    res.json({ boards: results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ── WhatsApp Agent ────────────────────────────────────────────────
app.post('/whatsapp', async (req, res) => {
  const data = await loadData();
  let message = req.body.Body?.trim() || '';
  let reply   = '';

  // Log incoming for debugging
  console.log('WA incoming - NumMedia:', req.body.NumMedia, 'ContentType:', req.body.MediaContentType0, 'Body:', message?.slice(0,50));

  // Handle voice/audio messages
  const numMedia = parseInt(req.body.NumMedia || '0');
  const contentType = req.body.MediaContentType0 || '';
  if (numMedia > 0 && (contentType.includes('audio') || contentType.includes('ogg') || contentType.includes('mpeg'))) {
    try {
      const audioUrl = req.body.MediaUrl0;
      const sid  = process.env.TWILIO_ACCOUNT_SID;
      const auth = process.env.TWILIO_AUTH_TOKEN;

      // Download audio
      const audioRes = await fetch(audioUrl, {
        headers: { 'Authorization': 'Basic ' + Buffer.from(`${sid}:${auth}`).toString('base64') }
      });
      const audioBuffer = await audioRes.arrayBuffer();

      if (process.env.OPENAI_API_KEY) {
        // Transcribe with Whisper using form-data package
        console.log('Sending to Whisper, buffer size:', audioBuffer.byteLength);
        const FormData = require('form-data');
        const form = new FormData();
        form.append('file', Buffer.from(audioBuffer), { filename: 'audio.ogg', contentType: 'audio/ogg' });
        form.append('model', 'whisper-1');
        form.append('language', 'es');
        const wRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, ...form.getHeaders() },
          body: form
        });
        const wData = await wRes.json();
        console.log('Whisper result:', JSON.stringify(wData).slice(0,150));
        message = wData.text || '';
        if (message) {
          reply = await agentReply(`[Audio transcripto - respondé naturalmente sin mencionar que es audio]: ${message}`, data);
        } else {
          reply = '⚠️ No pude entender el audio. ¿Podés escribirme?';
        }
      } else {
        reply = '⚠️ Para audios necesito la clave de OpenAI. Agregá OPENAI_API_KEY en Railway.';
      }
    } catch(e) {
      console.error('Audio error:', e.message);
      reply = '⚠️ Error procesando el audio. Escribime el mensaje.';
    }
  } else {
    reply = await agentReply(message || '(mensaje vacío)', data);
  }

  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(reply)}</Message></Response>`);
});


// ── AGENT CORE ────────────────────────────────────────────────────
async function agentReply(message, data) {
  const msg = message.toLowerCase();

  // Detect calendar reschedule intent
  const rescheduleKeywords = ['reprogramá','reprogramame','mové','mové','cambiá','cambiar hora','cambiar fecha','pasá para','postergar','adelantar'];
  const isRescheduleIntent = rescheduleKeywords.some(k => msg.includes(k));
  if (isRescheduleIntent) {
    // Get today's events to find the one to reschedule
    const events = await getEventsToday();
    const weekEvents = await getEventsWeek();
    const allEvents = [...events, ...weekEvents];
    if (!allEvents.length) return '📅 No encontré eventos para reprogramar. ¿Podés ser más específico sobre cuál evento?';
    
    // Use AI to identify which event and new time
    const evList = allEvents.map((e,i)=>`${i+1}. ${e.summary} - ${new Date(e.start?.dateTime||e.start?.date).toLocaleString('es-AR',{timeZone:'America/Argentina/Buenos_Aires'})}`).join('\n');
    const reschedulePrompt = `El usuario quiere reprogramar un evento: "${message}"
    
Eventos disponibles:
${evList}

Fecha/hora actual en Argentina: ${arNow.toLocaleString('es-AR',{timeZone:'America/Argentina/Buenos_Aires'})}

Identificá cuál evento reprogramar y la nueva hora. SOLO JSON:
{"eventIndex": 0, "newStartDateTime": "${todayISO}T11:00:00-03:00", "newEndDateTime": "${todayISO}T12:00:00-03:00"}
Si no podés identificar, poné eventIndex: -1`;

    try {
      const rr = await ai.messages.create({ model:'claude-sonnet-4-5', max_tokens:200, messages:[{role:'user',content:reschedulePrompt}] });
      const rData = JSON.parse(rr.content[0].text.replace(/\`\`\`json|\`\`\`/g,'').trim());
      if (rData.eventIndex >= 0 && allEvents[rData.eventIndex]) {
        const ev = allEvents[rData.eventIndex];
        const cal = await getCalendarClient();
        if (cal) {
          await cal.events.patch({
            calendarId: 'primary',
            eventId: ev.id,
            resource: {
              start: { dateTime: rData.newStartDateTime, timeZone: 'America/Argentina/Buenos_Aires' },
              end:   { dateTime: rData.newEndDateTime,   timeZone: 'America/Argentina/Buenos_Aires' }
            }
          });
          const newTime = new Date(rData.newStartDateTime).toLocaleString('es-AR',{weekday:'long',day:'numeric',month:'long',hour:'2-digit',minute:'2-digit',timeZone:'America/Argentina/Buenos_Aires'});
          return `✅ *Reprogramado:* ${ev.summary}\n📅 ${newTime}`;
        }
      }
    } catch(e) { console.error('Reschedule error:', e.message); }
    return '⚠️ No pude identificar el evento. ¿Podés decirme el nombre exacto y la nueva hora?';
  }

  // Detect calendar create intent
  const createKeywords = ['agendá','agenda','anotá','agendame','creá','crear reunión','nueva reunión','agendame','recordame','agendá','schedulea','añadí','añadime'];
  const isCreateIntent = createKeywords.some(k => msg.includes(k));
  if (isCreateIntent) {
    const event = await parseAndCreateEvent(message, data);
    if (event) {
      const start = event.start?.dateTime || event.start?.date;
      const time = start ? new Date(start).toLocaleString('es-AR',{weekday:'long',day:'numeric',month:'long',hour:'2-digit',minute:'2-digit',timeZone:'America/Argentina/Buenos_Aires'}) : '';
      let reply = `✅ *Evento creado:* ${event.summary}\n📅 ${time}`;
      if (event.location) reply += `\n📍 ${event.location}`;
      if (event.hangoutLink) reply += `\n📹 Meet: ${event.hangoutLink}`;
      return reply;
    } else {
      return '⚠️ No pude interpretar la fecha/hora. Probá con algo más específico, ej: "Agendame reunión con Martín el jueves a las 15hs"';
    }
  }

  // Detect free slots intent
  const freeKeywords = ['espacio libre','tiempo libre','cuándo puedo','cuándo tengo','hueco','disponible','cuando tengo'];
  const isFreeIntent = freeKeywords.some(k => msg.includes(k));
  if (isFreeIntent) {
    const slots = await getFreeSlots();
    if (!slots.length) return '📅 No tenés espacios libres hoy. Agenda llena.';
    return '🕐 *Espacios libres hoy:*\n' + slots.map(s=>`• ${s.start} - ${s.end} (${s.mins >= 60 ? Math.floor(s.mins/60)+'hs' : s.mins+'min'})`).join('\n');
  }

  // Detect delete intent
  const deleteKeywords = ['borrá','eliminá','cancelá','borra','elimina','cancela'];
  const isDeleteIntent = deleteKeywords.some(k => msg.includes(k)) && (msg.includes('evento') || msg.includes('reunión') || msg.includes('cita'));
  if (isDeleteIntent) {
    const events = [...await getEventsToday(), ...await getEventsWeek()];
    if (!events.length) return '📅 No encontré eventos para eliminar.';
    const evList = events.slice(0,8).map((e,i)=>`${i+1}. ${e.summary} - ${new Date(e.start?.dateTime||e.start?.date).toLocaleString('es-AR',{timeZone:'America/Argentina/Buenos_Aires',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}`).join('\n');
    const delPrompt = `El usuario quiere eliminar un evento: "${message}"\nEventos: ${evList}\nSOLO JSON: {"eventIndex": 0} o {"eventIndex": -1} si no encontrás`;
    try {
      const dr = await ai.messages.create({model:'claude-sonnet-4-5',max_tokens:100,messages:[{role:'user',content:delPrompt}]});
      const dData = JSON.parse(dr.content[0].text.replace(/\`\`\`json|\`\`\`/g,'').trim());
      if (dData.eventIndex >= 0 && events[dData.eventIndex]) {
        const ev = events[dData.eventIndex];
        const cal = await getCalendarClient();
        if (cal) {
          await cal.events.delete({ calendarId: 'primary', eventId: ev.id });
          return `🗑 *Evento eliminado:* ${ev.summary}`;
        }
      }
    } catch(e) {}
    return '⚠️ No pude identificar qué evento eliminar. ¿Podés ser más específico?';
  }

  // Detect calendar read intent
  const readKeywords = ['agenda','calendario','eventos','reuniones','qué tengo','tengo hoy','tengo mañana','semana','mis eventos'];
  const isReadIntent = readKeywords.some(k => msg.includes(k)) && !isCreateIntent && !isRescheduleIntent;
  if (isReadIntent) {
    const events = msg.includes('semana') ? await getEventsWeek() : await getEventsToday();
    if (!events.length) return '📅 No tenés eventos ' + (msg.includes('semana') ? 'esta semana' : 'hoy') + '.';
    const title = msg.includes('semana') ? '📅 *Tu semana:*' : '📅 *Agenda de hoy:*';
    return title + '\n' + events.map(e => fmtEvent(e) + (e.calendarName && e.calendarName !== 'primary' ? ` _(${e.calendarName})_` : '')).join('\n');
  }


  const key   = process.env.TRELLO_API_KEY;
  const token = process.env.TRELLO_TOKEN;
  const cfg   = JSON.parse(data.trelloCfg || '{}');
  const dailyIds = cfg.dailyBoards || [];

  // Build Trello context
  let trelloCtx = '';
  if (key && token && dailyIds.length) {
    try {
      const boards = await Promise.all(dailyIds.slice(0,4).map(async id => {
        const [cr, lr] = await Promise.all([
          fetch(`https://api.trello.com/1/boards/${id}/cards?key=${key}&token=${token}&fields=name,idList,due,dueComplete`),
          fetch(`https://api.trello.com/1/boards/${id}/lists?key=${key}&token=${token}&fields=name,id`)
        ]);
        const [cards, lists] = await Promise.all([cr.json(), lr.json()]);
        const br = await fetch(`https://api.trello.com/1/boards/${id}?key=${key}&token=${token}&fields=name`);
        const board = await br.json();
        const byList = {};
        lists.forEach(l => byList[l.id] = { name: l.name, cards: [] });
        cards.filter(c => !c.dueComplete).forEach(c => { if(byList[c.idList]) byList[c.idList].cards.push(c.name); });
        return `Tablero "${board.name}": ` + Object.values(byList).filter(l=>l.cards.length).map(l=>`${l.name}: ${l.cards.slice(0,5).join(', ')}`).join(' | ');
      }));
      trelloCtx = boards.join('\n');
    } catch(e) { trelloCtx = 'Error leyendo Trello'; }
  }

  // Build finance alerts
  const oc = (data.finanzas?.cobros||[]).filter(c=>c.status==='pending'&&c.dueDate&&new Date(c.dueDate)<new Date());
  const op = (data.finanzas?.propuestas||[]).filter(p=>p.status==='enviada');
  const up = (data.finanzas?.pagos||[]).filter(p=>p.status==='pending'&&p.dueDate&&new Date(p.dueDate)<=new Date(Date.now()+7*864e5));
  const finCtx = [
    oc.length ? `Cobros vencidos: ${oc.map(c=>`${c.client} $${c.amount}`).join(', ')}` : '',
    op.length ? `Propuestas sin respuesta: ${op.map(p=>`${p.client} - ${p.service}`).join(', ')}` : '',
    up.length ? `Pagos próximos (7 días): ${up.map(p=>`${p.vendor} $${p.amount} (${p.dueDate})`).join(', ')}` : '',
  ].filter(Boolean).join('\n') || 'Sin alertas financieras';

  // Build priorities
  const labPrio = (data.prioritiesLab||[]).map((p,i)=>`${i+1}. ${p}`).join('\n') || 'Sin check-in laboral de hoy';
  const vidaPrio = (data.prioritiesVida||[]).map((p,i)=>`${i+1}. ${p}`).join('\n') || 'Sin check-in de vida de hoy';

  // Pending tasks summary
  const labTareas = (data.lab?.tareas||[]).filter(t=>!t.done).map(t=>t.text).slice(0,8).join(', ') || 'ninguna';
  const labProy   = (data.lab?.proyectos||[]).filter(t=>!t.done).map(t=>t.text).slice(0,5).join(', ') || 'ninguno';

  const now = new Date();
  const hora = now.toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'});
  const fecha = now.toLocaleDateString('es-AR',{weekday:'long',day:'numeric',month:'long'});

  const systemPrompt = `Sos GUS, el asistente personal e inteligente de ${data.context ? 'Gabriel' : 'un emprendedor argentino'}. Respondés por WhatsApp de forma natural, concisa y útil. Usás emojis con moderación y formato *negrita* de WhatsApp cuando suma claridad.

CONTEXTO COMPLETO DEL USUARIO:
${data.context || 'Sin contexto cargado aún.'}

CONTEXTO DE VIDA PERSONAL:
${data.contextVida || 'Sin contexto de vida cargado.'}

ESTADO ACTUAL (${fecha}, ${hora}):
Prioridades laborales de hoy:
${labPrio}

Prioridades de vida de hoy:
${vidaPrio}

Tareas laborales pendientes: ${labTareas}
Proyectos activos: ${labProy}

FINANZAS:
${finCtx}

TRELLO (tableros diarios):
${trelloCtx || 'Sin tableros diarios configurados'}

INSTRUCCIONES:
- Respondés en español rioplatense (vos, che, etc.)
- Máximo 300 palabras por respuesta
- Si te piden un briefing o resumen del día, incluí prioridades + alertas financieras + Trello
- Si te preguntan por finanzas, dás el detalle de cobros/pagos/propuestas
- Si te preguntan por Trello o un proyecto, usás la info disponible
- Si te dan una instrucción ("anotá esto", "recordame"), confirmás que lo deben agregar desde la app web
- Si es una pregunta general de vida/coaching, respondés con el contexto personal que tenés
- Nunca inventés datos que no tenés
- Si algo requiere acción en la app, lo indicás claramente`;

  try {
    const r = await ai.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 600,
      system: systemPrompt,
      messages: [{ role: 'user', content: message }]
    });
    return r.content[0]?.text || '⚠️ Error procesando tu mensaje.';
  } catch(e) {
    console.error('Agent error:', e.message);
    return '⚠️ Error de conexión. Intentá de nuevo en un momento.';
  }
}

// ── AI helpers ────────────────────────────────────────────────────
async function buildBriefing(data, period) {
  const oc = (data.finanzas?.cobros||[]).filter(c=>c.status==='pending'&&c.dueDate&&new Date(c.dueDate)<new Date());
  const op = (data.finanzas?.propuestas||[]).filter(p=>p.status==='enviada');
  const up = (data.finanzas?.pagos||[]).filter(p=>p.status==='pending'&&p.dueDate&&new Date(p.dueDate)<=new Date(Date.now()+7*864e5));
  const allTasks = Object.entries(data.areas||{}).flatMap(([a,v])=>(v.tasks||[]).filter(t=>!t.done).map(t=>({...t,area:a})));

  // Get today's events
  let calendarCtx = '';
  try {
    const events = await getEventsToday();
    if (events.length) {
      calendarCtx = '\n\nAGENDA HOY:\n' + events.map(fmtEvent).join('\n');
    }
  } catch(e) {}

  const prompt = `Sos GUS, el asistente personal de un emprendedor argentino. Generá un briefing ${period==='morning'?'matutino':'del día'} para WhatsApp. Máximo 250 palabras. Usá emojis y formato *negrita* de WhatsApp.

CONTEXTO DEL USUARIO:
${data.context||'Sin contexto cargado aún.'}

ALERTAS:
- Cobros vencidos: ${oc.map(c=>`${c.client} $${c.amount}`).join(', ')||'ninguno'}
- Propuestas sin respuesta: ${op.map(p=>p.client).join(', ')||'ninguna'}
- Pagos próximos: ${up.length}
- Tareas pendientes: ${allTasks.length}

PRIORIDADES ACTIVAS: ${(data.prioritiesLab||[]).join(' / ')||'ninguna'}${calendarCtx}

Terminá con 1 frase de coaching corta y potente.`;

  try {
    const r = await ai.messages.create({ model:'claude-sonnet-4-5', max_tokens:600, messages:[{role:'user',content:prompt}] });
    return r.content[0]?.text || '⚡ Error generando briefing.';
  } catch { return '⚡ No se pudo generar el briefing. Revisá el panel web.'; }
}

async function buildTrelloDailySummary(data) {
  const key   = process.env.TRELLO_API_KEY;
  const token = process.env.TRELLO_TOKEN;
  const cfg   = JSON.parse(data.trelloCfg || '{}');
  const dailyIds = cfg.dailyBoards || [];
  if (!key || !token) return '⚠️ Trello no configurado en GUS.';
  if (!dailyIds.length) return '📌 No tenés tableros diarios configurados. Abrí GUS → Ajustes → Trello y marcalos.';
  try {
    const idsParam = dailyIds.join(',');
    const r = await fetch(`http://localhost:${process.env.PORT||3000}/api/trello/daily-summary?key=${key}&token=${token}&boardIds=${idsParam}`);
    const { boards } = await r.json();
    let msg = '📌 *Resumen Trello diario*\n\n';
    boards.forEach(({ board, summary }) => {
      msg += `*${board.name}*\n`;
      if (summary.overdueCards.length) msg += `🔴 Vencidas: ${summary.overdueCards.slice(0,3).map(c=>c.name).join(', ')}\n`;
      if (summary.dueTodayCards.length) msg += `🟡 Hoy: ${summary.dueTodayCards.slice(0,3).map(c=>c.name).join(', ')}\n`;
      msg += `Total activas: ${summary.active}\n\n`;
    });
    return msg.trim();
  } catch { return '⚠️ Error leyendo Trello.'; }
}

async function buildTrelloBoardByName(data, name) {
  const key   = process.env.TRELLO_API_KEY;
  const token = process.env.TRELLO_TOKEN;
  if (!key || !token) return '⚠️ Trello no configurado.';
  try {
    const r = await fetch(`https://api.trello.com/1/members/me/boards?key=${key}&token=${token}&filter=open&fields=name,id`);
    const boards = await r.json();
    const board = boards.find(b => b.name.toLowerCase().includes(name.toLowerCase()));
    if (!board) return `⚠️ No encontré un tablero que contenga "${name}". Tableros disponibles: ${boards.map(b=>b.name).join(', ')}`;
    const cr = await fetch(`https://api.trello.com/1/boards/${board.id}/cards?key=${key}&token=${token}&fields=name,idList,due,dueComplete`);
    const lr = await fetch(`https://api.trello.com/1/boards/${board.id}/lists?key=${key}&token=${token}&fields=name,id`);
    const [cards, lists] = await Promise.all([cr.json(), lr.json()]);
    const byList = {};
    lists.forEach(l => byList[l.id] = { name: l.name, cards: [] });
    cards.filter(c => !c.dueComplete).forEach(c => { if(byList[c.idList]) byList[c.idList].cards.push(c); });
    let msg = `📌 *${board.name}*\n\n`;
    Object.values(byList).filter(l=>l.cards.length).forEach(l => {
      msg += `*${l.name}* (${l.cards.length})\n`;
      l.cards.slice(0,5).forEach(c => { msg += `  • ${c.name}${c.due?` · ${new Date(c.due).toLocaleDateString('es-AR',{day:'numeric',month:'short'})}`:''}\n`; });
      msg += '\n';
    });
    return msg.trim() || `✅ ${board.name} sin tarjetas activas.`;
  } catch { return '⚠️ Error leyendo el tablero.'; }
}

async function chatReply(msg, data) {
  const prompt = `Sos GUS, el asistente personal de un emprendedor argentino. Respondé de forma concisa (máx 150 palabras) para WhatsApp. Usá el contexto disponible.
Contexto: ${(data.context||'').slice(0,600)}
Mensaje: ${msg}`;
  try {
    const r = await ai.messages.create({ model:'claude-sonnet-4-5', max_tokens:300, messages:[{role:'user',content:prompt}] });
    return r.content[0]?.text || 'Error al procesar.';
  } catch { return '⚠️ Error. Intentá de nuevo.'; }
}

function buildFinanceSummary(data) {
  const oc = (data.finanzas?.cobros||[]).filter(c=>c.status==='pending');
  const pa = (data.finanzas?.pagos||[]).filter(p=>p.status==='pending');
  const pr = (data.finanzas?.propuestas||[]).filter(p=>p.status==='enviada');
  let t = '💰 *Resumen financiero*\n\n';
  if (oc.length) t += `📥 *Cobros pendientes (${oc.length}):*\n${oc.map(c=>`  • ${c.client}: $${c.amount}`).join('\n')}\n\n`;
  if (pa.length) t += `📤 *Pagos pendientes (${pa.length}):*\n${pa.map(p=>`  • ${p.vendor}: $${p.amount}`).join('\n')}\n\n`;
  if (pr.length) t += `📋 *Propuestas sin respuesta (${pr.length}):*\n${pr.map(p=>`  • ${p.client}: ${p.service}`).join('\n')}`;
  return t.trim() || '✅ Todo al día financieramente.';
}

function escapeXml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}


// ── Calendar helpers ──────────────────────────────────────────────
async function getAllCalendars() {
  const cal = await getCalendarClient();
  if (!cal) return [];
  try {
    const res = await cal.calendarList.list();
    return res.data.items || [];
  } catch(e) { return []; }
}

async function getEventsFromAllCalendars(timeMin, timeMax, maxResults=30) {
  const cal = await getCalendarClient();
  if (!cal) return [];
  try {
    const calendars = await getAllCalendars();
    const allEvents = await Promise.all(
      calendars.map(async (c) => {
        try {
          const res = await cal.events.list({
            calendarId: c.id,
            timeMin, timeMax,
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: maxResults
          });
          return (res.data.items || []).map(ev => ({
            ...ev,
            calendarName: c.summary,
            calendarColor: c.backgroundColor || '#4285F4'
          }));
        } catch(e) { return []; }
      })
    );
    // Merge and sort by start time
    return allEvents.flat().sort((a,b) => {
      const aT = new Date(a.start?.dateTime||a.start?.date).getTime();
      const bT = new Date(b.start?.dateTime||b.start?.date).getTime();
      return aT - bT;
    });
  } catch(e) { return []; }
}

async function getEventsToday() {
  const now = new Date();
  const start = new Date(now.toLocaleDateString('en-US',{timeZone:'America/Argentina/Buenos_Aires'}) + ' 00:00:00');
  const end   = new Date(now.toLocaleDateString('en-US',{timeZone:'America/Argentina/Buenos_Aires'}) + ' 23:59:59');
  return getEventsFromAllCalendars(start.toISOString(), end.toISOString(), 20);
}

async function getEventsWeek() {
  const now = new Date();
  const end = new Date(now); end.setDate(end.getDate() + 7);
  return getEventsFromAllCalendars(now.toISOString(), end.toISOString(), 40);
}

async function getFreeSlots() {
  const cal = await getCalendarClient();
  if (!cal) return [];
  const now = new Date();
  const end = new Date(now); end.setHours(20,0,0,0);
  try {
    const events = await getEventsToday();
    const busy = events
      .filter(e => e.start?.dateTime)
      .map(e => ({
        start: new Date(e.start.dateTime).getTime(),
        end:   new Date(e.end.dateTime).getTime(),
        title: e.summary
      }));
    
    const slots = [];
    let cursor = Math.max(now.getTime(), new Date().setHours(8,0,0,0));
    const endOfDay = new Date().setHours(20,0,0,0);
    
    for (const b of busy) {
      if (cursor + 30*60000 <= b.start) {
        const slotMins = Math.floor((b.start - cursor) / 60000);
        if (slotMins >= 30) {
          slots.push({
            start: new Date(cursor).toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit',timeZone:'America/Argentina/Buenos_Aires'}),
            end:   new Date(b.start).toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit',timeZone:'America/Argentina/Buenos_Aires'}),
            mins:  slotMins
          });
        }
      }
      cursor = Math.max(cursor, b.end);
    }
    if (cursor + 30*60000 <= endOfDay) {
      slots.push({
        start: new Date(cursor).toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit',timeZone:'America/Argentina/Buenos_Aires'}),
        end:   '20:00',
        mins:  Math.floor((endOfDay - cursor) / 60000)
      });
    }
    return slots;
  } catch(e) { return []; }
}

async function createEvent(eventData) {
  const cal = await getCalendarClient();
  if (!cal) return null;
  try {
    const res = await cal.events.insert({
      calendarId: 'primary',
      conferenceDataVersion: 1,
      resource: eventData
    });
    return res.data;
  } catch(e) { console.error('createEvent error:', e.message); return null; }
}

async function parseAndCreateEvent(message, data) {
  // Use AI to extract event details from natural language
  const now = new Date();
  // Get current time in Argentina (UTC-3)
  const arNow = new Date(now.toLocaleString('en-US', {timeZone: 'America/Argentina/Buenos_Aires'}));
  const arDate = arNow.toLocaleDateString('es-AR', {weekday:'long', day:'numeric', month:'long', year:'numeric', timeZone:'America/Argentina/Buenos_Aires'});
  const arTime = arNow.toLocaleTimeString('es-AR', {hour:'2-digit', minute:'2-digit', timeZone:'America/Argentina/Buenos_Aires'});
  // Build today's date string in AR timezone for ISO format
  const arYear  = arNow.getFullYear();
  const arMonth = String(arNow.getMonth()+1).padStart(2,'0');
  const arDay   = String(arNow.getDate()).padStart(2,'0');
  const todayISO = `${arYear}-${arMonth}-${arDay}`;
  const prompt = `Extraé los detalles del evento de este mensaje en español: "${message}"

Fecha actual en Argentina: ${arDate}
Hora actual en Argentina: ${arTime}
Fecha de hoy en formato ISO: ${todayISO}
CRÍTICO: El servidor corre en UTC. Vos SIEMPRE debés usar -03:00 como offset.
Ejemplo correcto para "11hs hoy": "${todayISO}T11:00:00-03:00"
Ejemplo correcto para "mañana a las 15hs": "${arYear}-${arMonth}-${String(arNow.getDate()+1).padStart(2,'0')}T15:00:00-03:00"
NUNCA uses UTC (Z) ni otros offsets. SIEMPRE -03:00.

Respondé SOLO JSON sin markdown:
{
  "summary": "título del evento",
  "startDateTime": "2026-05-29T11:00:00-03:00",
  "endDateTime": "2026-05-29T12:00:00-03:00",
  "description": "descripción opcional o null",
  "location": "ubicación opcional o null",
  "addMeet": false,
  "attendees": []
}

Reglas:
- SIEMPRE incluí -03:00 al final de las fechas
- Si dicen "11hs" → T11:00:00-03:00
- Si dicen "11am" → T11:00:00-03:00  
- Si no se especifica duración, poné 1 hora
- Si no podés extraer fecha concreta, poné null en startDateTime`;

  try {
    const r = await ai.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }]
    });
    const txt = r.content[0]?.text || '';
    const parsed = JSON.parse(txt.replace(/```json|```/g,'').trim());
    
    if (!parsed.startDateTime) return null;

    const eventResource = {
      summary: parsed.summary,
      description: parsed.description || '',
      start: { dateTime: parsed.startDateTime, timeZone: 'America/Argentina/Buenos_Aires' },
      end:   { dateTime: parsed.endDateTime,   timeZone: 'America/Argentina/Buenos_Aires' },
    };
    if (parsed.location) eventResource.location = parsed.location;
    if (parsed.addMeet) {
      eventResource.conferenceData = {
        createRequest: { requestId: Date.now().toString(), conferenceSolutionKey: { type: 'hangoutsMeet' } }
      };
    }
    if (parsed.attendees?.length) {
      eventResource.attendees = parsed.attendees.map(e => ({ email: e }));
    }
    return await createEvent(eventResource);
  } catch(e) { console.error('parseAndCreateEvent error:', e.message); return null; }
}

function fmtEvent(ev) {
  const start = ev.start?.dateTime || ev.start?.date || '';
  const time = start ? new Date(start).toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit',timeZone:'America/Argentina/Buenos_Aires'}) : '';
  const meet = ev.hangoutLink ? ` 📹 ${ev.hangoutLink}` : '';
  const loc = ev.location ? ` 📍 ${ev.location}` : '';
  return `${time ? time + ' — ' : ''}*${ev.summary}*${loc}${meet}`;
}

// Calendar endpoints for web app
app.get('/api/calendar/calendars', async (req, res) => {
  const calendars = await getAllCalendars();
  res.json({ calendars });
});

app.get('/api/calendar/today', async (req, res) => {
  const events = await getEventsToday();
  res.json({ events });
});

app.get('/api/calendar/week', async (req, res) => {
  const events = await getEventsWeek();
  res.json({ events });
});

app.post('/api/calendar/create', async (req, res) => {
  const data = await loadData();
  const event = await parseAndCreateEvent(req.body.message, data);
  res.json({ event, ok: !!event });
});

// ── Scheduled briefings (hora Argentina = UTC-3) ──────────────────
async function sendWhatsApp(text) {
  const to  = process.env.WHATSAPP_MY_NUMBER;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const auth= process.env.TWILIO_AUTH_TOKEN;
  const from= process.env.TWILIO_WHATSAPP_FROM;
  if (!to||!sid||!auth||!from) return;
  try {
    const twilio = require('twilio')(sid, auth);
    await twilio.messages.create({ from:`whatsapp:${from}`, to:`whatsapp:${to}`, body:text });
  } catch(e) { console.error('WhatsApp send error:', e.message); }
}


// ── Event reminders (30min + 10min prep) ─────────────────────────
const sentReminders = new Set();
setInterval(async () => {
  try {
    const events = await getEventsToday();
    const now = Date.now();
    for (const ev of events) {
      const start = ev.start?.dateTime;
      if (!start) continue;
      const startMs = new Date(start).getTime();
      const diff = startMs - now;
      const time = new Date(start).toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit',timeZone:'America/Argentina/Buenos_Aires'});

      // 30-min reminder
      const key30 = `30-${ev.id}`;
      if (diff > 29*60000 && diff < 31*60000 && !sentReminders.has(key30)) {
        sentReminders.add(key30);
        let msg = `⏰ *En 30 minutos:* ${ev.summary} a las ${time}`;
        if (ev.location) msg += `\n📍 ${ev.location}`;
        if (ev.hangoutLink) msg += `\n📹 ${ev.hangoutLink}`;
        await sendWhatsApp(msg);
      }

      // 10-min prep brief
      const key10 = `10-${ev.id}`;
      if (diff > 9*60000 && diff < 11*60000 && !sentReminders.has(key10)) {
        sentReminders.add(key10);
        const data = await loadData();
        const prepPrompt = `Generá una preparación brevísima para esta reunión de ${data.context?.slice(0,300)||'un emprendedor argentino'}.
Evento: ${ev.summary}
Hora: ${time}
Descripción: ${ev.description||'sin descripción'}
${ev.location?'Lugar: '+ev.location:''}

En máximo 3 líneas para WhatsApp: qué recordar, qué querés lograr, qué preguntar. Formato *negrita* de WhatsApp.`;
        try {
          const r = await ai.messages.create({model:'claude-sonnet-4-5',max_tokens:200,messages:[{role:'user',content:prepPrompt}]});
          const prep = r.content[0]?.text || '';
          await sendWhatsApp(`🧠 *Preparación — ${ev.summary} en 10 min:*\n${prep}`);
        } catch(e) {
          await sendWhatsApp(`🧠 *En 10 min:* ${ev.summary} a las ${time}${ev.hangoutLink?'\n📹 '+ev.hangoutLink:''}`);
        }
      }
    }
  } catch(e) { console.error('Reminder error:', e.message); }
}, 60000);

// 7:00 AM ART (10:00 UTC)
cron.schedule('0 10 * * *', async () => {
  const d = await loadData();
  const msg = await buildBriefing(d, 'morning');
  await sendWhatsApp(msg);
  console.log('[GUS] Briefing matutino enviado');
});

// 12:00 PM ART (15:00 UTC)
cron.schedule('0 15 * * 1-5', async () => {
  const d = await loadData();
  await sendWhatsApp(`⏰ *Check-in mediodía*\n\n${buildFinanceSummary(d)}`);
  console.log('[GUS] Check-in mediodía enviado');
});

// 7:00 PM ART (22:00 UTC)
cron.schedule('0 22 * * 1-5', async () => {
  const d   = loadData();
  const msg = await buildBriefing(d, 'evening');
  await sendWhatsApp('🌆 *Cierre del día*\n\n' + msg);
  console.log('[GUS] Cierre del día enviado');
});

app.listen(PORT, () => console.log(`✅ GUS corriendo en http://localhost:${PORT}`));
