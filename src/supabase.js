require("dotenv").config();

const pino = require("pino");

const logger = pino({
  level: process.env.LOG_LEVEL || "info"
});

const SUPABASE_URL =
  process.env.SUPABASE_URL || "";

const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const BUSINESSES_TABLE =
  process.env.SUPABASE_BUSINESSES_TABLE ||
  "businesses";

const PRODUCTS_TABLE =
  process.env.SUPABASE_PRODUCTS_TABLE ||
  "business_products";

const PRODUCT_IMAGES_TABLE =
  process.env.SUPABASE_PRODUCT_IMAGES_TABLE ||
  "business_product_images";

const PROMOTIONS_TABLE =
  process.env.SUPABASE_PROMOTIONS_TABLE ||
  "business_promotions";

const PROMOTION_IMAGES_TABLE =
  process.env.SUPABASE_PROMOTION_IMAGES_TABLE ||
  "business_promotion_images";

const PROMOTION_INTROS_TABLE =
  process.env.SUPABASE_PROMOTION_INTROS_TABLE ||
  "business_promotion_introductions";

const CUSTOMERS_TABLE =
  process.env.SUPABASE_CUSTOMERS_TABLE ||
  "customers";

const MESSAGES_TABLE =
  process.env.SUPABASE_MESSAGES_TABLE ||
  "messages";

const PRODUCT_IMAGE_BUCKET =
  process.env.SUPABASE_PRODUCT_IMAGE_BUCKET ||
  "business-product-images";

const PROMOTION_IMAGE_BUCKET =
  process.env.SUPABASE_PROMOTION_IMAGE_BUCKET ||
  "business-promotion-images";

const PRODUCT_CATALOG_LIMIT =
  Math.max(
    20,
    Number(
      process.env.PRODUCT_CATALOG_LIMIT ||
      100
    )
  );

function supabaseConfigured() {
  return Boolean(
    SUPABASE_URL &&
    SUPABASE_SERVICE_ROLE_KEY
  );
}

function encodeEq(column, value) {
  return `${encodeURIComponent(column)}=eq.${encodeURIComponent(
    String(value)
  )}`;
}

async function supabaseRequest(
  table,
  query = "",
  options = {}
) {
  if (!supabaseConfigured()) {
    throw new Error(
      "Supabase is not configured."
    );
  }

  const base =
    SUPABASE_URL.replace(
      /\/$/,
      ""
    );

  const url =
    `${base}/rest/v1/${table}` +
    (query
      ? `?${query}`
      : "");

  const headers = {
    apikey:
      SUPABASE_SERVICE_ROLE_KEY,

    Authorization:
      `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,

    "Content-Type":
      "application/json",

    Prefer:
      options.prefer ||
      "return=representation"
  };

  const response =
    await fetch(
      url,
      {
        method:
          options.method ||
          "GET",

        headers,

        body:
          options.body === undefined
            ? undefined
            : JSON.stringify(
                options.body
              )
      }
    );

  const raw =
    await response.text();

  let data = null;

  try {
    data =
      raw
        ? JSON.parse(raw)
        : null;
  } catch {
    data = raw;
  }

  if (!response.ok) {
    throw new Error(
      data?.message ||
      data?.error_description ||
      data?.hint ||
      data?.details ||
      `Supabase request failed with status ${response.status}`
    );
  }

  return data;
}

/* =========================================================
   BUSINESS
========================================================= */

async function getBusinessById(
  businessId
) {
  if (!businessId) {
    return null;
  }

  const columns = [
    "id",
    "business_id",
    "user_id",
    "business_name",
    "full_name",
    "industry",
    "email",
    "location",
    "price_range",
    "ai_number",
    "support_number",
    "working_days",
    "hours",
    "capabilities",
    "personal_goal",
    "services_description",
    "ai_prompt",
    "status",
    "ai_enabled",
    "automation_enabled",
    "account_type",
    "whatsapp_connected"
  ].join(",");

  try {
    const rows =
      await supabaseRequest(
        BUSINESSES_TABLE,
        [
          `select=${encodeURIComponent(
            columns
          )}`,
          encodeEq(
            "business_id",
            businessId
          ),
          "limit=1"
        ].join("&")
      );

    return Array.isArray(rows)
      ? rows[0] || null
      : null;
  } catch (error) {
    /*
     * Some existing production schemas may not yet have
     * whatsapp_connected or ai_prompt. Retry with a core
     * set instead of breaking the whole provider.
     */
    logger.warn(
      {
        businessId,
        error:
          error.message
      },
      "Extended business lookup failed; retrying core business fields."
    );

    const coreColumns = [
      "id",
      "business_id",
      "user_id",
      "business_name",
      "full_name",
      "industry",
      "email",
      "location",
      "price_range",
      "ai_number",
      "support_number",
      "working_days",
      "hours",
      "capabilities",
      "personal_goal",
      "services_description",
      "status",
      "ai_enabled",
      "automation_enabled"
    ].join(",");

    const rows =
      await supabaseRequest(
        BUSINESSES_TABLE,
        [
          `select=${encodeURIComponent(
            coreColumns
          )}`,
          encodeEq(
            "business_id",
            businessId
          ),
          "limit=1"
        ].join("&")
      );

    return Array.isArray(rows)
      ? rows[0] || null
      : null;
  }
}

/* =========================================================
   PRODUCTS
========================================================= */

async function getBusinessCatalog(
  businessId
) {
  if (!businessId) return [];

  const productColumns = [
    "id",
    "business_id",
    "product_name",
    "description",
    "price",
    "currency",
    "availability",
    "promotion",
    "category",
    "sku",
    "active",
    "created_at",
    "updated_at"
  ].join(",");

  const products =
    await supabaseRequest(
      PRODUCTS_TABLE,
      [
        `select=${encodeURIComponent(
          productColumns
        )}`,
        encodeEq(
          "business_id",
          businessId
        ),
        "active=eq.true",
        `limit=${PRODUCT_CATALOG_LIMIT}`,
        "order=product_name.asc"
      ].join("&")
    );

  if (
    !Array.isArray(products) ||
    products.length === 0
  ) {
    return [];
  }

  const productIds =
    products
      .map(
        (product) =>
          product.id
      )
      .filter(Boolean);

  const imagesByProduct =
    new Map();

  if (productIds.length) {
    try {
      const imageColumns = [
        "id",
        "product_id",
        "business_id",
        "image_url",
        "storage_path",
        "alt_text",
        "sort_order",
        "created_at"
      ].join(",");

      const imageQuery = [
        `select=${encodeURIComponent(
          imageColumns
        )}`,
        encodeEq(
          "business_id",
          businessId
        ),
        `product_id=in.(${productIds.join(",")})`,
        "order=sort_order.asc"
      ].join("&");

      const images =
        await supabaseRequest(
          PRODUCT_IMAGES_TABLE,
          imageQuery
        );

      for (
        const image
        of Array.isArray(images)
          ? images
          : []
      ) {
        if (!image?.product_id) {
          continue;
        }

        const list =
          imagesByProduct.get(
            image.product_id
          ) || [];

        list.push({
          id:
            image.id || null,
          image_url:
            image.image_url ||
            null,
          storage_path:
            image.storage_path ||
            null,
          alt_text:
            image.alt_text ||
            null,
          sort_order:
            Number(
              image.sort_order || 0
            )
        });

        imagesByProduct.set(
          image.product_id,
          list
        );
      }
    } catch (error) {
      logger.warn(
        {
          businessId,
          error:
            error.message
        },
        "Product images could not be loaded."
      );
    }
  }

  return products.map(
    (product) => ({
      ...product,
      images:
        (
          imagesByProduct.get(
            product.id
          ) || []
        ).sort(
          (a, b) =>
            a.sort_order -
            b.sort_order
        )
    })
  );
}

/* =========================================================
   STORAGE SIGNING
========================================================= */

async function signStoragePath(
  bucket,
  storagePath,
  expiresIn = 3600
) {
  if (
    !supabaseConfigured() ||
    !storagePath
  ) {
    return null;
  }

  const cleanPath =
    String(storagePath)
      .replace(/^\/+/, "");

  const endpoint =
    `${SUPABASE_URL.replace(
      /\/$/,
      ""
    )}/storage/v1/object/sign/` +
    `${encodeURIComponent(
      bucket
    )}`;

  const response =
    await fetch(
      endpoint,
      {
        method:
          "POST",

        headers: {
          apikey:
            SUPABASE_SERVICE_ROLE_KEY,

          Authorization:
            `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,

          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            expiresIn,
            paths: [
              cleanPath
            ]
          })
      }
    );

  const raw =
    await response.text();

  let data = null;

  try {
    data =
      raw
        ? JSON.parse(raw)
        : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new Error(
      data?.message ||
      data?.error ||
      `Storage signing failed (${response.status})`
    );
  }

  const signed =
    Array.isArray(data)
      ? data[0]
      : data;

  const url =
    signed?.signedURL ||
    signed?.signedUrl ||
    signed?.signed_url ||
    signed?.url ||
    null;

  if (!url) return null;

  if (
    /^https?:\/\//i.test(
      url
    )
  ) {
    return url;
  }

  return (
    `${SUPABASE_URL.replace(
      /\/$/,
      ""
    )}/storage/v1` +
    `${url.startsWith("/")
      ? url
      : `/${url}`}`
  );
}

async function getProductImageUrl(
  image,
  expiresIn = 3600,
  bucket =
    PRODUCT_IMAGE_BUCKET
) {
  if (!image) return null;

  if (image.storage_path) {
    try {
      const signed =
        await signStoragePath(
          bucket,
          image.storage_path,
          expiresIn
        );

      if (signed) {
        return signed;
      }
    } catch (error) {
      logger.warn(
        {
          storagePath:
            image.storage_path,
          bucket,
          error:
            error.message
        },
        "Storage image signing failed."
      );
    }
  }

  if (
    image.image_url &&
    /^https?:\/\//i.test(
      image.image_url
    )
  ) {
    return image.image_url;
  }

  return null;
}

/* =========================================================
   PROMOTIONS
========================================================= */

async function getPromotionsForCustomerIntro(
  businessId,
  customerKey
) {
  if (
    !businessId ||
    !customerKey
  ) {
    return [];
  }

  const now =
    new Date().toISOString();

  const promotionColumns = [
    "id",
    "business_id",
    "title",
    "description",
    "price",
    "currency",
    "promotion_type",
    "valid_from",
    "valid_until",
    "active",
    "created_at",
    "updated_at"
  ].join(",");

  const query = [
    `select=${encodeURIComponent(
      promotionColumns
    )}`,
    encodeEq(
      "business_id",
      businessId
    ),
    "active=eq.true",
    `or=${encodeURIComponent(
      `valid_from.is.null,valid_from.lte.${now}`
    )}`,
    `or=${encodeURIComponent(
      `valid_until.is.null,valid_until.gte.${now}`
    )}`,
    "order=created_at.asc",
    "limit=50"
  ].join("&");

  let promotions =
    await supabaseRequest(
      PROMOTIONS_TABLE,
      query
    );

  if (!Array.isArray(promotions)) {
    promotions = [];
  }

  if (!promotions.length) {
    return [];
  }

  /*
   * Load all promotion images for this business.
   */
  const promotionIds =
    promotions
      .map(
        (promotion) =>
          promotion.id
      )
      .filter(Boolean);

  const imagesByPromotion =
    new Map();

  if (promotionIds.length) {
    try {
      const imageColumns = [
        "id",
        "promotion_id",
        "business_id",
        "image_url",
        "storage_path",
        "alt_text",
        "sort_order",
        "created_at"
      ].join(",");

      const imageQuery = [
        `select=${encodeURIComponent(
          imageColumns
        )}`,
        encodeEq(
          "business_id",
          businessId
        ),
        `promotion_id=in.(${promotionIds.join(",")})`,
        "order=sort_order.asc"
      ].join("&");

      const images =
        await supabaseRequest(
          PROMOTION_IMAGES_TABLE,
          imageQuery
        );

      for (
        const image
        of Array.isArray(images)
          ? images
          : []
      ) {
        if (
          !image?.promotion_id
        ) {
          continue;
        }

        const list =
          imagesByPromotion.get(
            image.promotion_id
          ) || [];

        list.push({
          id:
            image.id || null,
          image_url:
            image.image_url ||
            null,
          storage_path:
            image.storage_path ||
            null,
          alt_text:
            image.alt_text ||
            null,
          sort_order:
            Number(
              image.sort_order || 0
            )
        });

        imagesByPromotion.set(
          image.promotion_id,
          list
        );
      }
    } catch (error) {
      logger.warn(
        {
          businessId,
          error:
            error.message
        },
        "Promotion images could not be loaded."
      );
    }
  }

  /*
   * Read which promotions this customer has already received.
   *
   * We store the promotion's updated_at at introduction time.
   * If the owner edits a promotion later, the new updated_at causes
   * it to be introduced again once.
   */
  let introductions = [];

  try {
    const introColumns = [
      "promotion_id",
      "customer_key",
      "promotion_updated_at",
      "introduced_at"
    ].join(",");

    introductions =
      await supabaseRequest(
        PROMOTION_INTROS_TABLE,
        [
          `select=${encodeURIComponent(
            introColumns
          )}`,
          encodeEq(
            "business_id",
            businessId
          ),
          encodeEq(
            "customer_key",
            customerKey
          ),
          `promotion_id=in.(${promotionIds.join(",")})`,
          "limit=100"
        ].join("&")
      );
  } catch (error) {
    /*
     * If the intro table hasn't been deployed yet, do not silently
     * repeat promotions forever. Return no promotion introductions
     * until the schema is installed.
     */
    logger.error(
      {
        businessId,
        customerKey,
        error:
          error.message
      },
      "Promotion introduction state table is unavailable."
    );

    return [];
  }

  const introMap =
    new Map();

  for (
    const intro
    of Array.isArray(
      introductions
    )
      ? introductions
      : []
  ) {
    introMap.set(
      String(
        intro.promotion_id
      ),
      intro
    );
  }

  return promotions
    .filter(
      (promotion) => {
        const previous =
          introMap.get(
            String(
              promotion.id
            )
          );

        if (!previous) {
          return true;
        }

        const previousVersion =
          previous.promotion_updated_at
            ? new Date(
                previous.promotion_updated_at
              ).getTime()
            : 0;

        const currentVersion =
          promotion.updated_at
            ? new Date(
                promotion.updated_at
              ).getTime()
            : 0;

        return (
          currentVersion >
          previousVersion
        );
      }
    )
    .map(
      (promotion) => ({
        ...promotion,
        images:
          (
            imagesByPromotion.get(
              promotion.id
            ) || []
          ).sort(
            (a, b) =>
              a.sort_order -
              b.sort_order
          )
      })
    );
}

async function markPromotionIntroduced({
  businessId,
  promotionId,
  customerKey,
  promotionUpdatedAt
}) {
  if (
    !businessId ||
    !promotionId ||
    !customerKey
  ) {
    return;
  }

  /*
   * Upsert requires the SQL table to have a unique constraint on:
   * business_id, promotion_id, customer_key
   */
  await supabaseRequest(
    PROMOTION_INTROS_TABLE,
    "on_conflict=business_id,promotion_id,customer_key",
    {
      method:
        "POST",

      prefer:
        "resolution=merge-duplicates,return=minimal",

      body: {
        business_id:
          businessId,
        promotion_id:
          promotionId,
        customer_key:
          customerKey,
        promotion_updated_at:
          promotionUpdatedAt ||
          null,
        introduced_at:
          new Date().toISOString()
      }
    }
  );
}

/* =========================================================
   MESSAGE / CUSTOMER
========================================================= */

async function saveMessage({
  business_id,
  channel,
  direction,
  customer_phone,
  message,
  message_id,
  metadata = null
}) {
  if (!supabaseConfigured()) {
    return null;
  }

  /*
   * Preserve the existing provider contract.
   * If the messages table has no metadata column, retry without it.
   */
  try {
    const result =
      await supabaseRequest(
        MESSAGES_TABLE,
        "",
        {
          method:
            "POST",

          prefer:
            "return=minimal",

          body: {
            business_id,
            channel,
            direction,
            customer_phone,
            message,
            message_id,
            metadata
          }
        }
      );

    return result;
  } catch (error) {
    if (metadata !== null) {
      return supabaseRequest(
        MESSAGES_TABLE,
        "",
        {
          method:
            "POST",

          prefer:
            "return=minimal",

          body: {
            business_id,
            channel,
            direction,
            customer_phone,
            message,
            message_id
          }
        }
      );
    }

    throw error;
  }
}

async function upsertCustomer({
  business_id,
  channel,
  channel_customer_id,
  phone,
  last_message,
  updated_at
}) {
  if (!supabaseConfigured()) {
    return null;
  }

  return supabaseRequest(
    CUSTOMERS_TABLE,
    "on_conflict=business_id,channel,channel_customer_id",
    {
      method:
        "POST",

      prefer:
        "resolution=merge-duplicates,return=minimal",

      body: {
        business_id,
        channel,
        channel_customer_id,
        phone,
        last_message,
        updated_at:
          updated_at ||
          new Date().toISOString()
      }
    }
  );
}

module.exports = {
  supabaseConfigured,
  supabaseRequest,
  getBusinessById,
  getBusinessCatalog,
  getProductImageUrl,
  getPromotionsForCustomerIntro,
  markPromotionIntroduced,
  saveMessage,
  upsertCustomer,
  PRODUCT_IMAGE_BUCKET,
  PROMOTION_IMAGE_BUCKET
};
