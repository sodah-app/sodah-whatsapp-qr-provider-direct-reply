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
  upsertCustomer
} = require("./supabase");

/* =========================================================
   MESSAGE DEDUPLICATION
========================================================= */

const processed = new Map();

const ttlMs =
  Number(
    process.env.MESSAGE_DEDUP_TTL_SECONDS || 120
  ) * 1000;

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
    const description = normalizeText(product.description);

    if (!productName) continue;

    let score = 0;

    if (
      message.includes(productName) &&
      productName.length >= 2
    ) {
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

    scored.push({
      product,
      score
    });
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
      product.price === null ||
      product.price === undefined
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

  const image =
    [...product.images]
      .sort(
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

  const image =
    [...promotion.images]
      .sort(
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

  return socket.sendMessage(
    remoteJid,
    {
      text: value
    }
  );
}

async function sendImage(socket, remoteJid, imageUrl, caption) {
  if (!imageUrl) return null;

  return socket.sendMessage(
    remoteJid,
    {
      image: {
        url: imageUrl
      },
      caption: String(caption || "").trim()
    }
  );
}

/*
 * Promotion-first ordering:
 *
 * 1. AI reply containing the new promotion introduction.
 * 2. Real promotion/package flyer(s).
 * 3. Product answer image, when there is a clear product match.
 *
 * If there is no promotion introduction, the previous product-image
 * behavior remains unchanged.
 */
async function sendReply({
  socket,
  remoteJid,
  reply,
  promotionAssets,
  productImageUrl,
  matchedProduct
}) {
  const promotions =
    Array.isArray(promotionAssets)
      ? promotionAssets
      : [];

  if (promotions.length > 0) {
    await sendText(
      socket,
      remoteJid,
      reply
    );

    for (const promotion of promotions) {
      if (!promotion?.imageUrl) continue;

      const captionParts = [];

      if (promotion.title) {
        captionParts.push(
          String(promotion.title).trim()
        );
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

    /*
     * If the customer also asked about a specific product,
     * its real product image comes after the promotion.
     */
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

  /*
   * No promotion introduction: preserve the normal product
   * image behavior.
   */
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

  return sendText(
    socket,
    remoteJid,
    reply
  );
}

/* =========================================================
   MAIN INCOMING MESSAGE HANDLER
========================================================= */

async function handleIncomingMessage({
  session,
  message,
  socket
}) {
  const remoteJid =
    message?.key?.remoteJid || "";

  const fromMe =
    Boolean(message?.key?.fromMe);

  const messageId =
    message?.key?.id || "";

  if (!remoteJid || !messageId) {
    return;
  }

  if (
    shouldIgnore(
      remoteJid,
      fromMe
    )
  ) {
    return;
  }

  if (processed.has(messageId)) {
    return;
  }

  rememberMessage(messageId);

  const text =
    extractText(message);

  if (!text) return;

  const whatsappSocket =
    socket || session?.socket;

  if (!whatsappSocket) {
    logger.error(
      {
        businessId:
          session?.businessId
      },
      "WhatsApp socket is unavailable."
    );
    return;
  }

  const customerPhone =
    phoneFromJid(remoteJid);

  const customerName =
    extractCustomerName(message);

  const customerKey =
    customerPhone ||
    remoteJid;

  logger.info(
    {
      sessionId:
        session?.sessionId,
      businessId:
        session?.businessId,
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
      business_id:
        session.businessId,
      channel:
        "whatsapp",
      direction:
        "inbound",
      customer_phone:
        customerPhone,
      message:
        text,
      message_id:
        messageId
    });
  } catch (error) {
    logger.warn(
      {
        businessId:
          session.businessId,
        error:
          error.message
      },
      "Incoming message persistence failed."
    );
  }

  /* =======================================================
     UPSERT CUSTOMER
  ======================================================= */

  try {
    await upsertCustomer({
      business_id:
        session.businessId,
      channel:
        "whatsapp",
      channel_customer_id:
        customerKey,
      phone:
        customerPhone || null,
      last_message:
        text,
      updated_at:
        new Date().toISOString()
    });
  } catch (error) {
    logger.warn(
      {
        businessId:
          session.businessId,
        customerPhone,
        error:
          error.message
      },
      "Customer persistence failed."
    );
  }

  /* =======================================================
     LOAD BUSINESS
  ======================================================= */

  let business;

  try {
    business =
      await getBusinessById(
        session.businessId
      );
  } catch (error) {
    logger.error(
      {
        businessId:
          session.businessId,
        error:
          error.message
      },
      "Business lookup failed."
    );
    return;
  }

  if (!business) {
    logger.error(
      {
        businessId:
          session.businessId
      },
      "Business was not found."
    );
    return;
  }

  /* =======================================================
     LOAD PRODUCT CATALOG
  ======================================================= */

  let catalog = [];

  try {
    catalog =
      await getBusinessCatalog(
        session.businessId
      );

    logger.info(
      {
        businessId:
          session.businessId,
        catalogCount:
          catalog.length
      },
      "Business product catalog loaded."
    );
  } catch (error) {
    logger.warn(
      {
        businessId:
          session.businessId,
        error:
          error.message
      },
      "Product catalog lookup failed. Continuing without catalog."
    );

    catalog = [];
  }

  const relevantProducts =
    findRelevantProducts(
      catalog,
      text
    );

  const productContext =
    buildProductContext(
      relevantProducts
    );

  /* =======================================================
     LOAD NEW ACTIVE PROMOTIONS
  ======================================================= */

  let pendingPromotions = [];

  try {
    /*
     * This returns only active promotions that this customer
     * has not already received, or promotions whose content
     * was updated after the customer last received them.
     *
     * Therefore:
     *
     * - new customer + active promotion => introduce it
     * - old customer + brand-new promotion => introduce it
     * - old customer + unchanged old promotion => don't repeat
     * - updated promotion => introduce updated version once
     */
    pendingPromotions =
      await getPromotionsForCustomerIntro(
        session.businessId,
        customerKey
      );

    logger.info(
      {
        businessId:
          session.businessId,
        customerKey,
        promotionCount:
          pendingPromotions.length
      },
      "Promotion introduction lookup completed."
    );
  } catch (error) {
    logger.warn(
      {
        businessId:
          session.businessId,
        customerKey,
        error:
          error.message
      },
      "Promotion lookup failed. Continuing without promotions."
    );

    pendingPromotions = [];
  }

  const promotionContext =
    pendingPromotions.map(
      (promotion) => ({
        id:
          promotion.id,
        title:
          promotion.title || null,
        description:
          promotion.description || null,
        price:
          promotion.price ?? null,
        currency:
          promotion.currency || "AED",
        promotion_type:
          promotion.promotion_type || null,
        valid_from:
          promotion.valid_from || null,
        valid_until:
          promotion.valid_until || null,
        has_image:
          Array.isArray(
            promotion.images
          ) &&
          promotion.images.length > 0
      })
    );

  /* =======================================================
     GENERATE AI REPLY
  ======================================================= */

  let result;

  try {
    result =
      await generateReply({
        business,
        customerPhone,
        customerName,
        messageText:
          text,
        products:
          productContext,
        promotions:
          promotionContext,
        introducePromotions:
          pendingPromotions.length > 0
      });
  } catch (error) {
    logger.error(
      {
        businessId:
          session.businessId,
        customerPhone,
        error:
          error.message
      },
      "AI reply generation failed."
    );

    return;
  }

  if (
    !result ||
    !result.ok
  ) {
    logger.warn(
      {
        businessId:
          session.businessId,
        error:
          result?.error ||
          "Unknown AI error"
      },
      "AI did not return a usable reply."
    );

    return;
  }

  const reply =
    String(
      result.reply || ""
    ).trim();

  if (!reply) {
    logger.warn(
      {
        businessId:
          session.businessId
      },
      "AI returned an empty reply."
    );

    return;
  }

  /* =======================================================
     RESOLVE REAL PROMOTION IMAGES
  ======================================================= */

  const promotionAssets = [];

  if (pendingPromotions.length > 0) {
    for (
      const promotion
      of pendingPromotions
    ) {
      const imageUrl =
        await getPrimaryPromotionImage(
          promotion
        );

      if (imageUrl) {
        promotionAssets.push({
          id:
            promotion.id,
          title:
            promotion.title,
          price:
            promotion.price,
          currency:
            promotion.currency ||
            "AED",
          imageUrl
        });
      }
    }
  }

  /* =======================================================
     PRODUCT IMAGE
  ======================================================= */

  let productImageUrl =
    null;

  let matchedProduct =
    null;

  if (
    relevantProducts.length === 1
  ) {
    matchedProduct =
      relevantProducts[0];

    productImageUrl =
      await getPrimaryProductImage(
        matchedProduct
      );
  }

  /* =======================================================
     SEND WHATSAPP REPLY
  ======================================================= */

  let sent;

  try {
    sent =
      await sendReply({
        socket:
          whatsappSocket,
        remoteJid,
        reply,
        promotionAssets,
        productImageUrl,
        matchedProduct
      });
  } catch (error) {
    logger.error(
      {
        businessId:
          session.businessId,
        customerPhone,
        error:
          error.message
      },
      "WhatsApp reply send failed."
    );

    return;
  }

  /* =======================================================
     MARK PROMOTIONS AS INTRODUCED
  ======================================================= */

  if (
    pendingPromotions.length > 0
  ) {
    for (
      const promotion
      of pendingPromotions
    ) {
      try {
        await markPromotionIntroduced({
          businessId:
            session.businessId,
          promotionId:
            promotion.id,
          customerKey,
          promotionUpdatedAt:
            promotion.updated_at
        });
      } catch (error) {
        logger.warn(
          {
            businessId:
              session.businessId,
            promotionId:
              promotion.id,
            customerKey,
            error:
              error.message
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
      business_id:
        session.businessId,
      channel:
        "whatsapp",
      direction:
        "outbound",
      customer_phone:
        customerPhone,
      message:
        reply,
      message_id:
        sent?.key?.id || null,
      metadata: {
        customer_name:
          customerName || null,
        promotions_introduced:
          pendingPromotions.map(
            (promotion) => ({
              id:
                promotion.id,
              title:
                promotion.title
            })
          ),
        promotion_images_sent:
          promotionAssets.length,
        product_id:
          matchedProduct?.id ||
          null,
        product_name:
          matchedProduct?.product_name ||
          null,
        product_image_sent:
          Boolean(productImageUrl)
      }
    });
  } catch (error) {
    logger.warn(
      {
        businessId:
          session.businessId,
        error:
          error.message
      },
      "Outgoing message persistence failed."
    );
  }

  logger.info(
    {
      sessionId:
        session?.sessionId,
      businessId:
        session.businessId,
      customerPhone,
      customerName,
      messageId:
        sent?.key?.id || null,
      promotionsIntroduced:
        pendingPromotions.length,
      promotionImagesSent:
        promotionAssets.length,
      productId:
        matchedProduct?.id ||
        null,
      productImageSent:
        Boolean(productImageUrl)
    },
    "WhatsApp AI reply completed."
  );

  return {
    ok: true,
    reply,
    promotions:
      pendingPromotions.map(
        (promotion) => ({
          id:
            promotion.id,
          title:
            promotion.title
        })
      ),
    product:
      matchedProduct
        ? {
            id:
              matchedProduct.id,
            name:
              matchedProduct.product_name,
            imageSent:
              Boolean(
                productImageUrl
              )
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
  extractCustomerName
};
