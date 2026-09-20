import { DurableObject } from "cloudflare:workers";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { Document, Packer, Paragraph, TextRun, AlignmentType } from "docx";

const A4 = { width: 595.28, height: 841.89 };

const TELEGRAM_API = "https://api.telegram.org";

function versionInfo(env) {
  const meta = env?.CF_VERSION_METADATA;
  return {
    id: meta?.id || "unknown",
    tag: meta?.tag || null,
    timestamp: meta?.timestamp || null
  };
}

function formatVersion(env) {
  const info = versionInfo(env);
  return info.id === "unknown" ? "unknown" : info.id.slice(0, 12);
}

async function sendTelegramStatus(env, message) {
  const token = env?.TELEGRAM_BOT_TOKEN;
  const chatId = env?.TELEGRAM_STATUS_CHAT_ID;
  if (!token || !chatId) {
    console.warn("VYNTRO status monitor is not configured: missing Telegram secrets.");
    return { sent: false, reason: "missing_secrets" };
  }

  const response = await fetch(
    `${TELEGRAM_API}/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        disable_web_page_preview: true
      })
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram API ${response.status}: ${body.slice(0, 300)}`);
  }

  return { sent: true };
}


async function sendStartMessage(env, chatId, firstName = "there") {
  const message = [
    "✨ VYNTRO",
    "",
    `Hey ${firstName}! 👋`,
    "",
    "Create. Play. Explore.",
    "",
    "🛠️ Utilities",
    "🎮 Games",
    "🎉 Activities",
    "📄 Document tools",
    "",
    "Tap the button below to open VYNTRO.",
    "",
    "🚀 More features are coming soon."
  ].join("\n");

  const token = env?.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return { sent: false, reason: "missing_secrets_or_chat_id" };

  const response = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[
          { text: "🚀 Open VYNTRO", web_app: { url: "https://vyntro.xark0047.workers.dev/" } }
        ]]
      }
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram API ${response.status}: ${body.slice(0, 300)}`);
  }

  return { sent: true };
}

async function handleTelegramUpdate(env, update) {
  const message = update?.message;
  if (!message?.chat?.id) return { ok: true, ignored: true };

  const text = String(message.text || "").trim();
  const command = (text.split(/\\s+/)[0] || "").split("@")[0].toLowerCase();

  if (command === "/start") {
    return sendStartMessage(
      env,
      message.chat.id,
      message.from?.first_name || "there"
    );
  }

  if (command === "/help") {
    const token = env?.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured.");

    const response = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: message.chat.id,
        text: "🤖 VYNTRO Help\\n\\n/start — Open VYNTRO\\n/help — Show this help\\n/app — Open the VYNTRO Mini App"
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Telegram API ${response.status}: ${body.slice(0, 300)}`);
    }

    return { sent: true };
  }

  if (command === "/app") {
    return sendStartMessage(env, message.chat.id, message.from?.first_name || "there");
  }

  return { ok: true, ignored: true };
}

async function ensureTelegramWebhook(env) {
  const token = env?.TELEGRAM_BOT_TOKEN;
  if (!token) return { configured: false, reason: "missing_token" };

  const webhookUrl = "https://vyntro.xark0047.workers.dev/api/telegram";
  const infoResponse = await fetch(`${TELEGRAM_API}/bot${token}/getWebhookInfo`);
  if (!infoResponse.ok) throw new Error(`Telegram getWebhookInfo failed: ${infoResponse.status}`);

  const info = await infoResponse.json();
  if (info?.result?.url === webhookUrl) return { configured: true, changed: false };

  const setResponse = await fetch(`${TELEGRAM_API}/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      allowed_updates: ["message", "my_chat_member"]
    })
  });

  if (!setResponse.ok) {
    const body = await setResponse.text();
    throw new Error(`Telegram setWebhook failed: ${setResponse.status}: ${body.slice(0, 300)}`);
  }

  return { configured: true, changed: true };
}

async function configureTelegramCommands(env) {
  const token = env?.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured.");

  const response = await fetch(`${TELEGRAM_API}/bot${token}/setMyCommands`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      commands: [
        { command: "start", description: "Open VYNTRO" },
        { command: "app", description: "Open the VYNTRO Mini App" },
        { command: "help", description: "Show VYNTRO help" }
      ]
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram setMyCommands failed: ${response.status}: ${body.slice(0, 300)}`);
  }

  return true;
}

async function runStatusCheck(env, scheduledTime = Date.now()) {
  const info = versionInfo(env);
  const versionCreated = info.timestamp ? Date.parse(info.timestamp) : NaN;
  const recentDeployment = Number.isFinite(versionCreated)
    ? (scheduledTime - versionCreated) <= 20 * 60 * 1000
    : false;

  const headline = recentDeployment
    ? "🟢 VYNTRO IS ONLINE\n🚀 Deployment detected"
    : "💚 VYNTRO Heartbeat";

  const message = [
    headline,
    "",
    "Status: 🟢 Operational",
    `Version: ${formatVersion(env)}`,
    info.tag ? `Tag: ${info.tag}` : null,
    `Checked: ${new Date(scheduledTime).toISOString()}`,
    "",
    "VYNTRO • Create. Play. Explore. 🚀"
  ].filter(Boolean).join("\n");

  return sendTelegramStatus(env, message);
}

function cleanName(value) {
  return (String(value || "VYNTRO-Report").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "VYNTRO-Report");
}
function paragraphs(text) {
  return String(text || "").replace(/\r/g, "").split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
}
function alignment(value) {
  return value === "center" ? AlignmentType.CENTER : value === "right" ? AlignmentType.RIGHT : AlignmentType.LEFT;
}
function wrapText(font, text, size, maxWidth) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const test = line ? line + " " + word : word;
    if (font.widthOfTextAtSize(test, size) <= maxWidth || !line) line = test;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

async function makePDF(data) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.TimesRoman);
  const bold = await pdf.embedFont(StandardFonts.TimesRomanBold);
  const fs = Math.max(10, Math.min(18, Number(data.fontSize) || 12));
  const lineGap = fs * (Number(data.lineSpacing) || 2);
  const left = 71;
  const right = 62;
  const top = 71;
  const bottom = 57;
  const contentWidth = A4.width - left - right;
  let page, y;

  const newPage = () => { page = pdf.addPage([A4.width, A4.height]); y = A4.height - top; return page; };
  newPage();

  const drawCentered = (text, size, fontObj, gapAfter = 12) => {
    const lines = wrapText(fontObj, text, size, contentWidth);
    for (const line of lines) {
      page.drawText(line, { x: (A4.width - fontObj.widthOfTextAtSize(line, size)) / 2, y, size, font: fontObj });
      y -= lineGap;
    }
    y -= gapAfter;
  };

  drawCentered(data.title || "Report", fs, bold, 38);
  drawCentered(data.assessment || "", fs, font, 5);
  drawCentered(data.department || "", fs, font, 5);
  drawCentered(data.university || "", fs, font, 30);
  drawCentered("Submitted by", fs, font, 8);
  drawCentered(data.student || "", fs, bold, 5);
  drawCentered(data.semester || "", fs, bold, 10);

  const sections = [
    ["Executive Summary", data.summary, false],
    ["Report", data.report, false],
    ["References", data.refs, true]
  ];

  for (const [heading, body, isRef] of sections) {
    const ps = paragraphs(body);
    if (!ps.length) continue;
    newPage();
    page.drawText(heading, { x: left, y, size: fs + 2, font: bold });
    y -= lineGap + 8;

    for (const para of ps) {
      const firstIndent = isRef ? 0 : 36;
      const lines = wrapText(font, para, fs, contentWidth - firstIndent);
      for (let i = 0; i < lines.length; i++) {
        if (y < bottom + lineGap) newPage();
        const indent = i === 0 ? firstIndent : 0;
        page.drawText(lines[i], { x: left + indent, y, size: fs, font });
        y -= lineGap;
      }
      y -= fs * 0.45;
    }
  }

  return pdf.save();
}

async function validateTelegramInitData(initData, token) {
  if (!initData || !token) return null;

  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  const authDate = Number(params.get("auth_date") || 0);
  if (!receivedHash || !authDate) return null;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - authDate) > 24 * 60 * 60) return null;

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const encoder = new TextEncoder();
  const webAppKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode("WebAppData"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const secretKey = await crypto.subtle.sign(
    "HMAC",
    webAppKey,
    encoder.encode(token)
  );

  const dataKey = await crypto.subtle.importKey(
    "raw",
    secretKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const expected = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    dataKey,
    encoder.encode(dataCheckString)
  ));

  const actual = new Uint8Array(
    receivedHash.match(/.{1,2}/g)?.map(x => parseInt(x, 16)) || []
  );
  if (actual.length !== expected.length) return null;

  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ actual[i];
  if (diff !== 0) return null;

  const user = params.get("user");
  if (!user) return null;

  try {
    const parsed = JSON.parse(user);
    return parsed?.id ? String(parsed.id) : null;
  } catch (_) {
    return null;
  }
}

const UNO_COLORS = ["red", "yellow", "green", "blue"];
const UNO_VALUES = ["0","1","2","3","4","5","6","7","8","9","skip","reverse","+2"];

function makeUnoDeck() {
  const d = [];
  for (const color of UNO_COLORS) {
    for (const value of UNO_VALUES) {
      d.push({ c: color, v: value });
      if (value !== "0") d.push({ c: color, v: value });
    }
  }
  for (let i = 0; i < 4; i++) {
    d.push({ c: "wild", v: "wild" }, { c: "wild", v: "+4" });
  }
  return d;
}
function shuffleDeck(d) {
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}
function roomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(5)), x => chars[x % chars.length]).join("");
}

class UnoRoom extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.state = state;
    this.env = env;
    this.room = null;
  }
  async load() {
    if (!this.room) this.room = await this.state.storage.get("room");
    return this.room;
  }
  async save() {
    await this.state.storage.put("room", this.room);
  }
  publicState(playerId) {
    const r = this.room;
    return {
      code: r.code,
      status: r.started ? "playing" : "waiting",
      players: r.players.map((p, i) => ({
        seat: i, id: p.id, name: p.name, cards: p.hand.length, connected: p.connected
      })),
      you: r.players.findIndex(p => p.id === playerId),
      turn: r.turn,
      discard: r.discard,
      currentColor: r.currentColor,
      yourHand: r.players.find(p => p.id === playerId)?.hand || [],
      direction: r.direction,
      uno: r.uno || null,
      winner: r.winner || null
    };
  }
  async fetch(request) {
    await this.load();
    const url = new URL(request.url);
    if (request.method !== "POST") return Response.json({ ok: true, game: this.room });
    const body = await request.json().catch(() => ({}));
    const action = body.action;
    if (action === "create") {
      if (this.room) return Response.json({ ok: false, error: "Room already exists." }, { status: 409 });
      const player = { id: String(body.playerId), name: String(body.name || "Player").slice(0, 32), hand: [], connected: true };
      this.room = { code: String(body.code), players: [player], deck: [], discard: null, currentColor: null, turn: 0, direction: 1, started: false, winner: null };
      await this.save();
      return Response.json({ ok: true, game: this.publicState(player.id) });
    }
    const pid = String(body.playerId || "");
    const idx = this.room.players.findIndex(p => p.id === pid);
    if (action === "join") {
      if (idx >= 0) { this.room.players[idx].connected = true; await this.save(); return Response.json({ok:true,game:this.publicState(pid)}); }
      if (this.room.players.length >= 4) return Response.json({ ok:false,error:"Room is full." }, {status:409});
      this.room.players.push({id:pid,name:String(body.name||"Player").slice(0,32),hand:[],connected:true});
      if (this.room.players.length === 4) this.startGame();
      await this.save();
      return Response.json({ok:true,game:this.publicState(pid)});
    }
    if (idx < 0) return Response.json({ok:false,error:"Player is not in this room."},{status:403});
    if (action === "state") return Response.json({ok:true,game:this.publicState(pid)});
    if (action === "play") {
      if (!this.room.started) return Response.json({ok:false,error:"Waiting for 4 players."},{status:409});
      if (this.room.turn !== idx) return Response.json({ok:false,error:"Not your turn."},{status:409});
      const cardIndex = Number(body.cardIndex);
      const card = this.room.players[idx].hand[cardIndex];
      if (!card || !this.playable(card)) return Response.json({ok:false,error:"That card cannot be played."},{status:409});
      this.room.players[idx].hand.splice(cardIndex,1);
      this.room.discard=card;
      if (card.c==="wild") {
        if (!UNO_COLORS.includes(body.color)) return Response.json({ok:false,error:"Choose a colour."},{status:400});
        this.room.currentColor=body.color;
      } else this.room.currentColor=card.c;
      if (this.room.players[idx].hand.length===0) this.room.winner=idx;
      else this.advanceTurn(card);
      await this.save();
      return Response.json({ok:true,game:this.publicState(pid)});
    }
    if (action === "draw") {
      if (!this.room.started || this.room.turn !== idx) return Response.json({ok:false,error:"Not your turn."},{status:409});
      if (!this.room.deck.length) this.rebuildDeck();
      this.room.players[idx].hand.push(this.room.deck.pop());
      this.advanceTurn(null);
      await this.save();
      return Response.json({ok:true,game:this.publicState(pid)});
    }
    if (action === "uno") {
      if (this.room.players[idx].hand.length === 1) this.room.uno=idx;
      await this.save();
      return Response.json({ok:true,game:this.publicState(pid)});
    }
    return Response.json({ok:false,error:"Unknown UNO action."},{status:400});
  }
  startGame() {
    this.room.deck=shuffleDeck(makeUnoDeck());
    this.room.players.forEach(p=>p.hand=this.room.deck.splice(0,7));
    do { this.room.discard=this.room.deck.pop(); } while (this.room.discard.c==="wild");
    this.room.currentColor=this.room.discard.c;
    this.room.turn=0; this.room.started=true;
  }
  playable(card) {
    return card.c==="wild" || card.c===this.room.currentColor || card.v===this.room.discard.v;
  }
  rebuildDeck() {
    const oldDiscard=this.room.discard;
    this.room.deck=shuffleDeck(makeUnoDeck().filter(c => c.c!==oldDiscard.c || c.v!==oldDiscard.v));
  }
  advanceTurn(card) {
    if (!this.room.players.length) return;
    let step = this.room.direction;
    if (card?.v==="reverse") this.room.direction *= -1;
    if (card?.v==="skip") step *= 2;
    this.room.turn=(this.room.turn + step + this.room.players.length) % this.room.players.length;
  }
}

async function sendGeneratedDocumentToTelegram(env, chatId, bytes, fileName, mimeType) {
  const token = env?.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) throw new Error("Telegram export delivery is not configured.");

  const form = new FormData();
  form.append("chat_id", chatId);
  form.append(
    "document",
    new Blob([bytes], { type: mimeType }),
    fileName
  );
  form.append("caption", `📄 VYNTRO Report Writer\\n\\n${fileName}`);

  const response = await fetch(`${TELEGRAM_API}/bot${token}/sendDocument`, {
    method: "POST",
    body: form
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram sendDocument failed: ${response.status}: ${body.slice(0, 300)}`);
  }

  const result = await response.json();
  if (!result?.ok) {
    throw new Error(result?.description || "Telegram rejected the document.");
  }

  return result;
}

async function makeDOCX(data) {
  const fs = Math.max(10, Math.min(18, Number(data.fontSize) || 12));
  const line = Math.round((Number(data.lineSpacing) || 2) * 240);
  const children = [];

  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 3600, after: 700, line },
    children: [new TextRun({ text: data.title || "Report", bold: true, font: "Times New Roman", size: fs * 2 })]
  }));
  for (const value of [data.assessment, data.department, data.university]) {
    if (value) children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 120, line }, children: [new TextRun({ text: value, font: "Times New Roman", size: fs * 2 })] }));
  }
  children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 500, after: 120, line }, children: [new TextRun({ text: "Submitted by", font: "Times New Roman", size: fs * 2 })] }));
  for (const value of [data.student, data.semester]) {
    if (value) children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 120, line }, children: [new TextRun({ text: value, bold: true, font: "Times New Roman", size: fs * 2 })] }));
  }

  for (const [heading, body, isRef] of [["Executive Summary", data.summary, false], ["Report", data.report, false], ["References", data.refs, true]]) {
    const ps = paragraphs(body);
    if (!ps.length) continue;
    children.push(new Paragraph({
      pageBreakBefore: true,
      alignment: alignment(data.align),
      spacing: { after: 200, line },
      children: [new TextRun({ text: heading, bold: true, font: "Times New Roman", size: (fs + 2) * 2 })]
    }));
    for (const p of ps) {
      children.push(new Paragraph({
        alignment: isRef ? AlignmentType.LEFT : AlignmentType.JUSTIFIED,
        spacing: { line, after: 200 },
        indent: isRef ? undefined : { firstLine: 720 },
        children: [new TextRun({ text: p, font: "Times New Roman", size: fs * 2 })]
      }));
    }
  }

  const doc = new Document({
    sections: [{
      properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1417, right: 1247, bottom: 1134, left: 1417 } } },
      children
    }]
  });
  return Packer.toBlob(doc);
}

export { UnoRoom };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/telegram" && request.method === "POST") {
      try {
        const update = await request.json();
        const result = await handleTelegramUpdate(env, update);
        return Response.json({ ok: true, result });
      } catch (error) {
        console.error("Telegram webhook error:", error);
        return Response.json(
          { ok: false, error: String(error?.message || error) },
          { status: 500 }
        );
      }
    }

    if (url.pathname === "/api/telegram/start" && request.method === "POST") {
      try {
        const body = await request.json().catch(() => ({}));
        return Response.json(await sendStartMessage(
          env,
          body.chatId,
          body.firstName || "there"
        ));
      } catch (error) {
        return Response.json({ error: String(error?.message || error) }, { status: 500 });
      }
    }

    if (url.pathname === "/api/setup" && request.method === "GET") {
      try {
        const webhook = await ensureTelegramWebhook(env);
        await configureTelegramCommands(env);
        const chatId = env?.TELEGRAM_STATUS_CHAT_ID;
        const token = env?.TELEGRAM_BOT_TOKEN;
        let testMessage = null;

        if (token && chatId) {
          const result = await sendTelegramStatus(
            env,
            "🧪 VYNTRO Telegram Test\\n\\nStatus: 🟢 Worker is responding\\nWebhook: ✅ Configured\\nCommands: ✅ Configured\\n\\nVYNTRO • Create. Play. Explore. 🚀"
          );
          testMessage = result;
        }

        return Response.json({
          ok: true,
          webhook,
          commands: true,
          testMessage: testMessage || { sent: false, reason: "missing_secrets" }
        });
      } catch (error) {
        return Response.json({
          ok: false,
          error: String(error?.message || error)
        }, { status: 500 });
      }
    }

        if (url.pathname === "/api/health" && request.method === "GET") {
      const info = versionInfo(env);
      return Response.json({
        service: "VYNTRO",
        status: "online",
        environment: "production",
        version: info,
        checkedAt: new Date().toISOString(),
        statusMonitorConfigured: Boolean(env?.TELEGRAM_BOT_TOKEN && env?.TELEGRAM_STATUS_CHAT_ID)
      }, {
        headers: { "Cache-Control": "no-store" }
      });
    }
    if (url.pathname === "/api/uno/create" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const playerId = await validateTelegramInitData(body.telegramInitData, env?.TELEGRAM_BOT_TOKEN);
      if (!playerId) return Response.json({ok:false,error:"Open UNO from Telegram."},{status:401});
      const code = roomCode();
      const id = env.UNO_ROOM_DO.idFromName(code);
      const stub = env.UNO_ROOM_DO.get(id);
      return stub.fetch("https://uno/create", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"create",code,playerId,name:body.name})});
    }
    if (url.pathname === "/api/uno/join" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const playerId = await validateTelegramInitData(body.telegramInitData, env?.TELEGRAM_BOT_TOKEN);
      if (!playerId || !body.code) return Response.json({ok:false,error:"Invalid Telegram session or room code."},{status:401});
      const code=String(body.code).trim().toUpperCase();
      const id=env.UNO_ROOM_DO.idFromName(code);
      const stub=env.UNO_ROOM_DO.get(id);
      return stub.fetch("https://uno/join",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"join",code,playerId,name:body.name})});
    }
    if (url.pathname === "/api/uno/action" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const playerId = await validateTelegramInitData(body.telegramInitData, env?.TELEGRAM_BOT_TOKEN);
      if (!playerId || !body.code) return Response.json({ok:false,error:"Invalid Telegram session."},{status:401});
      const id=env.UNO_ROOM_DO.idFromName(String(body.code).toUpperCase());
      const stub=env.UNO_ROOM_DO.get(id);
      return stub.fetch("https://uno/action",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...body,playerId,action:body.action})});
    }

    if (url.pathname === "/api/export" && request.method === "POST") {
      try {
        const data = await request.json();
        const type = data.type === "docx" ? "docx" : "pdf";
        const fileName = `${cleanName(data.title)}.${type}`;
        const mimeType = type === "pdf"
          ? "application/pdf"
          : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

        const bytes = type === "pdf"
          ? await makePDF(data)
          : await makeDOCX(data);

        // Telegram Mini Apps run inside a WebView where ordinary browser
        // download links are unreliable. When launched by Telegram, validate
        // initData server-side and deliver the generated file directly to the
        // authenticated user's bot chat.
        const telegramUserId = await validateTelegramInitData(
          data.telegramInitData,
          env?.TELEGRAM_BOT_TOKEN
        );

        if (telegramUserId) {
          await sendGeneratedDocumentToTelegram(
            env,
            telegramUserId,
            bytes,
            fileName,
            mimeType
          );
          return Response.json({
            ok: true,
            delivered: "telegram",
            fileName
          });
        }

        return new Response(bytes, {
          headers: {
            "Content-Type": mimeType,
            "Content-Disposition": `attachment; filename="${fileName}"`,
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*"
          }
        });
      } catch (error) {
        console.error("Export error:", error);
        return Response.json(
          { ok: false, error: String(error?.message || error) },
          { status: 500 }
        );
      }
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env) {
    try {
      await ensureTelegramWebhook(env);
      await runStatusCheck(env, controller.scheduledTime || Date.now());
    } catch (error) {
      console.error("VYNTRO status check failed:", error);
      controller.noRetry();
    }
  }
};
