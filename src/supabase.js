const logger = require("pino")({ level: process.env.LOG_LEVEL || "info" });

const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

function configured() {
  return Boolean(SUPABASE_URL && SUPABASE_KEY);
}

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
    try { data = JSON.parse(text); } catch { data = text; }
  }

  if (!response.ok) {
    const detail =
      typeof data === "object" ? JSON.stringify(data) : String(data);
    throw new Error(`Supabase ${response.status}: ${detail.slice(0, 500)}`);
  }

  return data;
}

async function getBusinessById(businessId) {
  if (!configured()) return null;

  const table = process.env.SUPABASE_BUSINESSES_TABLE || "businesses";
  const idColumn = process.env.BUSINESS_ID_COLUMN || "business_id";

  const path =
    `${encodeURIComponent(table)}?select=*&${encodeURIComponent(idColumn)}=eq.${encodeURIComponent(businessId)}&limit=1`;

  const rows = await supabaseRequest(path);

  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  return rows[0];
}

async function saveMessage(record) {
  if (!configured()) return false;
  if (String(process.env.SAVE_MESSAGES || "true").toLowerCase() !== "true") return false;

  const table = process.env.SUPABASE_MESSAGES_TABLE || "whatsapp_messages";

  try {
    await supabaseRequest(encodeURIComponent(table), {
      method: "POST",
      headers: {
        "Prefer": "return=minimal"
      },
      body: JSON.stringify(record)
    });
    return true;
  } catch (error) {
    logger.warn({ error: error.message }, "Message persistence skipped.");
    return false;
  }
}

async function upsertCustomer(record) {
  if (!configured()) return false;

  const table = process.env.SUPABASE_CUSTOMERS_TABLE || "customers";

  try {
    await supabaseRequest(encodeURIComponent(table), {
      method: "POST",
      headers: {
        "Prefer": "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify(record)
    });
    return true;
  } catch (error) {
    logger.warn({ error: error.message }, "Customer persistence skipped.");
    return false;
  }
}

module.exports = {
  configured,
  getBusinessById,
  saveMessage,
  upsertCustomer
};
