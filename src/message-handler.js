
const pino = require("pino");

const logger = pino({
  level: process.env.LOG_LEVEL || "info"
});

const { generateReply } = require("./ai");

const {
  getBusinessById,
  getBusinessCatalog,
  getProductImageUrl,
  getPromotionsForCustomerIntro,
  markPromotionIntroduced,
  loadConversationHistory,
  saveConversationMessage,
  getSentMediaImageKeys,
  claimMediaImage,
  finishMediaImage,
  getConversationControl,
  setConversationControl,
  saveMessage,
  upsertCustomer,
  reserveSubscriptionExpiryReminder
} = require("./supabase");

/* =========================================================
   MESSAGE DEDUPLICATION
========================================================= */

const processed = new Map();
const automatedMessageIds = new Set();

const ttlMs =
  Number(process.env.MESSAGE_DEDUP_TTL_SECONDS || 120) *
  1000;

function rememberMessage(id) {
  if (!id) return;

  processed.set(id, Date.now());

  if (processed.size > 5000) {
    const now = Date.now();

    for (const [key, timestamp] of processed.entries()) {
      if (now - timestamp > ttlMs) {
        processed.delete(key);
      }
    }
  }
}

function markAutomatedMessage(result) {
  const id = result?.key?.id;
  if (!id) return result;
  automatedMessageIds.add(id);
  if (automatedMessageIds.size > 5000) {
    automatedMessageIds.delete(automatedMessageIds.values().next().value);
  }
  return result;
}

function wasAutomatedMessage(messageId) {
  if (!messageId || !automatedMessageIds.has(messageId)) return false;
  automatedMessageIds.delete(messageId);
  return true;
}

/* =========================================================
   PHONE
========================================================= */

function phoneFromJid(jid) {
  const value = String(jid || "").trim();

  if (!value) return "";

  return value
    .split("@")[0]
    .split(":")[0]
    .replace(/\D/g, "");
}

function toWhatsAppJid(phone) {
  const normalized = phoneFromJid(phone);

  return normalized
    ? `${normalized}@s.whatsapp.net`
    : "";
}

/* =========================================================
   CUSTOMER NAME
========================================================= */

function extractCustomerName(message) {
  const candidates = [
    message?.pushName,
    message?.verifiedBizName,
    message?.key?.pushName
  ];

  for (const value of candidates) {
    const name = String(value || "").trim();

    if (name) return name.slice(0, 120);
  }

  return "";
}

/* =========================================================
   TEXT EXTRACTION
========================================================= */

function extractText(message) {
  const m = message?.message || {};

  return String(
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    ""
  ).trim();
}

/* =========================================================
   IGNORE RULES
========================================================= */

function shouldIgnore(remoteJid, fromMe) {
  if (fromMe) return true;
  if (!remoteJid) return true;
  if (remoteJid === "status@broadcast") return true;
  if (remoteJid.endsWith("@g.us")) return true;

  return false;
}

/* =========================================================
   SUBSCRIPTION VALIDATION
========================================================= */

function getSubscriptionState(business) {
  const status = String(
    business?.subscription_status || ""
  )
    .trim()
    .toLowerCase();

  const expiryValue = business?.subscription_expiry;

  const expiryTime = expiryValue
    ? new Date(expiryValue).getTime()
    : NaN;

  const validExpiry = Number.isFinite(expiryTime);

  const active =
    status === "active" &&
    validExpiry &&
    expiryTime > Date.now();

  return {
    active,
    status,
    expiryTime: validExpiry ? expiryTime : null,
    expiry: expiryValue || null
  };
}

/* =========================================================
   SUBSCRIPTION EXPIRY REMINDER
========================================================= */

async function handleExpiredSubscription({
  business,
  businessId,
  socket
}) {
  const state = getSubscriptionState(business);

  logger.warn(
    {
      businessId,
      subscriptionStatus: state.status,
      subscriptionExpiry: state.expiry
    },
    "AI automation blocked because the subscription is inactive or expired."
  );

  /*
   * Prefer the support number as the owner notification
   * destination. It must be a separate, reachable phone
   * number rather than the connected sending account.
   */
  const recipientPhone = phoneFromJid(
    business?.support_number || ""
  );

  const connectedPhone = phoneFromJid(
    business?.ai_number || ""
  );

  if (!recipientPhone) {
    logger.warn(
      { businessId },
      "Subscription reminder skipped: support_number is missing."
    );

    return {
      ok: false,
      reason: "subscription_expired",
      reminder: "no_recipient"
    };
  }

  if (
    connectedPhone &&
    recipientPhone === connectedPhone
  ) {
    logger.warn(
      { businessId },
      "Subscription reminder skipped: support_number matches ai_number."
    );

    return {
      ok: false,
      reason: "subscription_expired",
      reminder: "recipient_is_connected_number"
    };
  }

  if (
    typeof reserveSubscriptionExpiryReminder !== "function"
  ) {
    logger.error(
      { businessId },
      "Reminder reservation function is unavailable."
    );

    return {
      ok: false,
      reason: "subscription_expired",
      reminder: "reservation_unavailable"
    };
  }

  /*
   * The database function atomically reserves one of the
   * two reminder slots in the preceding 24 hours.
   */
  let reserved;

  try {
    reserved = await reserveSubscriptionExpiryReminder({
      businessId,
      recipientPhone
    });
  } catch (error) {
    logger.error(
      {
        businessId,
        error: error.message
      },
      "Could not reserve subscription expiry reminder."
    );

    return {
      ok: false,
      reason: "subscription_expired",
      reminder: "reservation_failed"
    };
  }

  if (!reserved) {
    logger.info(
      { businessId },
      "Subscription reminder suppressed: daily limit reached."
    );

    return {
      ok: false,
      reason: "subscription_expired",
      reminder: "daily_limit_reached"
    };
  }

  const reminderText =
    "Hi 👋 Your WhatsApp messages are currently going unreplied because your Sodah.io subscription has expired. Subscribe now to restore your AI automation and continue responding to your customers.";

  const recipientJid = toWhatsAppJid(recipientPhone);

  if (!recipientJid) {
    logger.warn(
      { businessId },
      "Subscription reminder skipped: invalid recipient phone."
    );

    return {
      ok: false,
      reason: "subscription_expired",
      reminder: "invalid_recipient"
    };
  }

  try {
    await sendText(
      socket,
      recipientJid,
      reminderText
    );

    logger.info(
      {
        businessId,
        recipientPhone
      },
      "Subscription expiry reminder sent."
    );

    return {
      ok: false,
      reason: "subscription_expired",
      reminder: "sent"
    };
  } catch (error) {
    logger.error(
      {
        businessId,
        recipientPhone,
        error: error.message
      },
      "Subscription expiry reminder could not be sent."
    );

    return {
      ok: false,
      reason: "subscription_expired",
      reminder: "send_failed"
    };
  }
}

/* =========================================================
   TEXT NORMALIZATION
========================================================= */

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value) {
  const stopWords = new Set([
    "a", "an", "and", "are", "as", "at", "be", "can", "do", "does", "for", "from",
    "have", "how", "i", "in", "is", "it", "me", "my", "of", "on", "or", "our",
    "please", "the", "their", "this", "to", "us", "we", "what", "when", "where",
    "which", "who", "with", "would", "you", "your", "much", "price", "cost", "sell",
    "offer", "available", "availability", "show", "send", "share", "image", "images",
    "picture", "pictures", "photo", "photos", "see", "look", "about", "its", "those",
    "another", "again", "one", "product", "products", "item", "items", "catalog", "catalogue"
  ]);
  return normalizeText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !stopWords.has(token));
}

function isImageRequest(text) {
  const normalized = normalizeText(text);
  return /\b(show|send|share|see|view|look at)\b/.test(normalized) &&
    /\b(image|images|picture|pictures|photo|photos|flyer|flyers)\b/.test(normalized);
}

function isPromotionImageRequest(text, history = []) {
  if (!isImageRequest(text)) return false;
  const recent = [
    ...history.slice(-6).map((message) => message.content || ""),
    text
  ].join(" ");
  return /\b(promotion|promotions|promo|promos|offer|offers|deal|deals|discount|flyer)\b/i.test(recent);
}

function isPromotionQuestion(text) {
  return /\b(promotion|promotions|promo|promos|offer|offers|deal|deals|discount|sale)\b/i.test(String(text || ""));
}

function isProductInquiry(text) {
  return /\b(how much|price|cost|do you have|do you sell|available|in stock|buy|purchase|order|show me|tell me about|image|picture|photo|products?|items?|catalog|catalogue)\b/i.test(String(text || ""));
}

function isGenericProductListRequest(text) {
  const value = normalizeText(text);
  return /\b(what|which|show|list|tell me|browse)\b/.test(value) &&
    /\b(products?|items?|catalog|catalogue|collection|do you sell|do you offer|what do you have|available options)\b/.test(value);
}

function mediaImageKey(image) {
  return String(image?.id || image?.storage_path || image?.image_url || "").trim();
}

function isExplicitBotIdentity(text) {
  return /\b(as an ai (?:language )?model|i am an ai(?: assistant)?|i'm an ai(?: assistant)?|i am a bot|i'm a bot|i am an automated assistant|i'm an automated assistant)\b/i.test(String(text || ""));
}

function looksLikeBotTemplate(text) {
  return /\b(thank you for reaching out|thanks for contacting|how can i assist you|how may i assist|please provide your (request|requirements|details)|your request is important|automated response|virtual agent)\b/i.test(String(text || ""));
}

function likelyAiToAiLoop(history, text) {
  if (isExplicitBotIdentity(text)) return true;

  const timeline = [
    ...(Array.isArray(history) ? history : []),
    { role: "user", content: text, at: new Date().toISOString() }
  ].slice(-12);
  const users = timeline.filter((message) => message.role === "user").slice(-4);
  const templateCount = users.filter((message) => looksLikeBotTemplate(message.content)).length;
  if (users.length < 3 || templateCount < 3) return false;

  let fastReplies = 0;
  for (const userMessage of users.slice(1)) {
    const userTime = new Date(userMessage.at || 0).getTime();
    const previousAssistant = [...timeline]
      .reverse()
      .find((message) => message.role === "assistant" &&
        new Date(message.at || 0).getTime() < userTime);
    if (!previousAssistant) continue;
    const assistantTime = new Date(previousAssistant.at || 0).getTime();
    if (Number.isFinite(assistantTime) && userTime - assistantTime <= 2 * 60 * 1000) {
      fastReplies += 1;
    }
  }

  return fastReplies >= 2;
}

/* =========================================================
   PRODUCT MATCHING
========================================================= */

function findRelevantProducts(products, messageText) {
  if (!Array.isArray(products) || products.length === 0) {
    return [];
  }

  const message = normalizeText(messageText);
  const messageTokens = new Set(tokenize(messageText));

  if (!message) return [];

  const scored = [];

  for (const product of products) {
    if (!product?.active) continue;

    const productName = normalizeText(product.product_name);
    const sku = normalizeText(product.sku);
    const category = normalizeText(product.category);

    if (!productName) continue;

    let score = 0;

    if (message.includes(productName) && productName.length >= 2) {
      score += 100;
    }

    if (sku && message.includes(sku)) {
      score += 100;
    }

    const productNameTokens = tokenize(product.product_name);
    let nameTokenMatches = 0;

    for (const token of productNameTokens) {
      if (messageTokens.has(token)) {
        nameTokenMatches += 1;
      }
    }

    if (nameTokenMatches > 0) {
      score += nameTokenMatches * 20;
    }

    if (
      productNameTokens.length > 0 &&
      nameTokenMatches === productNameTokens.length
    ) {
      score += 60;
    }

    if (category && message.includes(category)) {
      score += 15;
    }

    const descriptionTokens = tokenize(product.description);
    let descriptionMatches = 0;

    for (const token of descriptionTokens) {
      if (messageTokens.has(token)) {
        descriptionMatches += 1;
      }
    }

    score += Math.min(descriptionMatches * 2, 10);

    if (score < 20) continue;

    scored.push({ product, score });
  }

  scored.sort((a, b) => b.score - a.score);

  return scored
    .slice(0, 5)
    .map((item) => item.product);
}

/* =========================================================
   PRODUCT CONTEXT
========================================================= */

function buildProductContext(products) {
  if (!Array.isArray(products) || products.length === 0) {
    return [];
  }

  return products.map((product) => ({
    id: product.id,
    product_name: product.product_name || null,
    description: product.description || null,
    price:
      product.price === null || product.price === undefined
        ? null
        : product.price,
    currency: product.currency || "AED",
    availability: product.availability || null,
    promotion: product.promotion || null,
    category: product.category || null,
    sku: product.sku || null,
    has_image:
      Array.isArray(product.images) &&
      product.images.length > 0
  }));
}

/* =========================================================
   PRIMARY PRODUCT IMAGE
========================================================= */

async function getPrimaryProductImage(product) {
  if (
    !product ||
    !Array.isArray(product.images) ||
    product.images.length === 0
  ) {
    return null;
  }

  const image = [...product.images].sort(
    (a, b) =>
      Number(a.sort_order || 0) -
      Number(b.sort_order || 0)
  )[0];

  if (!image) return null;

  try {
    return await getProductImageUrl(image, 3600);
  } catch (error) {
    logger.warn(
      {
        productId: product.id,
        error: error.message
      },
      "Product image URL could not be generated."
    );

    return null;
  }
}

/* =========================================================
   PROMOTION IMAGE
========================================================= */

async function getPrimaryPromotionImage(promotion) {
  if (
    !promotion ||
    !Array.isArray(promotion.images) ||
    promotion.images.length === 0
  ) {
    return null;
  }

  const image = [...promotion.images].sort(
    (a, b) =>
      Number(a.sort_order || 0) -
      Number(b.sort_order || 0)
  )[0];

  if (!image) return null;

  try {
    if (image.storage_path) {
      return await getProductImageUrl(
        {
          storage_path: image.storage_path,
          image_url: image.image_url
        },
        3600,
        process.env.SUPABASE_PROMOTION_IMAGE_BUCKET ||
          "business-promotion-images"
      );
    }

    return image.image_url || null;
  } catch (error) {
    logger.warn(
      {
        promotionId: promotion.id,
        error: error.message
      },
      "Promotion image URL could not be generated."
    );

    return null;
  }
}

/* =========================================================
   SEND TEXT / IMAGE
========================================================= */

async function sendText(socket, remoteJid, text) {
  const value = String(text || "").trim();

  if (!value) return null;

  return markAutomatedMessage(await socket.sendMessage(remoteJid, {
    text: value
  }));
}

async function notifyBusinessOwner({ business, socket, session, customerPhone, customerName, question, reason }) {
  const ownerPhone = phoneFromJid(
    business?.owner_phone ||
    business?.owner_phone_number ||
    business?.support_number ||
    business?.contact_phone ||
    business?.phone_number ||
    business?.business_phone ||
    ""
  );
  const connectedPhone = phoneFromJid(session?.phoneNumber || "");
  if (!ownerPhone || ownerPhone === connectedPhone || ownerPhone === customerPhone) {
    logger.warn(
      { businessId: business?.business_id, hasSupportNumber: Boolean(ownerPhone) },
      "Owner handoff notice could not be sent because no separate support number is configured."
    );
    return false;
  }

  const message = [
    `Sodah handoff for ${business?.business_name || "your business"}`,
    `Reason: ${reason}`,
    `Customer: ${customerName || "Customer"}${customerPhone ? ` (${customerPhone})` : ""}`,
    `Message: ${String(question || "").slice(0, 900)}`,
    "Reply to the customer directly, then send AI ON in that chat when the AI may resume."
  ].join("\n");

  await sendText(socket, toWhatsAppJid(ownerPhone), message);
  return true;
}

async function sendImage(socket, remoteJid, imageUrl, caption) {
  if (!imageUrl) return null;

  return markAutomatedMessage(await socket.sendMessage(remoteJid, {
    image: { url: imageUrl },
    caption: String(caption || "").trim()
  }));
}

async function sendImageOnce({
  socket,
  remoteJid,
  businessId,
  customerKey,
  assetType,
  assetId,
  image,
  caption
}) {
  const imageKey = mediaImageKey(image);
  if (!imageKey || !assetId) return { sent: false, result: null };

  const imageUrl = await getProductImageUrl(
    image,
    3600,
    assetType === "promotion"
      ? process.env.SUPABASE_PROMOTION_IMAGE_BUCKET || "business-promotion-images"
      : process.env.SUPABASE_PRODUCT_IMAGE_BUCKET || "business-product-images"
  );
  if (!imageUrl) return { sent: false, result: null };

  const claimed = await claimMediaImage({
    businessId,
    customerKey,
    assetType,
    assetId,
    imageKey
  });
  if (!claimed) return { sent: false, result: null };

  try {
    const result = await sendImage(socket, remoteJid, imageUrl, caption);
    await finishMediaImage({
      businessId,
      customerKey,
      assetType,
      assetId,
      imageKey,
      sent: true
    });
    return { sent: true, result };
  } catch (error) {
    try {
      await finishMediaImage({
        businessId,
        customerKey,
        assetType,
        assetId,
        imageKey,
        sent: false
      });
    } catch (stateError) {
      logger.warn(
        { businessId, customerKey, assetType, assetId, error: stateError.message },
        "Failed to release an unsent image delivery claim."
      );
    }
    throw error;
  }
}

async function sendReply({
  socket,
  remoteJid,
  reply,
  businessId,
  customerKey,
  pendingPromotions = [],
  allPromotions = [],
  promotionImageRequest = false,
  suppressPromotionImage = false,
  productImageRequest = false,
  matchedProduct = null
}) {
  const promotions = Array.isArray(pendingPromotions) ? pendingPromotions : [];
  const allActivePromotions = Array.isArray(allPromotions) ? allPromotions : [];
  const promotionCandidates = promotionImageRequest
    ? allActivePromotions
    : promotions;

  // A specific product question gets the matching product image. A promotion
  // introduction never adds a second image to that reply.
  if (matchedProduct && !promotionImageRequest) {
    const images = [...(matchedProduct.images || [])].sort(
      (a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0)
    );
    let sentKeys = new Set();
    try {
      sentKeys = await getSentMediaImageKeys(businessId, customerKey, "product");
    } catch (error) {
      logger.warn(
        { businessId, customerKey, error: error.message },
        "Product image history is unavailable; sending a text reply only."
      );
    }
    const available = productImageRequest
      ? images
      : images.slice(0, 1);
    const nextImage = available.find((image) => {
      const key = mediaImageKey(image);
      return key && !sentKeys.has(key);
    });

    if (nextImage) {
      try {
        const delivered = await sendImageOnce({
          socket,
          remoteJid,
          businessId,
          customerKey,
          assetType: "product",
          assetId: matchedProduct.id || matchedProduct.sku || matchedProduct.product_name,
          image: nextImage,
          caption: reply
        });
        if (delivered.sent) return { messageResult: delivered.result, productImageSent: true, promotionImageSent: false };
      } catch (error) {
        logger.warn(
          { businessId, customerKey, productId: matchedProduct.id, error: error.message },
          "Product image send failed. Falling back to text."
        );
      }
    }
  }

  const textResult = await sendText(socket, remoteJid, reply);
  let promotionImageSent = false;

  if (!matchedProduct && !suppressPromotionImage && (promotionImageRequest || promotions.length > 0)) {
    let sentKeys = new Set();
    try {
      sentKeys = await getSentMediaImageKeys(businessId, customerKey, "promotion");
    } catch (error) {
      logger.warn(
        { businessId, customerKey, error: error.message },
        "Promotion image history is unavailable; sending text only."
      );
      return { messageResult: textResult, productImageSent: false, promotionImageSent: false };
    }
    let chosen = null;
    for (const promotion of promotionCandidates) {
      const images = [...(promotion?.images || [])].sort(
        (a, b) => Number(a.sort_order || 0) - Number(b.sort_order || 0)
      );
      const image = images.find((candidate) => {
        const key = mediaImageKey(candidate);
        return key && !sentKeys.has(key);
      });
      if (image) {
        chosen = { promotion, image };
        break;
      }
    }

    if (chosen) {
      const captionParts = [chosen.promotion.title];
      if (chosen.promotion.price !== null && chosen.promotion.price !== undefined && chosen.promotion.price !== "") {
        captionParts.push(`${chosen.promotion.currency || "AED"} ${chosen.promotion.price}`);
      }
      try {
        const delivered = await sendImageOnce({
          socket,
          remoteJid,
          businessId,
          customerKey,
          assetType: "promotion",
          assetId: chosen.promotion.id,
          image: chosen.image,
          caption: captionParts.filter(Boolean).join(" • ")
        });
        promotionImageSent = delivered.sent;
      } catch (error) {
        logger.warn(
          { businessId, customerKey, promotionId: chosen.promotion.id, error: error.message },
          "Promotion image send failed; the text introduction was still delivered."
        );
      }
    }
  }

  return { messageResult: textResult, productImageSent: false, promotionImageSent };
}

/* =========================================================
   MAIN INCOMING MESSAGE HANDLER
========================================================= */

async function handleIncomingMessage({
  session,
  message,
  socket
}) {
  const remoteJid = message?.key?.remoteJid || "";
  const fromMe = Boolean(message?.key?.fromMe);
  const messageId = message?.key?.id || "";

  if (!remoteJid || !messageId) {
    return;
  }

  if (shouldIgnore(remoteJid, fromMe)) {
    return;
  }

  if (processed.has(messageId)) {
    return;
  }

  // Unwrap common WhatsApp wrappers before extracting text. Baileys may
  // place content inside ephemeral/view-once wrappers.
  let content = message?.message || {};
  for (let i = 0; i < 4; i += 1) {
    const wrapped =
      content?.ephemeralMessage?.message ||
      content?.viewOnceMessage?.message ||
      content?.viewOnceMessageV2?.message ||
      content?.viewOnceMessageV2Extension?.message ||
      content?.documentWithCaptionMessage?.message;

    if (!wrapped) break;
    content = wrapped;
  }

  const normalizedMessage = content === message?.message
    ? message
    : { ...message, message: content };

  const text = extractText(normalizedMessage);

  // Do not mark an unrecognized/non-text message as processed before text
  // extraction. This allows a later decrypted/retried event to be handled.
  if (!text) {
    logger.debug(
      {
        businessId: session?.businessId || null,
        messageId,
        messageTypes: Object.keys(content || {})
      },
      "Incoming WhatsApp message has no supported text content; skipped without deduplication."
    );
    return;
  }

  rememberMessage(messageId);

  const whatsappSocket = socket || session?.socket;

  if (!whatsappSocket) {
    logger.error(
      { businessId: session?.businessId },
      "WhatsApp socket is unavailable."
    );
    return;
  }

  const businessId = session?.businessId;

  if (!businessId) {
    logger.error(
      { sessionId: session?.sessionId },
      "Incoming message has no business ID."
    );
    return;
  }

  const customerPhone = phoneFromJid(remoteJid);
  const customerName = extractCustomerName(message);
  const customerKey = customerPhone || remoteJid;

  logger.info(
    {
      sessionId: session?.sessionId,
      businessId,
      customerPhone,
      customerName,
      messageId,
      text
    },
    "Processing incoming customer message."
  );

  const conversationHistory = await loadConversationHistory({
    businessId,
    customerKey,
    excludeMessageId: messageId,
    limit: 12
  }).catch((error) => {
    logger.warn(
      { businessId, customerKey, error: error.message },
      "Conversation history lookup failed."
    );
    return [];
  });

  try {
    await saveConversationMessage({
      businessId,
      customerKey,
      role: "user",
      content: text,
      messageId
    });
  } catch (error) {
    logger.warn(
      { businessId, customerKey, error: error.message },
      "Direct-reply conversation history save failed."
    );
  }

  /* =======================================================
     SAVE INCOMING MESSAGE
  ======================================================= */

  try {
    await saveMessage({
      business_id: businessId,
      channel: "whatsapp",
      direction: "inbound",
      customer_phone: customerPhone,
      message: text,
      message_id: messageId
    });
  } catch (error) {
    logger.warn(
      { businessId, error: error.message },
      "Incoming message persistence failed."
    );
  }

  /* =======================================================
     UPSERT CUSTOMER
  ======================================================= */

  try {
    await upsertCustomer({
      business_id: businessId,
      channel: "whatsapp",
      channel_customer_id: customerKey,
      phone: customerPhone || null,
      last_message: text,
      updated_at: new Date().toISOString()
    });
  } catch (error) {
    logger.warn(
      {
        businessId,
        customerPhone,
        error: error.message
      },
      "Customer persistence failed."
    );
  }

  /* =======================================================
     LOAD BUSINESS
  ======================================================= */

  let business;

  try {
    business = await getBusinessById(businessId);
  } catch (error) {
    logger.error(
      { businessId, error: error.message },
      "Business lookup failed. AI reply blocked."
    );

    return {
      ok: false,
      reason: "business_lookup_failed"
    };
  }

  if (!business) {
    logger.error(
      { businessId },
      "Business was not found. AI reply blocked."
    );

    return {
      ok: false,
      reason: "business_not_found"
    };
  }

  try {
    const control = await getConversationControl(businessId, customerKey);
    if (control?.paused) {
      logger.info(
        { businessId, customerKey, reason: control.reason || "manual_takeover" },
        "AI reply suppressed because this conversation is paused for human takeover."
      );
      return { ok: true, skipped: "human_takeover" };
    }
  } catch (error) {
    logger.error(
      { businessId, customerKey, error: error.message },
      "Conversation control state could not be loaded; AI reply suppressed until the persistent handover state is available."
    );
    return { ok: false, skipped: "conversation_control_unavailable" };
  }

  if (likelyAiToAiLoop(conversationHistory, text)) {
    const handoffText = "I’ll have a member of our team take over this conversation.";
    try {
      const sent = await sendText(whatsappSocket, remoteJid, handoffText);
      await saveConversationMessage({
        businessId,
        customerKey,
        role: "assistant",
        content: handoffText,
        messageId: sent?.key?.id || null
      });
      await setConversationControl(businessId, customerKey, true, "probable_ai_to_ai_loop");
      await notifyBusinessOwner({
        business,
        socket: whatsappSocket,
        session,
        customerPhone,
        customerName,
        question: text,
        reason: "Possible automated AI conversation detected; replies are paused."
      });
    } catch (error) {
      logger.error(
        { businessId, customerKey, error: error.message },
        "Probable AI-to-AI loop handoff failed."
      );
    }
    return { ok: true, skipped: "probable_ai_to_ai_loop" };
  }

  /* =======================================================
     SUBSCRIPTION GATE
  ======================================================= */

  const subscription = getSubscriptionState(business);

  if (!subscription.active) {
    return handleExpiredSubscription({
      business,
      businessId,
      socket: whatsappSocket
    });
  }

  if (/\b(stop|unsubscribe|do not contact|don't contact|remove me)\b/i.test(text)) {
    const reply = "Understood. We won’t send further messages.";
    try {
      const sent = await sendText(whatsappSocket, remoteJid, reply);
      await saveConversationMessage({
        businessId,
        customerKey,
        role: "assistant",
        content: reply,
        messageId: sent?.key?.id || null
      });
      await setConversationControl(businessId, customerKey, true, "customer_opt_out");
    } catch (error) {
      logger.error(
        { businessId, customerKey, error: error.message },
        "Customer opt-out could not be saved."
      );
    }
    return { ok: true, skipped: "customer_opt_out" };
  }

  /* =======================================================
     EXISTING AUTOMATION FLAGS
  ======================================================= */

  /*
   * Do not change the existing AI/automation settings here.
   * Subscription status and expiry are checked independently.
   */

  /* =======================================================
     LOAD PRODUCT CATALOG
  ======================================================= */

  let catalog = [];

  try {
    catalog = await getBusinessCatalog(businessId);

    logger.info(
      {
        businessId,
        catalogCount: catalog.length
      },
      "Business product catalog loaded."
    );
  } catch (error) {
    logger.warn(
      {
        businessId,
        error: error.message
      },
      "Product catalog lookup failed. Continuing without catalog."
    );

    catalog = [];
  }

  const currentProductTokens = tokenize(text);
  const productQueryText = currentProductTokens.length === 0
    ? [
        conversationHistory.filter((item) => item.role === "user").slice(-1)[0]?.content || "",
        text
      ].filter(Boolean).join(" ")
    : text;
  const genericProductListRequest = isGenericProductListRequest(text);
  const relevantProducts = findRelevantProducts(catalog, productQueryText);
  const productContext = buildProductContext(
    genericProductListRequest ? catalog.slice(0, 20) : relevantProducts
  );
  const matchedProduct = relevantProducts.length === 1 ? relevantProducts[0] : null;
  const promotionImageRequest = isPromotionImageRequest(text, conversationHistory);
  const productImageRequest = isImageRequest(text) && !promotionImageRequest;
  const productInquiry = isProductInquiry(text) &&
    !promotionImageRequest &&
    !isPromotionQuestion(text) &&
    !/\b(appointment|booking|schedule)\b/i.test(text);
  const unknownProductRequest =
    productInquiry &&
    !genericProductListRequest &&
    !/\b(appointment|booking|schedule|slot|time|date|today|tomorrow|next week)\b/i.test(text) &&
    tokenize(productQueryText).length > 0 &&
    !matchedProduct;

  /* =======================================================
     LOAD NEW ACTIVE PROMOTIONS
  ======================================================= */

  let pendingPromotions = [];
  let allPromotions = [];
  const hasPriorConversation = conversationHistory.some(
    (item) => item.role === "user" || item.role === "assistant"
  );

  try {
    const unintroducedPromotions =
      await getPromotionsForCustomerIntro(
        businessId,
        customerKey
      );
    pendingPromotions =
      !hasPriorConversation && !isPromotionQuestion(text) && !promotionImageRequest
        ? []
        : unintroducedPromotions;

    if (promotionImageRequest || isPromotionQuestion(text)) {
      allPromotions = await getPromotionsForCustomerIntro(
        businessId,
        customerKey,
        { includeIntroduced: true }
      );
    } else {
      allPromotions = pendingPromotions;
    }

    logger.info(
      {
        businessId,
        customerKey,
        promotionCount: pendingPromotions.length
      },
      "Promotion introduction lookup completed."
    );
  } catch (error) {
    logger.warn(
      {
        businessId,
        customerKey,
        error: error.message
      },
      "Promotion lookup failed. Continuing without promotions."
    );

    pendingPromotions = [];
  }

  const promptPromotions = pendingPromotions.length
    ? pendingPromotions
    : (isPromotionQuestion(text) && !promotionImageRequest ? allPromotions : []);

  const promotionContext = promptPromotions.map(
    (promotion) => ({
      id: promotion.id,
      title: promotion.title || null,
      description: promotion.description || null,
      price: promotion.price ?? null,
      currency: promotion.currency || "AED",
      promotion_type: promotion.promotion_type || null,
      valid_from: promotion.valid_from || null,
      valid_until: promotion.valid_until || null,
      has_image:
        Array.isArray(promotion.images) &&
        promotion.images.length > 0
    })
  );

  /* =======================================================
     GENERATE AI REPLY
  ======================================================= */

  let result;

  try {
    result = await generateReply({
      business,
      customerPhone,
      customerName,
      messageText: text,
      conversationHistory,
      products: productContext,
      promotions: promotionContext,
      introducePromotions: pendingPromotions.length > 0 ||
        (isPromotionQuestion(text) && !promotionImageRequest),
      imageRequest: promotionImageRequest
        ? "promotion"
        : productImageRequest
          ? "product"
          : "",
      unknownProductRequest
    });
  } catch (error) {
    logger.error(
      {
        businessId,
        customerPhone,
        error: error.message
      },
      "AI reply generation failed."
    );

    return;
  }

  if (!result || !result.ok) {
    logger.warn(
      {
        businessId,
        error: result?.error || "Unknown AI error"
      },
      "AI did not return a usable reply."
    );

    return;
  }

  let reply = String(result.reply || "").trim();

  if (unknownProductRequest) {
    reply = "Let me confirm those details with the business team and get back to you.";
  }

  if (!reply) {
    logger.warn(
      { businessId },
      "AI returned an empty reply."
    );

    return;
  }

  /* =======================================================
     SEND WHATSAPP REPLY
  ======================================================= */

  let sent;

  try {
    sent = await sendReply({
      socket: whatsappSocket,
      remoteJid,
      reply,
      businessId,
      customerKey,
      pendingPromotions,
      allPromotions,
      promotionImageRequest,
      suppressPromotionImage: unknownProductRequest ||
        (productInquiry && !genericProductListRequest),
      productImageRequest,
      matchedProduct
    });
  } catch (error) {
    logger.error(
      {
        businessId,
        customerPhone,
        error: error.message
      },
      "WhatsApp reply send failed."
    );

    return;
  }

  try {
    await saveConversationMessage({
      businessId,
      customerKey,
      role: "assistant",
      content: reply,
      messageId: sent?.messageResult?.key?.id || sent?.key?.id || null
    });
  } catch (error) {
    logger.warn(
      { businessId, customerKey, error: error.message },
      "Direct-reply assistant message history save failed."
    );
  }

  if (unknownProductRequest) {
    try {
      await setConversationControl(businessId, customerKey, true, "unknown_product_handover");
    } catch (error) {
      logger.error(
        { businessId, customerKey, error: error.message },
        "Unknown product handoff pause could not be saved."
      );
    }

    try {
      await notifyBusinessOwner({
        business,
        socket: whatsappSocket,
        session,
        customerPhone,
        customerName,
        question: text,
        reason: "A requested product or its details could not be confirmed."
      });
    } catch (error) {
      logger.error(
        { businessId, customerKey, error: error.message },
        "Unknown product handoff could not be persisted or sent to the business owner."
      );
    }
  }

  /* =======================================================
     MARK PROMOTIONS AS INTRODUCED
  ======================================================= */

  if (pendingPromotions.length > 0 && !unknownProductRequest) {
    for (const promotion of pendingPromotions) {
      try {
        await markPromotionIntroduced({
          businessId,
          promotionId: promotion.id,
          customerKey,
          promotionUpdatedAt: promotion.updated_at
        });
      } catch (error) {
        logger.warn(
          {
            businessId,
            promotionId: promotion.id,
            customerKey,
            error: error.message
          },
          "Promotion introduction state could not be saved."
        );
      }
    }
  }

  /* =======================================================
     SAVE OUTGOING MESSAGE
  ======================================================= */

  try {
    await saveMessage({
      business_id: businessId,
      channel: "whatsapp",
      direction: "outbound",
      customer_phone: customerPhone,
      message: reply,
      message_id: sent?.messageResult?.key?.id || sent?.key?.id || null,
      metadata: {
        customer_name: customerName || null,
        promotions_introduced: pendingPromotions.map(
          (promotion) => ({
            id: promotion.id,
            title: promotion.title
          })
        ),
        promotion_images_sent: sent?.promotionImageSent ? 1 : 0,
        product_id: matchedProduct?.id || null,
        product_name: matchedProduct?.product_name || null,
        product_image_sent: Boolean(sent?.productImageSent)
      }
    });
  } catch (error) {
    logger.warn(
      { businessId, error: error.message },
      "Outgoing message persistence failed."
    );
  }

  logger.info(
    {
      sessionId: session?.sessionId,
      businessId,
      customerPhone,
      customerName,
      messageId: sent?.messageResult?.key?.id || sent?.key?.id || null,
      promotionsIntroduced: pendingPromotions.length,
      promotionImageSent: Boolean(sent?.promotionImageSent),
      productId: matchedProduct?.id || null,
      productImageSent: Boolean(sent?.productImageSent)
    },
    "WhatsApp AI reply completed."
  );

  return {
    ok: true,
    reply,
    promotions: pendingPromotions.map(
      (promotion) => ({
        id: promotion.id,
        title: promotion.title
      })
    ),
    product: matchedProduct
      ? {
          id: matchedProduct.id,
          name: matchedProduct.product_name,
          imageSent: Boolean(sent?.productImageSent)
        }
      : null
  };
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  handleIncomingMessage,
  extractText,
  phoneFromJid,
  extractCustomerName,
  wasAutomatedMessage
};
