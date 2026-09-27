const logger = require("pino")({
  level: process.env.LOG_LEVEL || "info"
});

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const PRODUCT_TABLE =
  process.env.SUPABASE_PRODUCTS_TABLE || "business_products";

const PRODUCT_IMAGES_TABLE =
  process.env.SUPABASE_PRODUCT_IMAGES_TABLE ||
  "business_product_images";

const PRODUCT_IMAGE_BUCKET =
  process.env.SUPABASE_PRODUCT_IMAGE_BUCKET ||
  "business-product-images";

function configured() {
  return Boolean(SUPABASE_URL && SUPABASE_KEY);
}

/* =========================================================
   SUPABASE REST REQUEST
========================================================= */

async function supabaseRequest(path, options = {}) {
  if (!configured()) {
    throw new Error("Supabase is not configured.");
  }

  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...(options.headers || {})
    }
  });

  const text = await response.text();

  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const detail =
      typeof data === "object"
        ? JSON.stringify(data)
        : String(data);

    throw new Error(
      `Supabase ${response.status}: ${detail.slice(0, 500)}`
    );
  }

  return data;
}

/* =========================================================
   BUSINESS
========================================================= */

async function getBusinessById(businessId) {
  if (!configured()) return null;

  if (!businessId) {
    return null;
  }

  const table =
    process.env.SUPABASE_BUSINESSES_TABLE || "businesses";

  const idColumn =
    process.env.BUSINESS_ID_COLUMN || "business_id";

  const path =
    `${encodeURIComponent(table)}` +
    `?select=*` +
    `&${encodeURIComponent(idColumn)}` +
    `=eq.${encodeURIComponent(businessId)}` +
    `&limit=1`;

  const rows = await supabaseRequest(path);

  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  return rows[0];
}

/* =========================================================
   PRODUCTS
========================================================= */

/**
 * Get all active products belonging ONLY to the supplied business.
 *
 * This is intentionally filtered by business_id so one business
 * can never receive another business's catalog.
 */
async function getBusinessProducts(businessId) {
  if (!configured()) {
    return [];
  }

  if (!businessId) {
    return [];
  }

  const select = [
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

  const path =
    `${encodeURIComponent(PRODUCT_TABLE)}` +
    `?select=${encodeURIComponent(select)}` +
    `&business_id=eq.${encodeURIComponent(businessId)}` +
    `&active=eq.true` +
    `&order=product_name.asc` +
    `&limit=200`;

  const rows = await supabaseRequest(path);

  if (!Array.isArray(rows)) {
    return [];
  }

  return rows;
}

/* =========================================================
   PRODUCT IMAGES
========================================================= */

/**
 * Get product images for products belonging to one business.
 *
 * productIds is optional.
 *
 * When supplied, only images belonging to those products are
 * returned.
 */
async function getBusinessProductImages(
  businessId,
  productIds = []
) {
  if (!configured()) {
    return [];
  }

  if (!businessId) {
    return [];
  }

  const cleanProductIds = Array.isArray(productIds)
    ? productIds
        .filter(Boolean)
        .map(String)
        .filter((id) => /^[0-9a-fA-F-]{36}$/.test(id))
    : [];

  const select = [
    "id",
    "product_id",
    "business_id",
    "image_url",
    "storage_path",
    "alt_text",
    "sort_order",
    "created_at"
  ].join(",");

  let path =
    `${encodeURIComponent(PRODUCT_IMAGES_TABLE)}` +
    `?select=${encodeURIComponent(select)}` +
    `&business_id=eq.${encodeURIComponent(businessId)}` +
    `&order=sort_order.asc,created_at.asc`;

  if (cleanProductIds.length > 0) {
    path += `&product_id=in.(${cleanProductIds.join(",")})`;
  }

  path += "&limit=500";

  const rows = await supabaseRequest(path);

  if (!Array.isArray(rows)) {
    return [];
  }

  return rows;
}

/* =========================================================
   PRODUCTS + IMAGES
========================================================= */

/**
 * Loads the complete active catalog for ONE business.
 *
 * Result:
 *
 * [
 *   {
 *     id,
 *     business_id,
 *     product_name,
 *     price,
 *     ...
 *     images: [
 *       {
 *         id,
 *         image_url,
 *         storage_path,
 *         ...
 *       }
 *     ]
 *   }
 * ]
 */
async function getBusinessCatalog(businessId) {
  if (!configured()) {
    return [];
  }

  if (!businessId) {
    return [];
  }

  const products = await getBusinessProducts(businessId);

  if (products.length === 0) {
    return [];
  }

  const productIds = products
    .map((product) => product.id)
    .filter(Boolean);

  const images = await getBusinessProductImages(
    businessId,
    productIds
  );

  const imagesByProduct = new Map();

  for (const image of images) {
    if (!image.product_id) {
      continue;
    }

    if (!imagesByProduct.has(image.product_id)) {
      imagesByProduct.set(image.product_id, []);
    }

    imagesByProduct.get(image.product_id).push(image);
  }

  return products.map((product) => ({
    ...product,
    images: imagesByProduct.get(product.id) || []
  }));
}

/* =========================================================
   SIGNED STORAGE URL
========================================================= */

/**
 * Creates a temporary signed URL for a private product image.
 *
 * The database stores storage_path, for example:
 *
 * BIZ-123456/products/UUID/image.jpg
 *
 * We DO NOT make the bucket public.
 *
 * The URL is generated only when the image needs to be sent
 * to the WhatsApp customer.
 */
async function createProductImageSignedUrl(
  storagePath,
  expiresIn = 3600
) {
  if (!configured()) {
    return null;
  }

  if (!storagePath) {
    return null;
  }

  const cleanPath = String(storagePath).replace(/^\/+/, "");

  if (!cleanPath) {
    return null;
  }

  const bucket = encodeURIComponent(PRODUCT_IMAGE_BUCKET);

  const response = await fetch(
    `${SUPABASE_URL}/storage/v1/object/sign/${bucket}`,
    {
      method: "POST",
      headers: {
        "apikey": SUPABASE_KEY,
        "Authorization": `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        expiresIn: Number(expiresIn) || 3600,
        paths: [cleanPath]
      })
    }
  );

  const text = await response.text();

  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const detail =
      typeof data === "object"
        ? JSON.stringify(data)
        : String(data);

    throw new Error(
      `Supabase Storage ${response.status}: ${detail.slice(0, 500)}`
    );
  }

  /*
   * Supabase's batch signing endpoint returns an array:
   *
   * [
   *   {
   *     path: "...",
   *     signedURL: "/object/sign/..."
   *   }
   * ]
   */

  if (Array.isArray(data)) {
    const result = data[0];

    if (!result) {
      return null;
    }

    if (result.error) {
      throw new Error(
        `Supabase Storage signing failed: ${result.error}`
      );
    }

    if (result.signedURL) {
      return result.signedURL.startsWith("http")
        ? result.signedURL
        : `${SUPABASE_URL}/storage/v1${result.signedURL}`;
    }

    return null;
  }

  /*
   * Also support a single-object response.
   */
  if (data && data.signedURL) {
    return data.signedURL.startsWith("http")
      ? data.signedURL
      : `${SUPABASE_URL}/storage/v1${data.signedURL}`;
  }

  return null;
}

/* =========================================================
   PRODUCT IMAGE URL
========================================================= */

/**
 * Returns the best usable URL for a product image.
 *
 * Priority:
 *
 * 1. storage_path -> fresh signed URL
 * 2. image_url -> existing URL
 *
 * This means private storage remains private while WhatsApp
 * receives a temporary URL when needed.
 */
async function getProductImageUrl(
  image,
  expiresIn = 3600
) {
  if (!image) {
    return null;
  }

  if (image.storage_path) {
    try {
      const signedUrl =
        await createProductImageSignedUrl(
          image.storage_path,
          expiresIn
        );

      if (signedUrl) {
        return signedUrl;
      }
    } catch (error) {
      logger.warn(
        {
          error: error.message,
          storagePath: image.storage_path
        },
        "Could not create product image signed URL."
      );
    }
  }

  if (
    typeof image.image_url === "string" &&
    /^https?:\/\//i.test(image.image_url)
  ) {
    return image.image_url;
  }

  return null;
}

/* =========================================================
   MESSAGES
========================================================= */

async function saveMessage(record) {
  if (!configured()) return false;

  if (
    String(process.env.SAVE_MESSAGES || "true").toLowerCase() !==
    "true"
  ) {
    return false;
  }

  const table =
    process.env.SUPABASE_MESSAGES_TABLE ||
    "whatsapp_messages";

  try {
    await supabaseRequest(
      encodeURIComponent(table),
      {
        method: "POST",
        headers: {
          "Prefer": "return=minimal"
        },
        body: JSON.stringify(record)
      }
    );

    return true;
  } catch (error) {
    logger.warn(
      { error: error.message },
      "Message persistence skipped."
    );

    return false;
  }
}

/* =========================================================
   CUSTOMERS
========================================================= */

async function upsertCustomer(record) {
  if (!configured()) return false;

  const table =
    process.env.SUPABASE_CUSTOMERS_TABLE ||
    "customers";

  try {
    await supabaseRequest(
      encodeURIComponent(table),
      {
        method: "POST",
        headers: {
          "Prefer":
            "resolution=merge-duplicates,return=minimal"
        },
        body: JSON.stringify(record)
      }
    );

    return true;
  } catch (error) {
    logger.warn(
      { error: error.message },
      "Customer persistence skipped."
    );

    return false;
  }
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
  configured,

  // Business
  getBusinessById,

  // Catalog
  getBusinessProducts,
  getBusinessProductImages,
  getBusinessCatalog,

  // Product images
  createProductImageSignedUrl,
  getProductImageUrl,

  // Existing functionality
  saveMessage,
  upsertCustomer
};