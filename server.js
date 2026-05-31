require('dotenv').config();
const express  = require('express');
const path     = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');
const { google } = require('googleapis');
const session  = require('express-session');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({ secret: process.env.SESSION_SECRET || 'gus-2026', resave: false, saveUninitialized: false }));

const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── PostgreSQL ────────────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDB() {
  await pool.query(`CREATE TABLE IF NOT EXISTS gus_data (id TEXT PRIMARY KEY DEFAULT 'main', data JSONB NOT NULL DEFAULT '{}')`);
  await pool.query(`INSERT INTO gus_data (id, data) VALUES ('main', '{}') ON CONFLICT (id) DO NOTHING`);
  console.log('✅ PostgreSQL conectado');
}
initDB().catch(e => console.error('DB init error:', e.message));

async function loadData() {
  try { const r = await pool.query("SELECT data FROM gus_data WHERE id='main'"); return r.rows[0]?.data || {}; }
  catch(e) { console.error('loadData:', e.message); return {}; }
}
async function saveData(d) {
  try { await pool.query("INSERT INTO gus_data (id,data) VALUES ('main',$1) ON CONFLICT (id) DO UPDATE SET data=$1", [JSON.stringify(d)]); }
  catch(e) { console.error('saveData:', e.message); }
}

// ── Google OAuth (multi-cuenta) ───────────────────────────────────
const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/gmail.readonly'
];
const BASE_URL = process.env.BASE_URL || 'https://asistentepersonal.up.railway.app';
const MAX_ACCOUNTS = 4;

function makeOAuth(accountIdx) {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${BASE_URL}/auth/google/callback?account=${accountIdx}`
  );
}

async function getGoogleClientFor(accountIdx) {
  const data = await loadData();
  const key = accountIdx === 0 ? 'googleTokens' : `googleTokens_${accountIdx}`;
  const tokens = data[key];
  if (!tokens) return null;
  const oauth = makeOAuth(accountIdx);
  oauth.setCredentials(tokens);
  if (tokens.expiry_date && tokens.expiry_date < Date.now() + 60000) {
    try {
      const { credentials } = await oauth.refreshAccessToken();
      oauth.setCredentials(credentials);
      data[key] = credentials;
      await saveData(data);
    } catch(e) { return null; }
  }
  return oauth;
}

async function getAllGoogleClients() {
  const clients = [];
  for (let i = 0; i < MAX_ACCOUNTS; i++) {
    const client = await getGoogleClientFor(i);
    if (client) clients.push({ client, idx: i });
  }
  return clients;
}

// For backwards compatibility - primary account
async function getGoogleClient() { return getGoogleClientFor(0); }

app.get('/auth/google', (req, res) => {
  const idx = parseInt(req.query.account || '0');
  const oauth = makeOAuth(idx);
  const url = oauth.generateAuthUrl({ access_type: 'offline', scope: GOOGLE_SCOPES, prompt: 'consent' });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  const idx = parseInt(req.query.account || '0');
  try {
    const oauth = makeOAuth(idx);
    const { tokens } = await oauth.getToken(req.query.code);
    const data = await loadData();
    const key = idx === 0 ? 'googleTokens' : `googleTokens_${idx}`;
    data[key] = tokens;
    // Get account email for display
    oauth.setCredentials(tokens);
    try {
      const gmail = google.gmail({ version: 'v1', auth: oauth });
      const profile = await gmail.users.getProfile({ userId: 'me' });
      if (!data.googleAccounts) data.googleAccounts = {};
      data.googleAccounts[idx] = profile.data.emailAddress;
    } catch(e) {}
    await saveData(data);
    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:3rem;background:#F4F2ED"><h2 style="font-family:Georgia,serif">✅ Cuenta ${idx+1} conectada</h2><p>Podés cerrar esta ventana.</p></body></html>`);
  } catch(e) {
    res.send('<html><body style="font-family:sans-serif;text-align:center;padding:3rem"><h2>❌ Error</h2><p>' + e.message + '</p></body></html>');
  }
});

app.get('/auth/status', async (req, res) => {
  const data = await loadData();
  const accounts = [];
  for (let i = 0; i < MAX_ACCOUNTS; i++) {
    const key = i === 0 ? 'googleTokens' : `googleTokens_${i}`;
    if (data[key]) {
      accounts.push({ idx: i, email: data.googleAccounts?.[i] || `Cuenta ${i+1}` });
    }
  }
  res.json({ connected: accounts.length > 0, accounts });
});

app.delete('/auth/google/:idx', async (req, res) => {
  const idx = parseInt(req.params.idx);
  const data = await loadData();
  const key = idx === 0 ? 'googleTokens' : `googleTokens_${idx}`;
  delete data[key];
  if (data.googleAccounts) delete data.googleAccounts[idx];
  await saveData(data);
  res.json({ ok: true });
});

// ── Calendar helpers ──────────────────────────────────────────────
async function getCalendar() {
  const auth = await getGoogleClient();
  if (!auth) return null;
  return google.calendar({ version: 'v3', auth });
}

async function getEventsRange(timeMin, timeMax) {
  const clients = await getAllGoogleClients();
  if (!clients.length) return [];
  const allResults = await Promise.all(clients.map(async ({ client }) => {
    try {
      const cal = google.calendar({ version: 'v3', auth: client });
      const lists = await cal.calendarList.list();
      const cals = lists.data.items || [];
      const evs = await Promise.all(cals.map(async c => {
        try {
          const r = await cal.events.list({ calendarId: c.id, timeMin, timeMax, singleEvents: true, orderBy: 'startTime', maxResults: 15 });
          return (r.data.items || []).map(ev => ({ ...ev, calName: c.summary }));
        } catch { return []; }
      }));
      return evs.flat();
    } catch(e) { return []; }
  }));
  // Deduplicate by event ID and sort
  const seen = new Set();
  return allResults.flat()
    .filter(ev => { if (seen.has(ev.id)) return false; seen.add(ev.id); return true; })
    .sort((a,b) => new Date(a.start?.dateTime||a.start?.date) - new Date(b.start?.dateTime||b.start?.date));
}

function arBounds(offsetDays = 0) {
  const now = new Date();
  const arStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
  const base = new Date(arStr + 'T00:00:00-03:00');
  base.setDate(base.getDate() + offsetDays);
  const end = new Date(base); end.setDate(end.getDate() + 1);
  return { min: base.toISOString(), max: end.toISOString() };
}

async function getEventsToday()    { const b = arBounds(0); return getEventsRange(b.min, b.max); }
async function getEventsTomorrow() { const b = arBounds(1); return getEventsRange(b.min, b.max); }
async function getEventsWeek()     { const b = arBounds(0); const e = arBounds(7); return getEventsRange(b.min, e.max); }

function fmtEvent(ev) {
  const s = ev.start?.dateTime || ev.start?.date || '';
  const time = s ? new Date(s).toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit',timeZone:'America/Argentina/Buenos_Aires'}) : '';
  const cal  = ev.calName && ev.calName !== 'gabriel' ? ` _(${ev.calName})_` : '';
  const loc  = ev.location ? ` 📍 ${ev.location}` : '';
  const meet = ev.hangoutLink ? ` 📹 ${ev.hangoutLink}` : '';
  return `${time ? time+' — ' : ''}*${ev.summary}*${cal}${loc}${meet}`;
}

async function parseAndCreateEvent(message, data) {
  const now   = new Date();
  const arNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
  const pad   = n => String(n).padStart(2,'0');
  const today = `${arNow.getFullYear()}-${pad(arNow.getMonth()+1)}-${pad(arNow.getDate())}`;
  const tom   = `${arNow.getFullYear()}-${pad(arNow.getMonth()+1)}-${pad(arNow.getDate()+1)}`;

  const prompt = `Extraé los detalles del evento: "${message}"
Hoy en Argentina: ${today} (${arNow.toLocaleDateString('es-AR',{weekday:'long'})})
Mañana: ${tom}
Hora actual AR: ${pad(arNow.getHours())}:${pad(arNow.getMinutes())}
SIEMPRE usar offset -03:00. Ej: ${today}T15:00:00-03:00
SOLO JSON: {"summary":"título","startDateTime":"${today}T10:00:00-03:00","endDateTime":"${today}T11:00:00-03:00","location":null,"addMeet":false,"attendees":[]}
Si no hay fecha clara poné null en startDateTime.`;

  try {
    const r = await ai.messages.create({ model:'claude-sonnet-4-5', max_tokens:300, messages:[{role:'user',content:prompt}] });
    const parsed = JSON.parse(r.content[0].text.replace(/```json|```/g,'').trim());
    if (!parsed.startDateTime) return null;
    const cal = await getCalendar();
    if (!cal) return null;
    const resource = {
      summary: parsed.summary,
      start: { dateTime: parsed.startDateTime, timeZone: 'America/Argentina/Buenos_Aires' },
      end:   { dateTime: parsed.endDateTime,   timeZone: 'America/Argentina/Buenos_Aires' },
    };
    if (parsed.location) resource.location = parsed.location;
    if (parsed.addMeet)  resource.conferenceData = { createRequest: { requestId: Date.now().toString(), conferenceSolutionKey: { type:'hangoutsMeet' } } };
    if (parsed.attendees?.length) resource.attendees = parsed.attendees.map(e=>({email:e}));
    const res = await cal.events.insert({ calendarId:'primary', conferenceDataVersion:1, resource });
    return res.data;
  } catch(e) { console.error('parseEvent:', e.message); return null; }
}

async function getFreeSlots() {
  const events = await getEventsToday();
  const now    = Date.now();
  const endDay = new Date().setHours(20,0,0,0);
  const busy   = events.filter(e=>e.start?.dateTime).map(e=>({ start: new Date(e.start.dateTime).getTime(), end: new Date(e.end.dateTime).getTime() })).sort((a,b)=>a.start-b.start);
  const slots  = [];
  let cursor   = Math.max(now, new Date().setHours(8,0,0,0));
  for (const b of busy) {
    if (cursor + 30*60000 <= b.start) slots.push({ start: cursor, end: b.start, mins: Math.floor((b.start-cursor)/60000) });
    cursor = Math.max(cursor, b.end);
  }
  if (cursor + 30*60000 <= endDay) slots.push({ start: cursor, end: endDay, mins: Math.floor((endDay-cursor)/60000) });
  const fmt = ms => new Date(ms).toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit',timeZone:'America/Argentina/Buenos_Aires'});
  return slots.map(s => `• ${fmt(s.start)} - ${fmt(s.end)} (${s.mins>=60?Math.floor(s.mins/60)+'h '+s.mins%60+'min':s.mins+'min'})`);
}

// ── Drive helpers ─────────────────────────────────────────────────
async function getDrive() {
  const auth = await getGoogleClient(); // primary account
  if (!auth) return null;
  return google.drive({ version: 'v3', auth });
}

async function searchDrive(query) {
  const clients = await getAllGoogleClients();
  if (!clients.length) return [];
  const results = await Promise.all(clients.map(async ({ client, idx }) => {
    try {
      const drive = google.drive({ version: 'v3', auth: client });
      const r = await drive.files.list({
        q: `name contains '${query.replace(/'/g,"\'")}' and trashed=false`,
        fields: 'files(id,name,mimeType,modifiedTime,webViewLink,size)',
        orderBy: 'modifiedTime desc',
        pageSize: 8
      });
      const data = await loadData();
      const email = data.googleAccounts?.[idx] || `Cuenta ${idx+1}`;
      return (r.data.files || []).map(f => ({ ...f, accountEmail: email }));
    } catch(e) { return []; }
  }));
  return results.flat().sort((a,b) => new Date(b.modifiedTime) - new Date(a.modifiedTime));
}

async function getDriveFileContent(fileId, mimeType) {
  const drive = await getDrive();
  if (!drive) return null;
  try {
    if (mimeType === 'application/vnd.google-apps.document') {
      const r = await drive.files.export({ fileId, mimeType: 'text/plain' });
      return String(r.data).slice(0, 3000);
    }
    if (mimeType === 'application/vnd.google-apps.spreadsheet') {
      const r = await drive.files.export({ fileId, mimeType: 'text/csv' });
      return String(r.data).slice(0, 2000);
    }
    if (mimeType === 'application/pdf' || mimeType?.includes('text')) {
      const r = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'text' });
      return String(r.data).slice(0, 3000);
    }
    return null;
  } catch(e) { return null; }
}

async function getRecentDriveFiles() {
  const clients = await getAllGoogleClients();
  if (!clients.length) return [];
  const results = await Promise.all(clients.map(async ({ client, idx }) => {
    try {
      const drive = google.drive({ version: 'v3', auth: client });
      const r = await drive.files.list({
        q: "trashed=false and 'me' in owners",
        fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
        orderBy: 'modifiedTime desc',
        pageSize: 6
      });
      const data = await loadData();
      const email = data.googleAccounts?.[idx] || `Cuenta ${idx+1}`;
      return (r.data.files || []).map(f => ({ ...f, accountEmail: email }));
    } catch(e) { return []; }
  }));
  return results.flat().sort((a,b) => new Date(b.modifiedTime) - new Date(a.modifiedTime)).slice(0,10);
}

// ── Gmail helpers ─────────────────────────────────────────────────
async function getRecentEmails(maxResults = 10) {
  const auth = await getGoogleClient();
  if (!auth) return [];
  const gmail = google.gmail({ version: 'v1', auth });
  try {
    const r = await gmail.users.messages.list({ userId:'me', maxResults, q:'is:unread OR newer_than:1d' });
    const msgs = r.data.messages || [];
    const details = await Promise.all(msgs.slice(0,8).map(async m => {
      try {
        const d = await gmail.users.messages.get({ userId:'me', id:m.id, format:'metadata', metadataHeaders:['From','Subject','Date'] });
        const h = d.data.payload?.headers || [];
        const get = name => h.find(x=>x.name===name)?.value || '';
        return { from: get('From'), subject: get('Subject'), date: get('Date'), snippet: d.data.snippet || '' };
      } catch { return null; }
    }));
    return details.filter(Boolean);
  } catch(e) { console.error('Gmail:', e.message); return []; }
}

// ── Calendar API endpoints ────────────────────────────────────────
app.get('/api/calendar/today',  async (req, res) => res.json({ events: await getEventsToday() }));
app.get('/api/calendar/week',   async (req, res) => res.json({ events: await getEventsWeek() }));
app.post('/api/calendar/create', async (req, res) => {
  const data = await loadData();
  const event = await parseAndCreateEvent(req.body.message, data);
  res.json({ event, ok: !!event });
});

// ── Drive API endpoints ───────────────────────────────────────────
app.get('/api/drive/recent', async (req, res) => res.json({ files: await getRecentDriveFiles() }));
app.get('/api/drive/search', async (req, res) => {
  const files = await searchDrive(req.query.q || '');
  res.json({ files });
});
app.get('/api/drive/file/:id', async (req, res) => {
  const drive = await getDrive();
  if (!drive) return res.json({ content: null });
  try {
    const meta = await drive.files.get({ fileId: req.params.id, fields: 'name,mimeType' });
    const content = await getDriveFileContent(req.params.id, meta.data.mimeType);
    res.json({ content, name: meta.data.name });
  } catch(e) { res.json({ content: null }); }
});

// ── Trello proxy ──────────────────────────────────────────────────
app.get('/api/trello/boards', async (req, res) => {
  try { res.json(await fetch(`https://api.trello.com/1/members/me/boards?key=${req.query.key}&token=${req.query.token}&filter=open&fields=name,id,url`).then(r=>r.json())); }
  catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/trello/cards', async (req, res) => {
  try {
    const [cards, lists] = await Promise.all([
      fetch(`https://api.trello.com/1/boards/${req.query.boardId}/cards?key=${req.query.key}&token=${req.query.token}&fields=name,idList,due,dueComplete,url`).then(r=>r.json()),
      fetch(`https://api.trello.com/1/boards/${req.query.boardId}/lists?key=${req.query.key}&token=${req.query.token}&fields=name,id`).then(r=>r.json())
    ]);
    res.json({ cards, lists });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── REST API ──────────────────────────────────────────────────────
app.get('/api/data',  async (_, res) => res.json(await loadData()));
app.post('/api/data', async (req, res) => { await saveData(req.body); res.json({ ok: true }); });

app.post('/api/ai', async (req, res) => {
  try {
    const data = await loadData();
    const msg = await ai.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 600,
      system: `Sos GUS, el asistente personal de Gabriel. Respondés desde la web app. Español rioplatense. Máximo 200 palabras.
Fecha y hora en Argentina: ${new Date().toLocaleString('es-AR',{timeZone:'America/Argentina/Buenos_Aires',weekday:'long',day:'numeric',month:'long',hour:'2-digit',minute:'2-digit'})}
Contexto laboral: ${data.context || 'Sin contexto.'}
Contexto personal: ${data.contextVida || 'Sin contexto.'}
Prioridades hoy: ${(data.prioritiesLab||[]).join(', ') || 'Sin check-in'}`,
      messages: [{ role:'user', content: req.body.prompt }]
    });
    res.json({ text: msg.content[0]?.text || '' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── WhatsApp Agent ────────────────────────────────────────────────
app.post('/whatsapp', async (req, res) => {
  const data    = await loadData();
  const numMedia = parseInt(req.body.NumMedia || '0');
  const ctype    = req.body.MediaContentType0 || '';
  let message    = req.body.Body?.trim() || '';
  let reply      = '';

  console.log(`WA in — media:${numMedia} type:${ctype} body:"${message.slice(0,40)}"`);

  // ── Audio via Whisper ──────────────────────────────────────────
  if (numMedia > 0 && (ctype.includes('audio') || ctype.includes('ogg'))) {
    if (!process.env.OPENAI_API_KEY) {
      reply = '⚠️ Whisper no configurado. Agregá OPENAI_API_KEY en Railway.';
    } else {
      try {
        const axios   = require('axios');
        const FormData = require('form-data');
        const sid  = process.env.TWILIO_ACCOUNT_SID;
        const auth = process.env.TWILIO_AUTH_TOKEN;
        const audioRes = await fetch(req.body.MediaUrl0, {
          headers: { 'Authorization': 'Basic ' + Buffer.from(`${sid}:${auth}`).toString('base64') }
        });
        const buf  = Buffer.from(await audioRes.arrayBuffer());
        const form = new FormData();
        form.append('file', buf, { filename:'audio.ogg', contentType:'audio/ogg' });
        form.append('model', 'whisper-1');
        form.append('language', 'es');
        const wRes = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, ...form.getHeaders() },
          timeout: 30000
        });
        message = wRes.data.text || '';
        console.log('Whisper OK:', message.slice(0,60));
        if (!message) { reply = '⚠️ No pude entender el audio. ¿Podés escribirme?'; }
      } catch(e) {
        console.error('Audio error:', e.message);
        reply = '⚠️ Error procesando el audio. Intentá de nuevo o escribime.';
      }
    }
  }

  // Si hubo error en audio, respondemos directamente
  if (reply) {
    res.set('Content-Type','text/xml');
    return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escXml(reply)}</Message></Response>`);
  }

  if (!message) {
    reply = '👋 Hola, soy GUS. Escribime o mandame un audio. Escribí *ayuda* para ver qué puedo hacer.';
    res.set('Content-Type','text/xml');
    return res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escXml(reply)}</Message></Response>`);
  }

  reply = await agentReply(message, data);
  res.set('Content-Type','text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escXml(reply)}</Message></Response>`);
});

function escXml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Agent core ────────────────────────────────────────────────────
async function agentReply(message, data) {
  const msg = message.toLowerCase();

  // Calendar: CREATE
  const createKW = ['agendá','agendame','agenda ','crear reunión','nueva reunión','anotá en el calendario','añadí al calendario','schedulea','programá'];
  if (createKW.some(k => msg.includes(k))) {
    const ev = await parseAndCreateEvent(message, data);
    if (ev) {
      const s = ev.start?.dateTime || ev.start?.date;
      const t = s ? new Date(s).toLocaleString('es-AR',{weekday:'long',day:'numeric',month:'long',hour:'2-digit',minute:'2-digit',timeZone:'America/Argentina/Buenos_Aires'}) : '';
      let r = `✅ *Evento creado:* ${ev.summary}\n📅 ${t}`;
      if (ev.location) r += `\n📍 ${ev.location}`;
      if (ev.hangoutLink) r += `\n📹 ${ev.hangoutLink}`;
      return r;
    }
    return '⚠️ No pude interpretar la fecha/hora. Probá con algo más específico, ej: "Agendame reunión con Martín el jueves a las 15hs"';
  }

  // Calendar: RESCHEDULE
  const reschedKW = ['reprogramá','reprogramame','mové la reunión','cambiá la reunión','pasá la reunión','postergar','adelantar la reunión'];
  if (reschedKW.some(k => msg.includes(k))) {
    const events = [...await getEventsToday(), ...await getEventsWeek()].slice(0,10);
    if (!events.length) return '📅 No encontré eventos próximos para reprogramar.';
    const list = events.map((e,i)=>`${i+1}. ${e.summary} - ${new Date(e.start?.dateTime||e.start?.date).toLocaleString('es-AR',{timeZone:'America/Argentina/Buenos_Aires',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}`).join('\n');
    const now = new Date(); const arNow = new Date(now.toLocaleString('en-US',{timeZone:'America/Argentina/Buenos_Aires'}));
    const pad = n=>String(n).padStart(2,'0');
    const today = `${arNow.getFullYear()}-${pad(arNow.getMonth()+1)}-${pad(arNow.getDate())}`;
    const prompt = `Usuario quiere reprogramar: "${message}"\nEventos:\n${list}\nHoy: ${today}\nSOLO JSON: {"eventIndex":0,"newStart":"${today}T15:00:00-03:00","newEnd":"${today}T16:00:00-03:00"} o {"eventIndex":-1}`;
    try {
      const r = await ai.messages.create({ model:'claude-sonnet-4-5', max_tokens:150, messages:[{role:'user',content:prompt}] });
      const d = JSON.parse(r.content[0].text.replace(/```json|```/g,'').trim());
      if (d.eventIndex >= 0 && events[d.eventIndex]) {
        const cal = await getCalendar();
        if (cal) {
          await cal.events.patch({ calendarId:'primary', eventId:events[d.eventIndex].id, resource:{
            start:{dateTime:d.newStart,timeZone:'America/Argentina/Buenos_Aires'},
            end:{dateTime:d.newEnd,timeZone:'America/Argentina/Buenos_Aires'}
          }});
          const t = new Date(d.newStart).toLocaleString('es-AR',{weekday:'long',day:'numeric',month:'long',hour:'2-digit',minute:'2-digit',timeZone:'America/Argentina/Buenos_Aires'});
          return `✅ *Reprogramado:* ${events[d.eventIndex].summary}\n📅 ${t}`;
        }
      }
    } catch(e) { console.error('Reschedule:', e.message); }
    return '⚠️ No pude identificar el evento. ¿Podés ser más específico?';
  }

  // Calendar: READ
  const readKW = ['mi agenda','ver agenda','qué tengo hoy','qué tengo mañana','mis reuniones','mis eventos','agenda de hoy','agenda de mañana','reuniones de hoy','esta semana','semana en el calendario'];
  if (readKW.some(k => msg.includes(k))) {
    let events, title;
    if (msg.includes('mañana')) { events = await getEventsTomorrow(); title = '📅 *Mañana:*'; }
    else if (msg.includes('semana')) { events = await getEventsWeek(); title = '📅 *Esta semana:*'; }
    else { events = await getEventsToday(); title = '📅 *Hoy:*'; }
    if (!events.length) return title.replace('*','').replace('*','') + ' Sin eventos.';
    return title + '\n' + events.map(fmtEvent).join('\n');
  }

  // Calendar: FREE SLOTS
  if (['espacio libre','tiempo libre','cuándo puedo','hueco','disponible hoy'].some(k=>msg.includes(k))) {
    const slots = await getFreeSlots();
    return slots.length ? '🕐 *Espacios libres hoy:*\n' + slots.join('\n') : '📅 No tenés espacios libres hoy.';
  }

  // Calendar: DELETE
  if (['cancelá el evento','borrá el evento','eliminá el evento','cancelá la reunión','borrá la reunión'].some(k=>msg.includes(k))) {
    const events = [...await getEventsToday(), ...await getEventsWeek()].slice(0,8);
    if (!events.length) return '📅 No encontré eventos para cancelar.';
    const list = events.map((e,i)=>`${i+1}. ${e.summary}`).join('\n');
    const prompt = `El usuario quiere cancelar: "${message}"\nEventos:\n${list}\nSOLO JSON: {"eventIndex":0} o {"eventIndex":-1}`;
    try {
      const r = await ai.messages.create({ model:'claude-sonnet-4-5', max_tokens:50, messages:[{role:'user',content:prompt}] });
      const d = JSON.parse(r.content[0].text.replace(/```json|```/g,'').trim());
      if (d.eventIndex >= 0 && events[d.eventIndex]) {
        const cal = await getCalendar();
        if (cal) { await cal.events.delete({ calendarId:'primary', eventId:events[d.eventIndex].id }); return `🗑 *Cancelado:* ${events[d.eventIndex].summary}`; }
      }
    } catch(e) {}
    return '⚠️ No pude identificar el evento. ¿Podés ser más específico?';
  }

  // Drive: SEARCH — broad detection
  const driveKW = ['buscame en drive','encontrá en drive','buscá en drive','buscar en drive','busca en drive',
    'en mi drive','en el drive','del drive','desde drive','en drive',
    'archivo de','encontrá el archivo','mandame el archivo','buscame el archivo',
    'buscame la propuesta','encontrá la propuesta','buscame el documento','encontrá el documento'];
  const hasDriveIntent = driveKW.some(k=>msg.includes(k)) || 
    (msg.includes('drive') && (msg.includes('busca') || msg.includes('encontrá') || msg.includes('buscame') || msg.includes('archivo') || msg.includes('propuesta') || msg.includes('documento')));
  if (hasDriveIntent) {
    const query = message.replace(/buscame en drive|encontrá en drive|buscá en drive|buscar en drive|busca en drive|buscame|encontrá|buscá|en mi drive|en el drive|del drive|en drive|el archivo|la propuesta|el documento/gi,'').trim();
    const files = await searchDrive(query);
    if (!files.length) return `🔍 No encontré archivos con "${query}" en Drive.`;
    let reply = `📁 *Encontré en Drive:*\n`;
    for (const f of files.slice(0,5)) {
      const date = new Date(f.modifiedTime).toLocaleDateString('es-AR',{day:'numeric',month:'short'});
      reply += `\n• *${f.name}* (${date})\n  ${f.webViewLink}`;
    }
    return reply;
  }

  // Drive: SUMMARY of a file
  const summaryKW = ['resumime','resumen de','qué dice','qué incluye','qué tiene','contenido de','abrí el','abrí la','leeme'];
  const hasSummaryIntent = summaryKW.some(k=>msg.includes(k)) && 
    (msg.includes('archivo') || msg.includes('propuesta') || msg.includes('documento') || msg.includes('drive') || msg.includes('pdf') || msg.includes('sheet') || msg.includes('doc'));
  if (hasSummaryIntent) {
    const query = message.replace(/resumime|resumen de|qué dice|qué incluye|qué tiene|contenido de|el archivo|la propuesta|el documento|en drive/gi,'').trim();
    const files = await searchDrive(query);
    if (!files.length) return `🔍 No encontré "${query}" en Drive.`;
    const f = files[0];
    const content = await getDriveFileContent(f.id, f.mimeType);
    if (!content) return `📁 *${f.name}*\nNo pude leer el contenido de este tipo de archivo. Abrilo acá: ${f.webViewLink}`;
    const prompt = `Resumí este documento en máximo 5 puntos clave para WhatsApp. Sé conciso.\n\nArchivo: ${f.name}\n\n${content}`;
    try {
      const r = await ai.messages.create({ model:'claude-sonnet-4-5', max_tokens:400, messages:[{role:'user',content:prompt}] });
      return `📁 *${f.name}:*\n${r.content[0]?.text}`;
    } catch { return `📁 *${f.name}*\n${f.webViewLink}`; }
  }

  // Drive: RECENT FILES
  if (['archivos recientes','últimos archivos','drive reciente','qué subí','qué modifiqué'].some(k=>msg.includes(k))) {
    const files = await getRecentDriveFiles();
    if (!files.length) return '📁 No pude acceder a Drive.';
    return '📁 *Últimos archivos en Drive:*\n' + files.map(f=>`• *${f.name}* (${new Date(f.modifiedTime).toLocaleDateString('es-AR',{day:'numeric',month:'short'})})`).join('\n');
  }

  // Emails
  if (['emails','mails','correos','qué llegó','bandeja'].some(k=>msg.includes(k))) {
    const emails = await getRecentEmails();
    if (!emails.length) return '📧 No pude acceder a Gmail.';
    return '📧 *Emails recientes:*\n' + emails.slice(0,5).map(e=>`• *${e.subject}*\n  ${e.from.split('<')[0].trim()}\n  ${e.snippet?.slice(0,80)}...`).join('\n\n');
  }

  // Trello
  if (msg.startsWith('trello')) {
    const name = msg.replace('trello','').trim();
    if (!name) return '📌 Escribí *trello [nombre del tablero]* para ver el estado de un proyecto.';
    try {
      const tKey = process.env.TRELLO_API_KEY || '';
      const tTok = process.env.TRELLO_TOKEN || '';
      if (!tKey) return '⚙️ Trello no configurado. Conectalo en la web app.';
      const boards = await fetch(`https://api.trello.com/1/members/me/boards?key=${tKey}&token=${tTok}&filter=open&fields=name,id`).then(r=>r.json());
      const board = boards.find(b=>b.name.toLowerCase().includes(name.toLowerCase()));
      if (!board) return `📌 No encontré tablero con "${name}". Tableros: ${boards.map(b=>b.name).join(', ')}`;
      const [cards, lists] = await Promise.all([
        fetch(`https://api.trello.com/1/boards/${board.id}/cards?key=${tKey}&token=${tTok}&fields=name,idList,due,dueComplete`).then(r=>r.json()),
        fetch(`https://api.trello.com/1/boards/${board.id}/lists?key=${tKey}&token=${tTok}&fields=name,id`).then(r=>r.json())
      ]);
      const byList = {};
      lists.forEach(l=>byList[l.id]={name:l.name,cards:[]});
      cards.filter(c=>!c.dueComplete).forEach(c=>{if(byList[c.idList])byList[c.idList].cards.push(c.name);});
      let r = `📌 *${board.name}:*\n`;
      Object.values(byList).filter(l=>l.cards.length).forEach(l=>{ r += `\n*${l.name}:*\n${l.cards.slice(0,5).map(c=>`  • ${c}`).join('\n')}`; });
      return r || '✅ Sin tarjetas activas.';
    } catch(e) { return '⚠️ Error leyendo Trello.'; }
  }

  // Finanzas
  if (['finanzas','cobros','pagos','propuestas','cuánto me deben','mis cobros'].some(k=>msg.includes(k))) {
    const oc = (data.finanzas?.cobros||[]).filter(c=>c.status==='pending');
    const pa = (data.finanzas?.pagos||[]).filter(p=>p.status==='pending');
    const pr = (data.finanzas?.propuestas||[]).filter(p=>p.status==='enviada');
    let r = '💰 *Finanzas:*\n';
    if (oc.length) r += `\n📥 *Cobros pendientes (${oc.length}):*\n${oc.map(c=>`  • ${c.client}: $${c.amount}`).join('\n')}`;
    if (pa.length) r += `\n\n📤 *Pagos pendientes (${pa.length}):*\n${pa.map(p=>`  • ${p.vendor}: $${p.amount}`).join('\n')}`;
    if (pr.length) r += `\n\n📋 *Propuestas sin respuesta (${pr.length}):*\n${pr.map(p=>`  • ${p.client}: ${p.service}`).join('\n')}`;
    return r.trim() || '✅ Sin alertas financieras.';
  }

  // Prioridades
  if (['prioridades','mis prioridades','qué hago hoy','por dónde arranco'].some(k=>msg.includes(k))) {
    const lab  = data.prioritiesLab  || [];
    const vida = data.prioritiesVida || [];
    if (!lab.length && !vida.length) return '📋 No hay prioridades. Hacé el check-in en la web app.';
    let r = '';
    if (lab.length)  r += '🔵 *Laboral:*\n' + lab.map((p,i)=>`${i+1}. ${p}`).join('\n');
    if (vida.length) r += (r?'\n\n':'') + '🟢 *Vida:*\n' + vida.map((p,i)=>`${i+1}. ${p}`).join('\n');
    return r;
  }

  // Briefing
  if (['briefing','buenos días','resumen del día','cómo arranco','arrancar el día'].some(k=>msg.includes(k))) {
    return await buildBriefing(data);
  }

  // Ayuda
  if (msg === 'ayuda' || msg === 'help') {
    return `🤖 *Hola, soy GUS.*\n\n📅 *mi agenda* → eventos de hoy\n📅 *agenda de mañana* → mañana\n📅 *agendame reunión...* → crear evento\n📅 *reprogramá la reunión...* → mover evento\n📅 *espacio libre* → huecos del día\n\n📁 *buscame en drive [nombre]* → buscar archivo\n📁 *resumime la propuesta de [cliente]* → leer y resumir\n📁 *archivos recientes* → últimos docs\n\n📧 *emails* → bandeja de entrada\n📌 *trello [tablero]* → estado del proyecto\n💰 *finanzas* → cobros y pagos\n🎯 *prioridades* → tus top 3\n📋 *briefing* → resumen del día\n\nO escribime lo que necesités en lenguaje natural.`;
  }

  // General agent with full context
  const now = new Date();
  const arToday = now.toLocaleDateString('es-AR',{weekday:'long',day:'numeric',month:'long',timeZone:'America/Argentina/Buenos_Aires'});
  const events = await getEventsToday().catch(()=>[]);
  const calCtx = events.length ? '\nAgenda hoy: ' + events.map(e=>fmtEvent(e)).join(' | ') : '';

  const systemPrompt = `Sos GUS, el asistente personal inteligente de Gabriel. Respondés por WhatsApp de forma natural, concisa y útil. Español rioplatense. Máximo 250 palabras. Usá *negrita* de WhatsApp para lo importante.

CONTEXTO LABORAL:
${data.context || 'Sin contexto cargado.'}

CONTEXTO PERSONAL:
${data.contextVida || 'Sin contexto personal.'}

ESTADO HOY (${arToday}):
Prioridades laborales: ${(data.prioritiesLab||[]).join(' | ') || 'sin check-in'}
Prioridades de vida: ${(data.prioritiesVida||[]).join(' | ') || 'sin check-in'}
${calCtx}
Cobros vencidos: ${(data.finanzas?.cobros||[]).filter(c=>c.status==='pending'&&c.dueDate&&new Date(c.dueDate)<new Date()).length}
Propuestas sin respuesta: ${(data.finanzas?.propuestas||[]).filter(p=>p.status==='enviada').length}`;

  try {
    const r = await ai.messages.create({
      model: 'claude-sonnet-4-5', max_tokens: 500,
      system: systemPrompt,
      messages: [{ role:'user', content: message }]
    });
    return r.content[0]?.text || '⚠️ Error al procesar.';
  } catch(e) { console.error('Agent:', e.message); return '⚠️ Error de conexión. Intentá de nuevo.'; }
}

async function buildBriefing(data) {
  const events = await getEventsToday().catch(()=>[]);
  const oc = (data.finanzas?.cobros||[]).filter(c=>c.status==='pending'&&c.dueDate&&new Date(c.dueDate)<new Date());
  const op = (data.finanzas?.propuestas||[]).filter(p=>p.status==='enviada');
  const prompt = `Generá un briefing matutino para WhatsApp. Máximo 200 palabras. Usá emojis y *negrita*.

CONTEXTO: ${(data.context||'').slice(0,400)}
AGENDA HOY: ${events.length ? events.map(fmtEvent).join(' | ') : 'Sin eventos'}
PRIORIDADES: ${(data.prioritiesLab||[]).join(' | ') || 'sin check-in'}
ALERTAS: cobros vencidos: ${oc.map(c=>c.client).join(', ')||'ninguno'} | propuestas pendientes: ${op.map(p=>p.client).join(', ')||'ninguna'}

Terminá con un insight de coaching de 1 línea.`;
  try {
    const r = await ai.messages.create({ model:'claude-sonnet-4-5', max_tokens:500, messages:[{role:'user',content:prompt}] });
    return r.content[0]?.text || '⚠️ Error generando briefing.';
  } catch { return '⚠️ No se pudo generar el briefing.'; }
}

// ── WhatsApp send ─────────────────────────────────────────────────
async function sendWhatsApp(text) {
  const { to, sid, auth, from } = { to:process.env.WHATSAPP_MY_NUMBER, sid:process.env.TWILIO_ACCOUNT_SID, auth:process.env.TWILIO_AUTH_TOKEN, from:process.env.TWILIO_WHATSAPP_FROM };
  if (!to||!sid||!auth||!from) return;
  try { const tw = require('twilio')(sid,auth); await tw.messages.create({ from:`whatsapp:${from}`, to:`whatsapp:${to}`, body:text }); }
  catch(e) { console.error('WA send:', e.message); }
}

app.listen(PORT, () => console.log(`✅ GUS corriendo en http://localhost:${PORT}`));
