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
    if (url.pathname === "/api/export" && request.method === "POST") {
      try {
        const data = await request.json();
        const type = data.type === "docx" ? "docx" : "pdf";
        if (type === "pdf") {
          const bytes = await makePDF(data);
          return new Response(bytes, { headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="${cleanName(data.title)}.pdf"`,
            "Cache-Control": "no-store"
          }});
        }
        const blob = await makeDOCX(data);
        return new Response(blob, { headers: {
          "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "Content-Disposition": `attachment; filename="${cleanName(data.title)}.docx"`,
          "Cache-Control": "no-store"
        }});
      } catch (error) {
        return Response.json({ error: String(error?.message || error) }, { status: 500 });
      }
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env) {
    try {
      await runStatusCheck(env, controller.scheduledTime || Date.now());
    } catch (error) {
      console.error("VYNTRO status check failed:", error);
      controller.noRetry();
    }
  }
};
