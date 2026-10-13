
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
  saveMessage,
  upsertCustomer,
  reserveSubscriptionExpiryReminder
} = require("./supabase");

/* =========================================================
   MESSAGE DEDUPLICATION
========================================================= */

const processed = new Map();

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
    m.buttonsResponseMessage?.selectedButtonId ||
    m.listResponseMessage?.title ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    m.templateButtonReplyMessage?.selectedId ||
    m.interactiveResponseMessage?.body?.text ||
    m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ||
    ""
  ).trim();
}

function normalizeMenuChoice(value) {
  const text = String(value || "")
    .toLowerCase()
    .replace(/[🏷️🛍️🛒📦]/gu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

  if (
    /^(?:sodah menu promotions|view current promotions|current promotions|view promotions|promotions|promotion|offers|offer|discounts|discount|1)$/.test(text) ||
    /\b(view|show|see|check)\b.*\b(promotions?|offers?|discounts?)\b/.test(text)
  ) return "promotions";

  if (
    /^(?:sodah menu products|view our products|our products|view products|products|product|catalog|catalogue|2)$/.test(text) ||
    /\b(view|show|see|browse)\b.*\b(products?|catalogue?)\b/.test(text)
  ) return "products";

  return "";
}

function isGreeting(value) {
  const text = String(value || "").toLowerCase().trim();
  return /^(hi|hello|hey|good morning|good afternoon|good evening|assalamu alaikum|salam|مرحبا|السلام عليكم)[!.\s🙏👋]*$/u.test(text);
}

function buildWelcomeMenu(business) {
  const name = String(business?.business_name || "our business").trim();
  return `Hi there 👋 welcome to ${name}. How may I help you today?\n\n🏷️ View Current Promotions\n🛍️ View Our Products\n\nReply with “View Current Promotions” or “View Our Products” to continue.`;
}

function formatPrice(item) {
  if (item?.price === null || item?.price === undefined || item?.price === "") return "Price not listed";
  return `${item.currency || "AED"} ${item.price}`;
}

function buildPromotionList(business, promotions) {
  const name = String(business?.business_name || "our business").trim();
  if (!promotions.length) return `There are no current active promotions from ${name} right now.`;
  const lines = promotions.map((p, i) => {
    const details = [p.description, p.price !== null && p.price !== undefined && p.price !== "" ? formatPrice(p) : ""]
      .filter(Boolean).join(" — ");
    return `${i + 1}. ${p.title || "Current promotion"}${details ? `\n   ${details}` : ""}`;
  });
  return `🏷️ Current Promotions from ${name}\n\n${lines.join("\n\n")}`;
}

function buildProductList(business, products) {
  const name = String(business?.business_name || "our business").trim();
  if (!products.length) return `There are no active products listed by ${name} right now.`;
  const lines = products.map((p, i) => {
    const details = [formatPrice(p), p.availability ? `Availability: ${p.availability}` : ""]
      .filter(Boolean).join(" • ");
    return `${i + 1}. ${p.product_name || "Product"}${details ? `\n   ${details}` : ""}`;
  });
  return `🛍️ Products from ${name}\n\n${lines.join("\n\n")}`;
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
  return normalizeText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
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

  return socket.sendMessage(remoteJid, {
    text: value
  });
}

async function sendImage(socket, remoteJid, imageUrl, caption) {
  if (!imageUrl) return null;

  return socket.sendMessage(remoteJid, {
    image: { url: imageUrl },
    caption: String(caption || "").trim()
  });
}

/*
 * Promotion-first ordering:
 *
 * 1. AI reply containing the new promotion introduction.
 * 2. Real promotion/package flyer(s).
 * 3. Product answer image, when there is a clear product match.
 */
async function sendReply({
  socket,
  remoteJid,
  reply,
  promotionAssets,
  productImageUrl,
  matchedProduct
}) {
  const promotions = Array.isArray(promotionAssets)
    ? promotionAssets
    : [];

  if (promotions.length > 0) {
    await sendText(socket, remoteJid, reply);

    for (const promotion of promotions) {
      if (!promotion?.imageUrl) continue;

      const captionParts = [];

      if (promotion.title) {
        captionParts.push(String(promotion.title).trim());
      }

      if (
        promotion.price !== null &&
        promotion.price !== undefined &&
        promotion.price !== ""
      ) {
        captionParts.push(
          `${promotion.currency || "AED"} ${promotion.price}`
        );
      }

      await sendImage(
        socket,
        remoteJid,
        promotion.imageUrl,
        captionParts.join(" • ")
      );
    }

    if (productImageUrl && matchedProduct) {
      await sendImage(
        socket,
        remoteJid,
        productImageUrl,
        reply
      );
    }

    return;
  }

  if (productImageUrl && matchedProduct) {
    try {
      return await sendImage(
        socket,
        remoteJid,
        productImageUrl,
        reply
      );
    } catch (error) {
      logger.warn(
        {
          productId: matchedProduct.id,
          error: error.message
        },
        "Product image send failed. Falling back to text."
      );
    }
  }

  return sendText(socket, remoteJid, reply);
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

  rememberMessage(messageId);

  const text = extractText(message);

  if (!text) return;

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

  const relevantProducts = findRelevantProducts(catalog, text);
  const productContext = buildProductContext(relevantProducts);
  const menuChoice = normalizeMenuChoice(text);

  // First contact shows the two explicit choices instead of unsolicited
  // promotion copy. The menu can also be re-opened with a greeting later.
  if (isGreeting(text) && !menuChoice) {
    const reply = buildWelcomeMenu(business);
    try {
      const sent = await sendText(whatsappSocket, remoteJid, reply);
      try {
        await saveMessage({
          business_id: businessId,
          channel: "whatsapp",
          direction: "outbound",
          customer_phone: customerPhone,
          message: reply,
          message_id: sent?.key?.id || null,
          metadata: { menu: "welcome", options: ["promotions", "products"] }
        });
      } catch (error) {
        logger.warn({ businessId, error: error.message }, "Welcome menu persistence failed.");
      }
      return { ok: true, reply, menu: true };
    } catch (error) {
      logger.error({ businessId, error: error.message }, "Welcome menu send failed.");
      return { ok: false, reason: "welcome_menu_send_failed" };
    }
  }

  if (menuChoice === "promotions" || menuChoice === "products") {
    let reply;
    let sent;
    let imageSent = false;
    let promotionsToMark = [];
    let productImageProduct = null;

    try {
      if (menuChoice === "promotions") {
        const activePromotions = await getPromotionsForCustomerIntro(
          businessId,
          customerKey,
          { includeAll: true }
        );
        promotionsToMark = activePromotions;
        reply = buildPromotionList(business, activePromotions);
        sent = await sendText(whatsappSocket, remoteJid, reply);

        // Only the first eligible promotion image is sent; never blast every flyer.
        for (const promotion of activePromotions) {
          const imageUrl = await getPrimaryPromotionImage(promotion);
          if (!imageUrl) continue;
          await sendImage(whatsappSocket, remoteJid, imageUrl, promotion.title || "Current promotion");
          imageSent = true;
          break;
        }
      } else {
        reply = buildProductList(business, catalog);
        sent = await sendText(whatsappSocket, remoteJid, reply);

        // Product selection sends at most one product image, and never a promotion flyer.
        for (const product of catalog) {
          const imageUrl = await getPrimaryProductImage(product);
          if (!imageUrl) continue;
          productImageProduct = product;
          await sendImage(whatsappSocket, remoteJid, imageUrl, product.product_name || "Product");
          imageSent = true;
          break;
        }
      }

      for (const promotion of promotionsToMark) {
        try {
          await markPromotionIntroduced({
            businessId,
            promotionId: promotion.id,
            customerKey,
            promotionUpdatedAt: promotion.updated_at
          });
        } catch (error) {
          logger.warn({ businessId, promotionId: promotion.id, error: error.message }, "Promotion view tracking failed.");
        }
      }

      try {
        await saveMessage({
          business_id: businessId,
          channel: "whatsapp",
          direction: "outbound",
          customer_phone: customerPhone,
          message: reply,
          message_id: sent?.key?.id || null,
          metadata: {
            menu: menuChoice,
            promotion_count: promotionsToMark.length,
            product_count: menuChoice === "products" ? catalog.length : 0,
            image_sent: imageSent,
            product_id: productImageProduct?.id || null
          }
        });
      } catch (error) {
        logger.warn({ businessId, error: error.message }, "Menu response persistence failed.");
      }

      return {
        ok: true,
        reply,
        menu: menuChoice,
        imageSent,
        promotionCount: promotionsToMark.length,
        productCount: menuChoice === "products" ? catalog.length : 0
      };
    } catch (error) {
      logger.error({ businessId, menuChoice, error: error.message }, "Menu selection response failed.");
      return { ok: false, reason: "menu_selection_failed" };
    }
  }

  /* =======================================================
     LOAD NEW ACTIVE PROMOTIONS
  ======================================================= */

  let pendingPromotions = [];

  try {
    pendingPromotions =
      await getPromotionsForCustomerIntro(
        businessId,
        customerKey
      );

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

  const promotionContext = pendingPromotions.map(
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
      products: productContext,
      promotions: promotionContext,
      introducePromotions: pendingPromotions.length > 0
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

  const reply = String(result.reply || "").trim();

  if (!reply) {
    logger.warn(
      { businessId },
      "AI returned an empty reply."
    );

    return;
  }

  /* =======================================================
     RESOLVE REAL PROMOTION IMAGES
  ======================================================= */

  const promotionAssets = [];

  for (const promotion of pendingPromotions) {
    const imageUrl = await getPrimaryPromotionImage(promotion);
    if (!imageUrl) continue;
    promotionAssets.push({
      id: promotion.id,
      title: promotion.title,
      price: promotion.price,
      currency: promotion.currency || "AED",
      imageUrl
    });
    break; // One eligible promotion image per reply.
  }

  /* =======================================================
     PRODUCT IMAGE
  ======================================================= */

  let productImageUrl = null;
  let matchedProduct = null;

  if (relevantProducts.length === 1) {
    matchedProduct = relevantProducts[0];

    productImageUrl =
      await getPrimaryProductImage(matchedProduct);
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
      promotionAssets,
      productImageUrl,
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

  /* =======================================================
     MARK PROMOTIONS AS INTRODUCED
  ======================================================= */

  if (pendingPromotions.length > 0) {
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
      message_id: sent?.key?.id || null,
      metadata: {
        customer_name: customerName || null,
        promotions_introduced: pendingPromotions.map(
          (promotion) => ({
            id: promotion.id,
            title: promotion.title
          })
        ),
        promotion_images_sent: promotionAssets.length,
        product_id: matchedProduct?.id || null,
        product_name: matchedProduct?.product_name || null,
        product_image_sent: Boolean(productImageUrl)
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
      messageId: sent?.key?.id || null,
      promotionsIntroduced: pendingPromotions.length,
      promotionImagesSent: promotionAssets.length,
      productId: matchedProduct?.id || null,
      productImageSent: Boolean(productImageUrl)
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
          imageSent: Boolean(productImageUrl)
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
  normalizeMenuChoice,
  isGreeting,
  buildWelcomeMenu,
  buildPromotionList,
  buildProductList
};
