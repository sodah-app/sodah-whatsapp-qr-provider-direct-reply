const pino = require("pino");
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const { generateReply } = require("./ai");
const { getBusinessById, saveMessage, upsertCustomer } = require("./supabase");

const processed = new Map();
const ttlMs = Number(process.env.MESSAGE_DEDUP_TTL_SECONDS || 120) * 1000;

function rememberMessage(id) {
  if (!id) return false;

  const now = Date.now();
  const existing = processed.get(id);

  if (existing && now - existing < ttlMs) {
    return true;
  }

  processed.set(id, now);

  if (processed.size > 5000) {
    for (const [key, time] of processed) {
      if (now - time > ttlMs) processed.delete(key);
    }
  }

  return false;
}

function phoneFromJid(jid) {
  return String(jid || "")
    .split("@")[0]
    .split(":")[0]
    .replace(/\D/g, "");
}

function extractText(message) {
  return (
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption ||
    message?.documentMessage?.caption ||
    ""
  ).trim();
}

function shouldIgnore(remoteJid, fromMe) {
  if (String(process.env.IGNORE_FROM_ME || "true").toLowerCase() === "true" && fromMe) {
    return "from_me";
  }

  if (String(process.env.IGNORE_STATUS || "true").toLowerCase() === "true" &&
      remoteJid === "status@broadcast") {
    return "status";
  }

  if (String(process.env.IGNORE_GROUPS || "true").toLowerCase() === "true" &&
      remoteJid.endsWith("@g.us")) {
    return "group";
  }

  return "";
}

async function handleIncomingMessage({ session, message, socket }) {
  const remoteJid = message?.key?.remoteJid || "";
  const fromMe = Boolean(message?.key?.fromMe);
  const messageId = message?.key?.id || "";

  const ignored = shouldIgnore(remoteJid, fromMe);
  if (ignored) return { ignored };

  const text = extractText(message?.message);
  if (!text) return { ignored: "empty_message" };

  if (rememberMessage(messageId)) {
    logger.info({ messageId }, "Duplicate message ignored.");
    return { ignored: "duplicate" };
  }

  const customerPhone = phoneFromJid(remoteJid);

  logger.info({
    sessionId: session.sessionId,
    businessId: session.businessId,
    customerPhone,
    messageId,
    text
  }, "Incoming WhatsApp message.");

  await saveMessage({
    business_id: session.businessId,
    session_id: session.sessionId,
    message_id: messageId,
    direction: "inbound",
    phone_number: customerPhone,
    message_text: text,
    created_at: new Date().toISOString()
  });

  await upsertCustomer({
    business_id: session.businessId,
    phone_number: customerPhone,
    updated_at: new Date().toISOString()
  });

  let business = null;

  try {
    business = await getBusinessById(session.businessId);
  } catch (error) {
    logger.error({
      businessId: session.businessId,
      error: error.message
    }, "Business lookup failed.");
  }

  if (!business) {
    logger.error({
      businessId: session.businessId
    }, "No business configuration found. Reply not sent.");

    return {
      ok: false,
      error: "business_not_found"
    };
  }

  let reply;

  try {
    const result = await generateReply({
      business,
      customerPhone,
      messageText: text
    });

    reply = result.reply;
  } catch (error) {
    logger.error({
      businessId: session.businessId,
      error: error.message
    }, "AI reply generation failed.");

    reply = process.env.FALLBACK_REPLY ||
      "Thanks for your message. We received it and will get back to you shortly.";
  }

  if (!reply) {
    return { ok: false, error: "empty_reply" };
  }

  const sent = await socket.sendMessage(remoteJid, { text: reply });

  await saveMessage({
    business_id: session.businessId,
    session_id: session.sessionId,
    message_id: sent?.key?.id || null,
    direction: "outbound",
    phone_number: customerPhone,
    message_text: reply,
    created_at: new Date().toISOString()
  });

  logger.info({
    sessionId: session.sessionId,
    businessId: session.businessId,
    customerPhone,
    messageId: sent?.key?.id || null
  }, "WhatsApp reply sent.");

  return {
    ok: true,
    reply,
    messageId: sent?.key?.id || null
  };
}

module.exports = {
  handleIncomingMessage
};
