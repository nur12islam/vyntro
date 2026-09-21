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

const XP_EVENTS = {
  daily_visit:{xp:10,label:"Daily Visit"}, play:{xp:10,label:"Play"}, win:{xp:50,label:"Win"},
  uno_win:{xp:100,label:"UNO Win"}, quiz_complete:{xp:25,label:"Quiz Complete"}, quiz_perfect:{xp:100,label:"Perfect Quiz"},
  puzzle_complete:{xp:30,label:"Puzzle Complete"}, reaction_record:{xp:30,label:"Reaction Record"},
  snake_10:{xp:50,label:"Snake 10+"}, snake_25:{xp:100,label:"Snake 25+"}, party:{xp:15,label:"Party Activity"},
  social_play:{xp:20,label:"Social Play"}
};
const ACHIEVEMENTS = {
  first_login:{title:"Welcome to VYNTRO",icon:"👋",xp:25}, first_game:{title:"First Play",icon:"🎮",xp:50},
  first_win:{title:"First Victory",icon:"🏆",xp:75}, explorer:{title:"Explorer",icon:"🧭",xp:100},
  quiz_hero:{title:"Quiz Hero",icon:"🧠",xp:100}, quiz_perfect:{title:"Perfect Score",icon:"🎯",xp:150},
  snake_10:{title:"Snake Tamer",icon:"🐍",xp:100}, snake_25:{title:"Snake Pro",icon:"⚡",xp:150},
  party_starter:{title:"Party Starter",icon:"🎉",xp:75}, social_butterfly:{title:"Social Butterfly",icon:"🦋",xp:150},
  night_owl:{title:"Night Owl",icon:"🌙",xp:75}, streak_3:{title:"3-Day Streak",icon:"🔥",xp:75}, streak_7:{title:"7-Day Streak",icon:"🔥",xp:150}
};
const LEVEL_NAMES=["Newcomer","Explorer","Player","Challenger","VYNTRO Veteran","VYNTRO Elite","VYNTRO Legend"];
function levelForXP(xp){let level=1,need=100,total=0;while(xp>=total+need){total+=need;level++;need=Math.round(need*1.35)}return level}
function levelName(level){return LEVEL_NAMES[Math.min(level-1,LEVEL_NAMES.length-1)]||"VYNTRO Legend"}

class VyntroGlobal extends DurableObject {
  constructor(state,env){super(state,env);this.state=state}
  async fetch(request){
    const body=await request.json().catch(()=>({}));
    if(body.action==="record"){
      const players=(await this.state.storage.get("players"))||{};
      const events=(await this.state.storage.get("events"))||[];
      const id=String(body.user?.id||""); if(!id)return Response.json({ok:false,error:"Missing user."},{status:400});
      const p=players[id]||{telegramId:id,firstName:"",username:"",xp:0,gamesPlayed:0,wins:0};
      p.firstName=body.user.first_name||p.firstName;p.username=body.user.username||p.username;p.xp=Number(body.totalXP||p.xp);p.gamesPlayed=Number(body.gamesPlayed||p.gamesPlayed);p.wins=Number(body.wins||p.wins);p.updatedAt=Date.now();
      players[id]=p;events.push({telegramId:id,firstName:p.firstName,username:p.username,xp:Number(body.xp||0),type:String(body.type||"event"),ts:Date.now()});
      while(events.length>10000)events.shift();await this.state.storage.put("players",players);await this.state.storage.put("events",events);return Response.json({ok:true});
    }
    const players=(await this.state.storage.get("players"))||{},events=(await this.state.storage.get("events"))||[],period=String(body.period||"all"),now=Date.now();
    const start=period==="daily"?now-86400000:period==="weekly"?now-7*86400000:period==="monthly"?now-30*86400000:0,scores={};
    if(period==="all"){for(const p of Object.values(players))scores[p.telegramId]={...p,score:p.xp}}
    else for(const e of events)if(e.ts>=start){if(!scores[e.telegramId])scores[e.telegramId]={telegramId:e.telegramId,firstName:e.firstName,username:e.username,score:0};scores[e.telegramId].score+=e.xp}
    const list=Object.values(scores).sort((a,b)=>b.score-a.score).slice(0,100).map((p,i)=>({...p,rank:i+1,level:levelForXP(p.score)}));
    return Response.json({ok:true,period,leaderboard:list});
  }
}

function telegramUserFromInitData(initData) {
  const params = new URLSearchParams(initData || "");
  const raw = params.get("user");
  if (!raw) return null;
  try {
    const u = JSON.parse(raw);
    return u?.id ? u : null;
  } catch (_) { return null; }
}

async function requireTelegramUser(request, env) {
  const initData = request.headers.get("X-Telegram-Init-Data") || "";
  const id = await validateTelegramInitData(initData, env?.TELEGRAM_BOT_TOKEN);
  if (!id) return null;
  return telegramUserFromInitData(initData);
}

class VyntroProfile extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.state = state;
  }

  async load(user) {
    let p = await this.state.storage.get("profile");
    if (!p) {
      p = {
        telegramId: String(user.id),
        firstName: user.first_name || "",
        lastName: user.last_name || "",
        username: user.username || "",
        languageCode: user.language_code || "",
        photoUrl: user.photo_url || "",
        xp: 25,
        level: 1,
        levelName: "Newcomer",
        gamesPlayed: 0,
        wins: 0,
        stats: {},
        lastEvents: {},
        activitiesTried: [],
        achievements: ["first_login"],
        streak: 1,
        lastActiveDate: new Date().toISOString().slice(0,10),
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      await this.state.storage.put("profile", p);
    } else {
      p.firstName = user.first_name || p.firstName;
      p.lastName = user.last_name || p.lastName;
      p.username = user.username || p.username;
      p.languageCode = user.language_code || p.languageCode;
      p.photoUrl = user.photo_url || p.photoUrl;
      p.updatedAt = Date.now();
      await this.state.storage.put("profile", p);
    }
    p.level = levelForXP(p.xp);
    p.levelName = levelName(p.level);
    return p;
  }

  async fetch(request) {
    const body = await request.json().catch(() => ({}));
    const user = body.user;
    if (!user?.id) return Response.json({ ok:false, error:"Missing Telegram user." }, {status:400});
    const p = await this.load(user);

    if (body.action === "award") {
      const key=String(body.achievement||""),a=ACHIEVEMENTS[key];
      if(!a)return Response.json({ok:false,error:"Unknown achievement."},{status:400});
      if(!p.achievements.includes(key)){p.achievements.push(key);p.xp+=a.xp;}
    }
    if(body.action==="event"){
      const type=String(body.type||""),event=XP_EVENTS[type];
      if(!event)return Response.json({ok:false,error:"Unknown XP event."},{status:400});
      const now=Date.now(),today=new Date(now).toISOString().slice(0,10),cooldown=type==="daily_visit"?86400000:(type==="party"||type==="social_play")?600000:0,last=Number(p.lastEvents[type]||0);
      if(!cooldown||now-last>=cooldown){
        p.xp+=event.xp;p.lastEvents[type]=now;p.stats[type]=(p.stats[type]||0)+1;
        if(type==="play")p.gamesPlayed++;if(type==="win"||type==="uno_win")p.wins++;
        const game=String(body.game||"");if(game&&!p.activitiesTried.includes(game))p.activitiesTried.push(game);
        if(p.lastActiveDate!==today){const prev=new Date(now-86400000).toISOString().slice(0,10);p.streak=p.lastActiveDate===prev?(p.streak||0)+1:1;p.lastActiveDate=today;}
      }
      const unlock=(key)=>{if(!p.achievements.includes(key)){p.achievements.push(key);p.xp+=ACHIEVEMENTS[key].xp}};
      if(type==="snake_10")unlock("snake_10");if(type==="snake_25")unlock("snake_25");
      if(type==="quiz_complete"||type==="quiz_perfect")unlock("quiz_hero");if(type==="quiz_perfect")unlock("quiz_perfect");
      if(type==="party"||type==="social_play")unlock("party_starter");
      if(p.gamesPlayed>=1)unlock("first_game");if(p.wins>=1)unlock("first_win");if(p.activitiesTried.length>=5)unlock("explorer");
      if(p.streak>=3)unlock("streak_3");if(p.streak>=7)unlock("streak_7");
      if(new Date(now).getHours()<5)unlock("night_owl");
    }

    p.level = levelForXP(p.xp);
    p.levelName = levelName(p.level);
    await this.state.storage.put("profile", p);
    return Response.json({ok:true,profile:p,achievements:ACHIEVEMENTS});
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
    this.sockets = new Map();
  }
  async load() {
    if (!this.room) this.room = await this.state.storage.get("room");
    return this.room;
  }
  async save() {
    await this.state.storage.put("room", this.room);
  }
  broadcast() {
    for (const [socket, playerId] of this.sockets) {
      try {
        socket.send(JSON.stringify({ type: "state", game: this.publicState(playerId) }));
      } catch (_) {
        this.sockets.delete(socket);
      }
    }
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
      winner: r.winner ?? null
    };
  }
  async fetch(request) {
    await this.load();
    const url = new URL(request.url);
    if (request.method === "GET" && request.headers.get("Upgrade") === "websocket") {
      const playerId = String(request.headers.get("X-Vyntro-Player") || "");
      if (!playerId || !this.room?.players?.some(p => p.id === playerId)) {
        return new Response("Unauthorized", { status: 401 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();
      this.sockets.set(server, playerId);
      server.addEventListener("close", () => this.sockets.delete(server));
      server.addEventListener("error", () => this.sockets.delete(server));
      server.send(JSON.stringify({ type: "state", game: this.publicState(playerId) }));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (request.method !== "POST") return Response.json({ ok: true, game: this.room });
    const body = await request.json().catch(() => ({}));
    const action = body.action;
    if (action === "create") {
      if (this.room) return Response.json({ ok: false, error: "Room already exists." }, { status: 409 });
      const player = { id: String(body.playerId), name: String(body.name || "Player").slice(0, 32), hand: [], connected: true };
      this.room = { code: String(body.code), players: [player], deck: [], discard: null, currentColor: null, turn: 0, direction: 1, started: false, winner: null };
      await this.save();
      this.broadcast();
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
      this.broadcast();
      return Response.json({ok:true,game:this.publicState(pid)});
    }
    if (idx < 0) return Response.json({ok:false,error:"Player is not in this room."},{status:403});
    if (action === "inviteCheck") {
      if (idx < 0) return Response.json({ ok: false, error: "Player is not in this room." }, { status: 403 });
      return Response.json({ ok: true });
    }
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
      this.broadcast();
      return Response.json({ok:true,game:this.publicState(pid)});
    }
    if (action === "draw") {
      if (!this.room.started || this.room.turn !== idx) return Response.json({ok:false,error:"Not your turn."},{status:409});
      if (!this.room.deck.length) this.rebuildDeck();
      this.room.players[idx].hand.push(this.room.deck.pop());
      this.advanceTurn(null);
      await this.save();
      this.broadcast();
      return Response.json({ok:true,game:this.publicState(pid)});
    }
    if (action === "uno") {
      if (this.room.players[idx].hand.length === 1) this.room.uno=idx;
      await this.save();
      this.broadcast();
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
    if (card?.v === "reverse") {
      this.room.direction *= -1;
      step = this.room.direction;
    }
    if (card?.v === "skip") step *= 2;
    this.room.turn = (this.room.turn + step + this.room.players.length) % this.room.players.length;
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


function humanizerChunks(text, maxChars = 6500) {
  const paras = String(text || "").replace(/\r/g, "").split(/\n\s*\n/).map(x => x.trim()).filter(Boolean);
  const chunks = [];
  let current = "";
  const push = value => { if (value) chunks.push(value); };

  const addPiece = piece => {
    const p = String(piece || "").trim();
    if (!p) return;
    if ((current ? current.length + 2 : 0) + p.length <= maxChars) current += (current ? "\n\n" : "") + p;
    else { push(current); current = p; }
  };

  for (const para of paras) {
    if (para.length <= maxChars) { addPiece(para); continue; }
    const sentences = para.split(/(?<=[.!?])\s+/);
    let piece = "";
    for (const sentence of sentences) {
      if (!sentence) continue;
      if (sentence.length > maxChars) {
        const words = sentence.split(/\s+/);
        let small = "";
        for (const word of words) {
          if ((small ? small.length + 1 : 0) + word.length <= maxChars) small += (small ? " " : "") + word;
          else { addPiece(small); small = word; }
        }
        addPiece(small);
        continue;
      }
      if ((piece ? piece.length + 1 : 0) + sentence.length <= maxChars) piece += (piece ? " " : "") + sentence;
      else { addPiece(piece); piece = sentence; }
    }
    addPiece(piece);
  }
  push(current);
  return chunks;
}

function humanizerProtect(text) {
  const kept = [];
  const patterns = [
    /\[[^\]]{1,180}\]\([^\)]{1,500}\)/g,
    /https?:\/\/[^\s<>"']+/gi,
    /\([^\n()]{0,100}\b(?:19|20)\d{2}[a-z]?[^\n()]{0,80}\)/gi,
    /“[^”\n]{1,500}”/g,
    /"[^"\n]{1,500}"/g
  ];
  let out = String(text || "");
  for (const re of patterns) out = out.replace(re, match => {
    const token = `⟦VYNTRO_KEEP_${kept.length}⟧`;
    kept.push(match);
    return token;
  });
  return { text: out, kept };
}

function humanizerRestore(text, kept) {
  let out = String(text || "");
  kept.forEach((value, i) => { out = out.replaceAll(`⟦VYNTRO_KEEP_${i}⟧`, value); });
  return out;
}

async function humanizerCall(env, system, user, providerHint = "") {
  const groq = env?.GROQ_API_KEY;
  const openrouter = env?.OPENROUTER_API_KEY;
  const order = providerHint === "OpenRouter" ? ["OpenRouter","Groq"] : ["Groq","OpenRouter"];
  let lastError = "";
  for (const provider of order) {
    if (provider === "Groq" && !groq) continue;
    if (provider === "OpenRouter" && !openrouter) continue;
    const response = provider === "Groq"
      ? await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method:"POST",
          headers:{"Content-Type":"application/json","Authorization":`Bearer ${groq}`},
          body:JSON.stringify({model:"openai/gpt-oss-120b",temperature:.55,messages:[{role:"system",content:system},{role:"user",content:user}]})
        })
      : await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method:"POST",
          headers:{"Content-Type":"application/json","Authorization":`Bearer ${openrouter}`,"HTTP-Referer":"https://vyntro.xark0047.workers.dev","X-Title":"VYNTRO Humanize"},
          body:JSON.stringify({model:"openrouter/free",temperature:.55,messages:[{role:"system",content:system},{role:"user",content:user}]})
        });
    if (response.ok) {
      const data = await response.json();
      const content = String(data?.choices?.[0]?.message?.content || "").trim();
      if (content) return {content,provider};
      lastError = provider + " returned an empty response.";
    } else {
      lastError = provider + " request failed: " + response.status;
      await response.text().catch(()=>{});
    }
  }
  throw new Error(lastError || "No AI provider is configured.");
}

function humanizerLocalGuard(original, rewritten, options = {}) {
  const source = String(original || "");
  const output = String(rewritten || "");
  const issues = [];
  if (!output.trim()) issues.push("empty_output");

  const urls = source.match(/https?:\/\/[^\s<>"')]+/gi) || [];
  const emails = source.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  const years = source.match(/\b(?:19|20)\d{2}\b/g) || [];
  const importantNumbers = source.match(/\b\d+(?:[.,]\d+)?%?\b/g) || [];
  const mustKeep = options.preserveCitations !== false ? [...urls, ...emails, ...years] : [];

  for (const token of mustKeep) {
    if (!output.includes(token)) issues.push("missing:" + token);
  }

  const sourceNumbers = new Set(importantNumbers);
  const outputNumbers = new Set(output.match(/\b\d+(?:[.,]\d+)?%?\b/g) || []);
  for (const token of sourceNumbers) {
    if (!outputNumbers.has(token) && !mustKeep.includes(token)) {
      issues.push("changed_number:" + token);
    }
  }

  const sourceWords = source.trim() ? source.trim().split(/\\s+/).length : 0;
  const outputWords = output.trim() ? output.trim().split(/\\s+/).length : 0;
  const ratio = sourceWords ? outputWords / sourceWords : 1;
  if (ratio < 0.45 || ratio > 1.8) issues.push("large_length_change");

  return {
    ok: issues.length === 0,
    issues: issues.slice(0, 12),
    sourceWords,
    outputWords,
    lengthRatio: Number(ratio.toFixed(3))
  };
}

async function humanizeLongText(env, text, options) {
  const chunks = humanizerChunks(text, 6000);
  if (!chunks.length) throw new Error("No text supplied.");

  const styleMap = {
    natural: "natural and genuinely readable, with a relaxed but controlled human voice",
    academic: "academic but not formulaic, like a thoughtful student or researcher explaining ideas in their own words",
    professional: "professional, direct and polished without sounding corporate or templated",
    conversational: "warm, conversational and clear, as if one person is naturally explaining the subject to another",
    clear: "plain, precise and easy to follow, with unnecessary wording removed"
  };
  const depthMap = {
    light: "Make restrained edits. Keep the original wording where it already works, but fix stiffness, repetition and awkward phrasing.",
    balanced: "Rewrite at the sentence level where useful. Vary sentence openings, lengths and structures, and replace generic phrasing with wording that fits the actual context.",
    deep: "Rework sentence structure and paragraph flow substantially where it improves the writing. Keep the ideas, facts and intended meaning intact."
  };
  const lengthMap = {
    preserve: "Keep roughly the same information density and overall length. Do not compress simply to make the prose shorter.",
    shorter: "Make it modestly shorter by removing repetition and unnecessary padding while keeping every important idea.",
    longer: "Make it modestly more developed only where the existing idea benefits from clarification. Do not introduce new facts."
  };

  const style = styleMap[options.style] || styleMap.natural;
  const styleSample = String(options.styleSample || "").trim().slice(0, 5000);
  const depth = depthMap[options.depth] || depthMap.balanced;
  const length = lengthMap[options.length] || lengthMap.preserve;
  let previousTail = "";
  const output = [];
  let provider = "";

  for (let i = 0; i < chunks.length; i++) {
    const protectedChunk = options.preserveCitations
      ? humanizerProtect(chunks[i])
      : { text: chunks[i], kept: [] };

    const system = `You are VYNTRO Humanize, an advanced long-form writing editor.

Rewrite the supplied source into ${style}.

Editing approach:
- ${depth}
- ${length}
- Preserve the author's actual meaning, facts, names, dates, numbers and level of certainty.
- Do not invent examples, evidence, sources, quotations, statistics or personal experiences.
- Do not deliberately insert errors, slang, filler or fake "human" quirks.
- Prefer specific wording that follows naturally from the source instead of generic academic filler.
- Avoid stock constructions when a simpler sentence works. In particular, do not repeatedly rely on phrases such as "it is important to note", "therefore", "moreover", "in today's world", "plays a crucial role", "it is essential", or "in conclusion" unless the source genuinely needs them.
- Vary sentence openings and rhythm. Mix short, medium and longer sentences naturally.
- Do not make every sentence perfectly symmetrical or equally polished.
- Keep transitions meaningful rather than adding transition words just to connect sentences.
- Keep first-person or impersonal voice consistent with the source; do not invent a personal voice.
- If the source already sounds natural, preserve parts of it instead of rewriting everything.
${styleSample ? `- Use the user sample below only as a voice reference. Do not copy its wording, facts or ideas; imitate only stylistic tendencies such as rhythm, formality and sentence preference.\nUSER STYLE SAMPLE:\n${styleSample}` : ""}
- Return ONLY the rewritten passage. No explanation, heading, label or preface.
${options.preserveParagraphs ? "- Preserve the paragraph order and blank-line boundaries." : "- You may adjust paragraph boundaries when it clearly improves readability."}
${options.preserveCitations ? "- Protected tokens such as ⟦VYNTRO_KEEP_0⟧ must be reproduced exactly and in the same logical location." : ""}`;

    const context = previousTail
      ? `The previous section ended with this excerpt:
${previousTail}

Continue from the source naturally. Do not repeat the previous section or add a new conclusion simply because this is a chunk.`
      : "";

    const result = await humanizerCall(env, system, context + (context ? "\n\n" : "") + protectedChunk.text, provider || "");
    provider = result.provider;

    let rewritten = humanizerRestore(result.content, protectedChunk.kept)
      .replace(/^["“]|["”]$/g, "")
      .trim();

    // A second editorial pass is reserved for Deep mode. It is framed as
    // an editor's pass rather than a detector-oriented transformation.
    if (options.depth === "deep") {
      const polishSystem = `Act as a careful human editor. Improve the supplied rewritten passage for ${style}.
Keep every factual claim, citation, number and quotation unchanged. Remove generic, repetitive or overly polished phrasing where it hurts natural readability. Vary sentence rhythm when useful. Do not add information. Return only the edited passage.`;
      const polished = await humanizerCall(env, polishSystem, rewritten, provider);
      provider = polished.provider;
      rewritten = humanizerRestore(polished.content, protectedChunk.kept)
        .replace(/^["“]|["”]$/g, "")
        .trim();
    }

    output.push(rewritten);
    previousTail = rewritten.slice(-700);
  }

  return {
    text: output.join(options.preserveParagraphs ? "\n\n" : "\n"),
    chunks: chunks.length,
    provider
  };
}

export { UnoRoom, VyntroProfile, VyntroGlobal };

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
    if (url.pathname === "/api/uno/invite" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const playerId = await validateTelegramInitData(body.telegramInitData, env?.TELEGRAM_BOT_TOKEN);
      const code = String(body.code || "").trim().toUpperCase();
      if (!playerId || !/^[A-Z2-9]{5}$/.test(code)) {
        return Response.json({ ok: false, error: "Invalid Telegram session or room code." }, { status: 401 });
      }

      const roomId = env.UNO_ROOM_DO.idFromName(code);
      const roomStub = env.UNO_ROOM_DO.get(roomId);
      const roomResponse = await roomStub.fetch("https://uno/invite-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "inviteCheck", playerId })
      });
      if (!roomResponse.ok) {
        return Response.json({ ok: false, error: "UNO room not found or you are not a player in it." }, { status: 404 });
      }

      const token = env?.TELEGRAM_BOT_TOKEN;
      if (!token) return Response.json({ ok: false, error: "Telegram bot is not configured." }, { status: 500 });

      const meResponse = await fetch(`${TELEGRAM_API}/bot${token}/getMe`);
      if (!meResponse.ok) return Response.json({ ok: false, error: "Could not resolve the VYNTRO bot username." }, { status: 502 });
      const meData = await meResponse.json();
      const username = meData?.result?.username;
      if (!username) return Response.json({ ok: false, error: "VYNTRO bot username is unavailable." }, { status: 502 });

      return Response.json({
        ok: true,
        code,
        url: `https://t.me/${username}?startapp=uno_${code}`
      });
    }
    if (url.pathname === "/api/uno/ws" && request.method === "GET") {
      const playerId = await validateTelegramInitData(
        url.searchParams.get("initData") || "",
        env?.TELEGRAM_BOT_TOKEN
      );
      const code = String(url.searchParams.get("code") || "").trim().toUpperCase();
      if (!playerId || !/^[A-Z2-9]{5}$/.test(code)) {
        return new Response("Unauthorized", { status: 401 });
      }
      const id = env.UNO_ROOM_DO.idFromName(code);
      const stub = env.UNO_ROOM_DO.get(id);
      const headers = new Headers(request.headers);
      headers.set("X-Vyntro-Player", playerId);
      return stub.fetch("https://uno/ws", { method: "GET", headers });
    }
    if (url.pathname === "/api/uno/action" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const playerId = await validateTelegramInitData(body.telegramInitData, env?.TELEGRAM_BOT_TOKEN);
      if (!playerId || !body.code) return Response.json({ok:false,error:"Invalid Telegram session."},{status:401});
      const id=env.UNO_ROOM_DO.idFromName(String(body.code).toUpperCase());
      const stub=env.UNO_ROOM_DO.get(id);
      return stub.fetch("https://uno/action",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...body,playerId,action:body.action})});
    }

    if (url.pathname === "/api/profile" && request.method === "GET") {
      const user = await requireTelegramUser(request, env);
      if (!user) return Response.json({ok:false,error:"Telegram authentication required."},{status:401});
      const id = env.VYNTRO_PROFILE_DO.idFromName(String(user.id));
      const stub = env.VYNTRO_PROFILE_DO.get(id);
      const response = await stub.fetch("https://profile/", {method:"POST",body:JSON.stringify({user})});
      const data = await response.json();
      if (!data.ok) return Response.json(data, {status: response.status});
      const global = env.VYNTRO_GLOBAL_DO.get(env.VYNTRO_GLOBAL_DO.idFromName("global"));
      await global.fetch("https://global/", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          action:"record",
          user,
          totalXP:data.profile.xp,
          gamesPlayed:data.profile.gamesPlayed,
          wins:data.profile.wins,
          xp:0,
          type:"profile_sync"
        })
      });
      return Response.json(data);
    }

    if (url.pathname === "/api/progression/event" && request.method === "POST") {
      const user=await requireTelegramUser(request,env);if(!user)return Response.json({ok:false,error:"Telegram authentication required."},{status:401});
      const body=await request.json().catch(()=>({})),id=env.VYNTRO_PROFILE_DO.idFromName(String(user.id)),stub=env.VYNTRO_PROFILE_DO.get(id);
      const response=await stub.fetch("https://profile/",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({user,action:"event",type:body.type,game:body.game})});
      const data=await response.json();if(!data.ok)return Response.json(data,{status:response.status});
      const global=env.VYNTRO_GLOBAL_DO.get(env.VYNTRO_GLOBAL_DO.idFromName("global")),xpEvent=XP_EVENTS[String(body.type||"")];
      await global.fetch("https://global/",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"record",user,totalXP:data.profile.xp,gamesPlayed:data.profile.gamesPlayed,wins:data.profile.wins,xp:xpEvent?.xp||0,type:body.type})});
      return Response.json(data);
    }
    if (url.pathname === "/api/leaderboard" && request.method === "GET") {
      const period=String(url.searchParams.get("period")||"all"),global=env.VYNTRO_GLOBAL_DO.get(env.VYNTRO_GLOBAL_DO.idFromName("global"));
      return global.fetch("https://global/",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"leaderboard",period})});
    }

    if (url.pathname === "/api/achievement" && request.method === "POST") {
      const user = await requireTelegramUser(request, env);
      if (!user) return Response.json({ok:false,error:"Telegram authentication required."},{status:401});
      const body = await request.json().catch(() => ({}));
      const id = env.VYNTRO_PROFILE_DO.idFromName(String(user.id));
      const stub = env.VYNTRO_PROFILE_DO.get(id);
      return stub.fetch("https://profile/", {method:"POST",body:JSON.stringify({user,action:"award",achievement:body.achievement})});
    }


    if (url.pathname === "/api/humanize" && request.method === "POST") {
      try {
        const user = await requireTelegramUser(request, env);
        if (!user) return Response.json({ok:false,error:"Open VYNTRO inside Telegram to use the protected AI service."},{status:401});
        const body = await request.json().catch(() => ({}));
        const text = String(body.text || "").replace(/\r/g, "").trim();
        if (!text) return Response.json({ok:false,error:"Paste some text first."},{status:400});
        if (text.length > 80000) return Response.json({ok:false,error:"This run supports up to 80,000 characters. Split a larger document into sections."},{status:413});
        const result = await humanizeLongText(env, text, {
          style:String(body.style || "natural"),
          depth:String(body.depth || "balanced"),
          length:String(body.length || "preserve"),
          preserveCitations:body.preserveCitations !== false,
          preserveParagraphs:body.preserveParagraphs !== false,
          styleSample:String(body.styleSample || "")
        });
        const quality = humanizerLocalGuard(text, result.text, {
          preserveCitations:body.preserveCitations !== false
        });
        return Response.json({ok:true,...result,quality,inputCharacters:text.length});
      } catch (error) {
        console.error("Humanizer error:", error);
        return Response.json({ok:false,error:String(error?.message || error)},{status:500});
      }
    }

    if (url.pathname === "/api/ai" && request.method === "POST") {
      try {
        const body = await request.json().catch(() => ({}));
        const prompt = String(body.prompt || "").trim().slice(0, 4000);
        if (!prompt) return Response.json({ ok:false, error:"Ask VYNTRO something first." }, { status:400 });
        const groq = env?.GROQ_API_KEY;
        const openrouter = env?.OPENROUTER_API_KEY;
        if (!groq && !openrouter) return Response.json({ok:false,error:"VYNTRO AI is not configured."},{status:503});
        const system = "You are VYNTRO AI inside a Telegram mini app. Reply concisely and warmly. You can recommend or launch VYNTRO destinations. If the user asks to play a game, quiz, puzzle, party activity, or use Report Writer, return a short helpful message and a machine-readable action on a separate line in exactly this format: ACTION: {\"type\":\"open\",\"path\":\"./.../\"}. Valid paths include ./games/uno/, ./games/snake/, ./games/2048/, ./games/tic-tac-toe/, ./activities/quiz-arena/, ./party/, ./puzzles/, ./utilities/report-writer/. Otherwise omit ACTION.";
        let response, provider;
        if (groq) {
          provider="Groq";
          response=await fetch("https://api.groq.com/openai/v1/chat/completions",{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${groq}`},body:JSON.stringify({model:"openai/gpt-oss-120b",temperature:.6,messages:[{role:"system",content:system},{role:"user",content:prompt}]})});
        } else {
          provider="OpenRouter";
          response=await fetch("https://openrouter.ai/api/v1/chat/completions",{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${openrouter}`,"HTTP-Referer":"https://vyntro.xark0047.workers.dev","X-Title":"VYNTRO AI"},body:JSON.stringify({model:"openrouter/free",temperature:.6,messages:[{role:"system",content:system},{role:"user",content:prompt}]})});
        }
        if (!response.ok) { const t=await response.text(); return Response.json({ok:false,error:`${provider} request failed: ${response.status} ${t.slice(0,180)}`},{status:502}); }
        const data=await response.json();
        const raw=String(data?.choices?.[0]?.message?.content||"");
        if(!raw) return Response.json({ok:false,error:"AI returned an empty response."},{status:502});
        const m=raw.match(/ACTION:\s*(\{.*\})\s*$/s);
        let reply=raw, action=null;
        if(m){ try { action=JSON.parse(m[1]); reply=raw.slice(0,m.index).trim(); } catch(_){} }
        return Response.json({ok:true,provider,reply,action});
      } catch(error) {
        return Response.json({ok:false,error:String(error?.message||error)},{status:500});
      }
    }

    if (url.pathname === "/api/quiz" && request.method === "POST") {
      try {
        const body = await request.json().catch(() => ({}));
        const topic = String(body.topic || "General Knowledge").slice(0, 120);
        const difficulty = String(body.difficulty || "Medium").slice(0, 20);
        const count = Math.max(1, Math.min(15, Number(body.count) || 10));
        const groq = env?.GROQ_API_KEY;
        const openrouter = env?.OPENROUTER_API_KEY;
        if (!groq && !openrouter) return Response.json({ok:false,error:"Quiz AI is not configured. Add GROQ_API_KEY or OPENROUTER_API_KEY to Worker secrets."},{status:503});
        const prompt = `Create a ${difficulty} multiple-choice quiz about "${topic}". Return ONLY valid JSON in this exact shape: {"questions":[{"question":"...","options":["A","B","C","D"],"answer":0}]}. Generate exactly ${count} questions. Each must have exactly 4 distinct options and answer must be the zero-based index of the one correct option. No markdown.`;
        let response, provider;
        if (groq) {
          provider="Groq";
          response=await fetch("https://api.groq.com/openai/v1/chat/completions",{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${groq}`},body:JSON.stringify({model:"openai/gpt-oss-120b",temperature:.7,response_format:{type:"json_object"},messages:[{role:"system",content:"You generate accurate, concise quizzes."},{role:"user",content:prompt}]})});
        } else {
          provider="OpenRouter";
          response=await fetch("https://openrouter.ai/api/v1/chat/completions",{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${openrouter}`,"HTTP-Referer":"https://vyntro.xark0047.workers.dev","X-Title":"VYNTRO Quiz Arena"},body:JSON.stringify({model:"openrouter/free",temperature:.7,messages:[{role:"system",content:"You generate accurate, concise quizzes."},{role:"user",content:prompt}]})});
        }
        if(!response.ok){const t=await response.text();return Response.json({ok:false,error:`${provider} request failed: ${response.status} ${t.slice(0,200)}`},{status:502});}
        const data=await response.json();
        let raw=String(data?.choices?.[0]?.message?.content||"").trim();
        if(!raw) return Response.json({ok:false,error:"Quiz AI returned an empty response."},{status:502});
        raw=raw.replace(/^\`\`\`json\s*/i,"").replace(/^\`\`\`\s*/,"").replace(/\s*\`\`\`$/,"").trim();

        let quiz;
        try {
          quiz=JSON.parse(raw);
        } catch (_) {
          const match=raw.match(/\{[\s\S]*\}/);
          if(!match) return Response.json({ok:false,error:"Quiz AI returned invalid JSON."},{status:502});
          try { quiz=JSON.parse(match[0]); }
          catch (error) { return Response.json({ok:false,error:"Quiz AI returned invalid JSON."},{status:502}); }
        }

        if(!Array.isArray(quiz?.questions) || quiz.questions.length!==count){
          return Response.json({ok:false,error:"Quiz AI returned an invalid question count."},{status:502});
        }

        const questions=quiz.questions.map((q,index)=>{
          const question=String(q?.question||"").trim();
          const options=Array.isArray(q?.options)?q.options.map(x=>String(x??"").trim()).slice(0,4):[];
          const answer=Number(q?.answer);
          if(!question || options.length!==4 || options.some(x=>!x) || !Number.isInteger(answer) || answer<0 || answer>3){
            throw new Error("invalid_question_"+index);
          }
          return {question,options,answer};
        });

        return Response.json({ok:true,provider,questions});
      } catch(error) {
        return Response.json({ok:false,error:String(error?.message||error)},{status:500});
      }
    }

    if (url.pathname === "/api/export" && request.method === "POST") {
      try {
        const body = await request.json().catch(() => ({}));
        const type = String(body.type || "").toLowerCase();
        if (!["pdf","docx"].includes(type)) {
          return Response.json({ok:false,error:"Choose PDF or DOCX."},{status:400});
        }

        const data = {
          title:String(body.title||""),
          assessment:String(body.assessment||""),
          department:String(body.department||""),
          university:String(body.university||""),
          student:String(body.student||""),
          semester:String(body.semester||""),
          align:String(body.align||"left"),
          fontSize:Number(body.fontSize)||12,
          lineSpacing:Number(body.lineSpacing)||2,
          summary:String(body.summary||""),
          report:String(body.report||""),
          refs:String(body.refs||"")
        };

        const fileName = cleanName(data.title) + "." + type;
        const mimeType = type === "pdf"
          ? "application/pdf"
          : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

        let bytes;
        if (type === "pdf") {
          bytes = await makePDF(data);
        } else {
          const docBlob = await makeDOCX(data);
          bytes = new Uint8Array(await docBlob.arrayBuffer());
        }

        const telegramUserId = await validateTelegramInitData(
          String(body.telegramInitData||""),
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
            ok:true,
            delivered:"telegram",
            fileName
          });
        }

        return new Response(bytes, {
          headers: {
            "Content-Type": mimeType,
            "Content-Disposition": `attachment; filename="${fileName}"`,
            "Cache-Control":"no-store",
            "Access-Control-Allow-Origin":"*"
          }
        });
      } catch(error) {
        console.error("Export error:",error);
        return Response.json(
          {ok:false,error:String(error?.message||error)},
          {status:500}
        );
      }
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env) {
    try {
      await ensureTelegramWebhook(env);
      await runStatusCheck(env, controller.scheduledTime || Date.now());
    } catch(error) {
      console.error("VYNTRO status check failed:",error);
      controller.noRetry();
    }
  }
};
