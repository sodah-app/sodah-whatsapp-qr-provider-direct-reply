const pino = require("pino");

const logger = pino({
  level: process.env.LOG_LEVEL || "info"
});

const { generateReply } = require("./ai");

const {
  getBusinessById,
  getBusinessCatalog,
  getProductImageUrl,
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

  /*
   * Keep the map small.
   */
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

  if (!value) {
    return "";
  }

  return value
    .split("@")[0]
    .split(":")[0]
    .replace(/\D/g, "");
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
  if (fromMe) {
    return true;
  }

  if (!remoteJid) {
    return true;
  }

  /*
   * WhatsApp status.
   */
  if (remoteJid === "status@broadcast") {
    return true;
  }

  /*
   * WhatsApp groups.
   */
  if (remoteJid.endsWith("@g.us")) {
    return true;
  }

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
    .replace(/[^a-z0-9]+/g, " ")
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

/**
 * Find products that are actually relevant to the customer's
 * message.
 *
 * We intentionally do NOT send the entire catalog to the AI
 * for every message.
 *
 * Example:
 *
 * Customer:
 *   "How much is the Jordan 4?"
 *
 * Product:
 *   "Jordan 4"
 *
 * Result:
 *   Strong match.
 */
function findRelevantProducts(products, messageText) {
  if (!Array.isArray(products) || products.length === 0) {
    return [];
  }

  const message = normalizeText(messageText);
  const messageTokens = new Set(tokenize(messageText));

  if (!message) {
    return [];
  }

  const scored = [];

  for (const product of products) {
    if (!product?.active) {
      continue;
    }

    const productName =
      normalizeText(product.product_name);

    const sku =
      normalizeText(product.sku);

    const category =
      normalizeText(product.category);

    const description =
      normalizeText(product.description);

    if (!productName) {
      continue;
    }

    let score = 0;

    /*
     * Strongest signal:
     * exact product name appears in the message.
     */
    if (
      message.includes(productName) &&
      productName.length >= 2
    ) {
      score += 100;
    }

    /*
     * Exact SKU match.
     */
    if (
      sku &&
      message.includes(sku)
    ) {
      score += 100;
    }

    const productNameTokens =
      tokenize(product.product_name);

    /*
     * Product-name token overlap.
     */
    let nameTokenMatches = 0;

    for (const token of productNameTokens) {
      if (messageTokens.has(token)) {
        nameTokenMatches += 1;
      }
    }

    if (nameTokenMatches > 0) {
      score +=
        nameTokenMatches * 20;
    }

    /*
     * If all meaningful product-name tokens are present,
     * make this a strong match.
     */
    if (
      productNameTokens.length > 0 &&
      nameTokenMatches === productNameTokens.length
    ) {
      score += 60;
    }

    /*
     * Category match.
     */
    if (
      category &&
      message.includes(category)
    ) {
      score += 15;
    }

    /*
     * Description token overlap.
     */
    const descriptionTokens =
      tokenize(product.description);

    let descriptionMatches = 0;

    for (const token of descriptionTokens) {
      if (messageTokens.has(token)) {
        descriptionMatches += 1;
      }
    }

    score += Math.min(
      descriptionMatches * 2,
      10
    );

    /*
     * Ignore weak matches.
     */
    if (score < 20) {
      continue;
    }

    scored.push({
      product,
      score
    });
  }

  scored.sort(
    (a, b) => b.score - a.score
  );

  /*
   * Return only the strongest few matches.
   */
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
    availability:
      product.availability || null,
    promotion:
      product.promotion || null,
    category:
      product.category || null,
    sku:
      product.sku || null,

    /*
     * Do not expose private storage paths to OpenAI.
     *
     * Only tell the AI whether a real image exists.
     */
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

  if (!image) {
    return null;
  }

  try {
    return await getProductImageUrl(
      image,
      3600
    );
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
   SEND TEXT / IMAGE
========================================================= */

async function sendReply(
  session,
  remoteJid,
  reply,
  productImageUrl = null,
  product = null
) {
  if (!session?.socket) {
    throw new Error(
      "WhatsApp socket is not available."
    );
  }

  const text = String(reply || "").trim();

  if (!text) {
    return null;
  }

  /*
   * Only send an image when:
   *
   * 1. We have a real uploaded image.
   * 2. We have a clear product match.
   *
   * Never generate or invent an image.
   */
  if (
    productImageUrl &&
    product
  ) {
    try {
      const result =
        await session.socket.sendMessage(
          remoteJid,
          {
            image: {
              url: productImageUrl
            },
            caption: text
          }
        );

      logger.info(
        {
          businessId:
            session.businessId,
          productId:
            product.id,
          productName:
            product.product_name
        },
        "WhatsApp product image reply sent."
      );

      return result;
    } catch (error) {
      /*
       * Important:
       * If the image fails, the customer must still
       * receive the text answer.
       */
      logger.warn(
        {
          businessId:
            session.businessId,
          productId:
            product.id,
          error: error.message
        },
        "Product image send failed. Falling back to text."
      );
    }
  }

  return await session.socket.sendMessage(
    remoteJid,
    {
      text
    }
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

  /*
   * Ignore invalid messages.
   */
  if (!remoteJid || !messageId) {
    return;
  }

  /*
   * Ignore our own messages, groups and status.
   */
  if (
    shouldIgnore(
      remoteJid,
      fromMe
    )
  ) {
    return;
  }

  /*
   * Deduplicate.
   */
  if (processed.has(messageId)) {
    return;
  }

  rememberMessage(messageId);

  /*
   * Extract customer text.
   */
  const text =
    extractText(message);

  if (!text) {
    return;
  }

  /*
   * Use the socket supplied by the caller.
   * Fall back to session.socket.
   */
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

  logger.info(
    {
      sessionId:
        session?.sessionId,
      businessId:
        session?.businessId,
      customerPhone,
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
        error: error.message
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
        customerPhone || remoteJid,

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
    business =
      await getBusinessById(
        session.businessId
      );
  } catch (error) {
    logger.error(
      {
        businessId:
          session.businessId,
        error: error.message
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
     LOAD BUSINESS CATALOG
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
    /*
     * Catalog failure must NOT stop normal AI.
     */
    logger.warn(
      {
        businessId:
          session.businessId,
        error: error.message
      },
      "Product catalog lookup failed. Continuing without catalog."
    );

    catalog = [];
  }

  /* =======================================================
     FIND RELEVANT PRODUCTS
  ======================================================= */

  const relevantProducts =
    findRelevantProducts(
      catalog,
      text
    );

  const productContext =
    buildProductContext(
      relevantProducts
    );

  logger.info(
    {
      businessId:
        session.businessId,
      customerPhone,
      messageText:
        text,
      matchedProducts:
        relevantProducts.map(
          (product) => ({
            id: product.id,
            name: product.product_name
          })
        )
    },
    "Relevant product lookup completed."
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
        messageText:
          text,

        /*
         * ai.js will use this on the next step.
         */
        products:
          productContext
      });
  } catch (error) {
    logger.error(
      {
        businessId:
          session.businessId,
        customerPhone,
        error: error.message
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
          result?.error || "Unknown AI error"
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
     PRODUCT IMAGE
  ======================================================= */

  let productImageUrl = null;
  let matchedProduct = null;

  /*
   * Only attach an image when there is one clear match.
   *
   * If several products match, we don't risk sending the
   * wrong product image.
   */
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
      await sendReply(
        {
          ...session,
          socket:
            whatsappSocket
        },
        remoteJid,
        reply,
        productImageUrl,
        matchedProduct
      );
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

      metadata:
        matchedProduct
          ? {
              product_id:
                matchedProduct.id,

              product_name:
                matchedProduct.product_name,

              product_image_sent:
                Boolean(
                  productImageUrl
                )
            }
          : null
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

      messageId:
        sent?.key?.id || null,

      productId:
        matchedProduct?.id || null,

      productImageSent:
        Boolean(productImageUrl)
    },
    "WhatsApp AI reply completed."
  );

  return {
    ok: true,
    reply,
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
  phoneFromJid
};