require('dotenv').config();
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const cron    = require('node-cron');
const Anthropic = require('@anthropic-ai/sdk');

const app  = express();
const PORT = process.env.PORT || 3000;
const DATA = path.join(__dirname, 'data', 'data.json');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Data helpers ─────────────────────────────────────────────────
function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA, 'utf8')); }
  catch { return { context:'', areas:{}, finanzas:{cobros:[],pagos:[],propuestas:[]}, priorities:[], reflections:{} }; }
}
function saveData(d) { fs.writeFileSync(DATA, JSON.stringify(d, null, 2)); }

// ── REST API ──────────────────────────────────────────────────────
app.get('/api/data',  (_, res) => res.json(loadData()));
app.post('/api/data', (req, res) => { saveData(req.body); res.json({ ok: true }); });

// Anthropic proxy (keeps key on server, not exposed to browser)
app.post('/api/ai', async (req, res) => {
  try {
    const msg = await ai.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{ role: 'user', content: req.body.prompt }]
    });
    res.json({ text: msg.content[0]?.text || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Trello proxy
app.get('/api/trello/boards', async (req, res) => {
  const { key, token } = req.query;
  try {
    const r = await fetch(`https://api.trello.com/1/members/me/boards?key=${key}&token=${token}&filter=open&fields=name,id,url`);
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/trello/cards', async (req, res) => {
  const { key, token, boardId } = req.query;
  try {
    const r = await fetch(`https://api.trello.com/1/boards/${boardId}/cards?key=${key}&token=${token}&fields=name,idList,due,dueComplete,url,desc`);
    const cards = await r.json();
    const listsR = await fetch(`https://api.trello.com/1/boards/${boardId}/lists?key=${key}&token=${token}&fields=name,id`);
    const lists = await listsR.json();
    res.json({ cards, lists });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── WhatsApp (Twilio) ─────────────────────────────────────────────
app.post('/whatsapp', async (req, res) => {
  const body = req.body.Body?.trim() || '';
  const cmd  = body.toLowerCase();
  const data = loadData();
  let reply  = '';

  if (['briefing','buenos dias','buen día','start'].includes(cmd)) {
    reply = await buildBriefing(data, 'morning');
  } else if (cmd === 'prioridades') {
    reply = (data.priorities||[]).length
      ? '🎯 *Tus prioridades:*\n' + data.priorities.map((p,i)=>`${i+1}. ${p}`).join('\n')
      : 'No hay prioridades. Hacé el check-in en la web app.';
  } else if (cmd === 'finanzas') {
    reply = buildFinanceSummary(data);
  } else if (cmd === 'trello') {
    reply = await buildTrelloSummary(data);
  } else if (cmd === 'ayuda' || cmd === 'help') {
    reply = '🤖 *Comandos disponibles:*\n\n📋 *briefing* → resumen matutino\n🎯 *prioridades* → tus top 3\n💰 *finanzas* → cobros y pagos\n📌 *trello* → tarjetas activas\n\nO escribime lo que sea y te respondo.';
  } else {
    reply = await chatReply(body, data);
  }

  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(reply)}</Message></Response>`);
});

// ── AI helpers ────────────────────────────────────────────────────
async function buildBriefing(data, period) {
  const oc = (data.finanzas?.cobros||[]).filter(c=>c.status==='pending'&&c.dueDate&&new Date(c.dueDate)<new Date());
  const op = (data.finanzas?.propuestas||[]).filter(p=>p.status==='enviada');
  const up = (data.finanzas?.pagos||[]).filter(p=>p.status==='pending'&&p.dueDate&&new Date(p.dueDate)<=new Date(Date.now()+7*864e5));
  const allTasks = Object.entries(data.areas||{}).flatMap(([a,v])=>(v.tasks||[]).filter(t=>!t.done).map(t=>({...t,area:a})));

  const prompt = `Sos el asistente personal de un emprendedor argentino. Generá un briefing ${period==='morning'?'matutino':'del día'} para WhatsApp. Máximo 250 palabras. Usá emojis y formato *negrita* de WhatsApp.

CONTEXTO DEL USUARIO:
${data.context||'Sin contexto cargado aún.'}

ALERTAS:
- Cobros vencidos: ${oc.map(c=>`${c.client} $${c.amount}`).join(', ')||'ninguno'}
- Propuestas sin respuesta: ${op.map(p=>p.client).join(', ')||'ninguna'}
- Pagos próximos: ${up.length}
- Tareas pendientes: ${allTasks.length}

PRIORIDADES ACTIVAS: ${(data.priorities||[]).join(' / ')||'ninguna'}

Terminá con 1 frase de coaching corta y potente.`;

  try {
    const r = await ai.messages.create({ model:'claude-sonnet-4-20250514', max_tokens:600, messages:[{role:'user',content:prompt}] });
    return r.content[0]?.text || '⚡ Error generando briefing.';
  } catch { return '⚡ No se pudo generar el briefing. Revisá el panel web.'; }
}

async function buildTrelloSummary(data) {
  const key   = process.env.TRELLO_API_KEY;
  const token = process.env.TRELLO_TOKEN;
  const board = process.env.TRELLO_BOARD_ID;
  if (!key||!token||!board) return '⚠️ Trello no configurado. Agregá las claves en el panel web.';
  try {
    const r = await fetch(`https://api.trello.com/1/boards/${board}/cards?key=${key}&token=${token}&fields=name,due,dueComplete`);
    const cards = await r.json();
    const active = cards.filter(c=>!c.dueComplete).slice(0,10);
    return '📌 *Trello — tarjetas activas:*\n' + active.map(c=>`• ${c.name}${c.due?` (${new Date(c.due).toLocaleDateString('es-AR',{day:'numeric',month:'short'})})`:''}`).join('\n');
  } catch { return '⚠️ Error leyendo Trello.'; }
}

async function chatReply(msg, data) {
  const prompt = `Sos el asistente personal de un emprendedor argentino. Respondé de forma concisa (máx 150 palabras) para WhatsApp. Usá el contexto disponible.
Contexto: ${(data.context||'').slice(0,600)}
Mensaje: ${msg}`;
  try {
    const r = await ai.messages.create({ model:'claude-sonnet-4-20250514', max_tokens:300, messages:[{role:'user',content:prompt}] });
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

// 7:00 AM ART (10:00 UTC)
cron.schedule('0 10 * * *', async () => {
  const d = loadData();
  const msg = await buildBriefing(d, 'morning');
  await sendWhatsApp(msg);
  console.log('[CRON] Briefing matutino enviado');
});

// 12:00 PM ART (15:00 UTC)
cron.schedule('0 15 * * 1-5', async () => {
  const d = loadData();
  await sendWhatsApp(`⏰ *Check-in mediodía*\n\n${buildFinanceSummary(d)}`);
  console.log('[CRON] Check-in mediodía enviado');
});

// 7:00 PM ART (22:00 UTC)
cron.schedule('0 22 * * 1-5', async () => {
  const d   = loadData();
  const msg = await buildBriefing(d, 'evening');
  await sendWhatsApp('🌆 *Cierre del día*\n\n' + msg);
  console.log('[CRON] Cierre del día enviado');
});

app.listen(PORT, () => console.log(`✅ Asistente corriendo en http://localhost:${PORT}`));
