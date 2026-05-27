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
  const body = req.body.Body?.trim() || '';
  const data = loadData();
  const reply = await agentReply(body, data);
  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(reply)}</Message></Response>`);
});


// ── AGENT CORE ────────────────────────────────────────────────────
async function agentReply(message, data) {
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
      model: 'claude-sonnet-4-20250514',
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

  const prompt = `Sos GUS, el asistente personal de un emprendedor argentino. Generá un briefing ${period==='morning'?'matutino':'del día'} para WhatsApp. Máximo 250 palabras. Usá emojis y formato *negrita* de WhatsApp.

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
  console.log('[GUS] Briefing matutino enviado');
});

// 12:00 PM ART (15:00 UTC)
cron.schedule('0 15 * * 1-5', async () => {
  const d = loadData();
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
