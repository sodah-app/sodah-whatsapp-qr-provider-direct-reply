require("dotenv").config();

const express = require("express");
const cors = require("cors");
const pino = require("pino");
const QRCode = require("qrcode");
const fs = require("fs");
const path = require("path");

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require("@whiskeysockets/baileys");

const { handleIncomingMessage } = require("./message-handler");

/*
|--------------------------------------------------------------------------
| APP
|--------------------------------------------------------------------------
*/

const app = express();

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
});

/*
|--------------------------------------------------------------------------
| SERVER
|--------------------------------------------------------------------------
*/

const PORT = Number(process.env.PORT || 3002);
const HOST = process.env.HOST || "0.0.0.0";

/*
|--------------------------------------------------------------------------
| API AUTHENTICATION
|--------------------------------------------------------------------------
*/

const API_KEY = process.env.PROVIDER_API_KEY || "";

/*
|--------------------------------------------------------------------------
| WHATSAPP AUTH STORAGE
|--------------------------------------------------------------------------
*/

const AUTH_DIR = path.resolve(
  process.env.AUTH_DIR || "./data/auth"
);

/*
|--------------------------------------------------------------------------
| AI
|--------------------------------------------------------------------------
*/

const AI_ENABLED =
  String(process.env.AI_ENABLED || "false").toLowerCase() ===
  "true";

const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || "";

const OPENAI_MODEL =
  process.env.OPENAI_MODEL || "gpt-4o-mini";

/*
|--------------------------------------------------------------------------
| SUPABASE
|--------------------------------------------------------------------------
*/

const SUPABASE_URL =
  process.env.SUPABASE_URL || "";

const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const SUPABASE_BUSINESSES_TABLE =
  process.env.SUPABASE_BUSINESSES_TABLE || "businesses";

const BUSINESS_ID_COLUMN =
  process.env.BUSINESS_ID_COLUMN || "business_id";

const BUSINESS_NAME_COLUMN =
  process.env.BUSINESS_NAME_COLUMN || "business_name";

const BUSINESS_PROMPT_COLUMN =
  process.env.BUSINESS_PROMPT_COLUMN || "ai_prompt";

const BUSINESS_PHONE_COLUMN =
  process.env.BUSINESS_PHONE_COLUMN || "ai_number";

const BUSINESS_CONNECTED_COLUMN =
  process.env.BUSINESS_CONNECTED_COLUMN ||
  "whatsapp_connected";

/*
|--------------------------------------------------------------------------
| MESSAGE OPTIONS
|--------------------------------------------------------------------------
*/

const IGNORE_GROUPS =
  String(process.env.IGNORE_GROUPS || "true").toLowerCase() ===
  "true";

const IGNORE_STATUS =
  String(process.env.IGNORE_STATUS || "true").toLowerCase() ===
  "true";

const IGNORE_FROM_ME =
  String(process.env.IGNORE_FROM_ME || "true").toLowerCase() ===
  "true";

const MESSAGE_DEDUP_TTL_SECONDS = Number(
  process.env.MESSAGE_DEDUP_TTL_SECONDS || 120
);

/*
|--------------------------------------------------------------------------
| FALLBACK
|--------------------------------------------------------------------------
*/

const FALLBACK_REPLY =
  process.env.FALLBACK_REPLY ||
  "Thanks for your message. We received it and will get back to you shortly.";

const DEFAULT_AI_PROMPT =
  process.env.DEFAULT_AI_PROMPT ||
  `
You are the AI assistant for this business.

Respond naturally and professionally to the customer.

Follow the business instructions provided to you.

Use emojis naturally when appropriate.

Do not mention that you are an AI unless the customer specifically asks.

Keep the conversation helpful, friendly and conversational.

Answer the customer's actual message instead of using a generic acknowledgement.
`.trim();

/*
|--------------------------------------------------------------------------
| DIRECTORY
|--------------------------------------------------------------------------
*/

fs.mkdirSync(AUTH_DIR, {
  recursive: true,
});

/*
|--------------------------------------------------------------------------
| EXPRESS
|--------------------------------------------------------------------------
*/

app.use(
  express.json({
    limit: "2mb",
  })
);

app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "*",
  })
);

/*
|--------------------------------------------------------------------------
| SESSION STORAGE
|--------------------------------------------------------------------------
*/

const sessions = new Map();

/*
|--------------------------------------------------------------------------
| MESSAGE DEDUPLICATION
|--------------------------------------------------------------------------
*/

const processedMessages = new Map();

function cleanupProcessedMessages() {
  const now = Date.now();

  for (const [id, timestamp] of processedMessages.entries()) {
    if (
      now - timestamp >
      MESSAGE_DEDUP_TTL_SECONDS * 1000
    ) {
      processedMessages.delete(id);
    }
  }
}

setInterval(
  cleanupProcessedMessages,
  30000
);

/*
|--------------------------------------------------------------------------
| AUTHENTICATION
|--------------------------------------------------------------------------
*/

function auth(req, res, next) {
  /*
   * Health is always public.
   */
  if (req.path === "/health") {
    return next();
  }

  /*
   * If no API key is configured, allow requests.
   *
   * This is useful during initial setup.
   */
  if (!API_KEY) {
    return next();
  }

  const authorization =
    req.headers.authorization || "";

  const token =
    authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";

  if (token !== API_KEY) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized.",
    });
  }

  next();
}

app.use(auth);

/*
|--------------------------------------------------------------------------
| HELPERS
|--------------------------------------------------------------------------
*/

function safeId(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 180);
}

function getAuthFolder(sessionId) {
  return path.join(
    AUTH_DIR,
    safeId(sessionId)
  );
}

function publicSession(session) {
  return {
    sessionId: session.sessionId,

    businessId: session.businessId,

    status: session.status,

    connected:
      session.status === "connected",

    phoneNumber:
      session.phoneNumber || null,

    qrCode:
      session.qrCode || null,

    lastError:
      session.lastError || null,

    updatedAt:
      session.updatedAt,
  };
}

/*
|--------------------------------------------------------------------------
| MESSAGE TEXT EXTRACTION
|--------------------------------------------------------------------------
*/

function extractMessageText(message) {
  if (!message?.message) {
    return "";
  }

  return (
    message.message.conversation ||
    message.message.extendedTextMessage?.text ||
    message.message.imageMessage?.caption ||
    message.message.videoMessage?.caption ||
    message.message.documentMessage?.caption ||
    ""
  );
}

/*
|--------------------------------------------------------------------------
| BUSINESS CONFIGURATION
|--------------------------------------------------------------------------
*/

async function getBusinessConfiguration(
  businessId
) {
  /*
   * Supabase isn't configured.
   */
  if (
    !SUPABASE_URL ||
    !SUPABASE_SERVICE_ROLE_KEY
  ) {
    logger.warn(
      {
        businessId,
      },
      "Supabase business configuration is not configured. Using default AI prompt."
    );

    return {
      businessId,
      businessName: null,
      aiPrompt: DEFAULT_AI_PROMPT,
      aiNumber: null,
      whatsappConnected: null,
    };
  }

  try {
    const columns = [
      BUSINESS_ID_COLUMN,
      BUSINESS_NAME_COLUMN,
      BUSINESS_PROMPT_COLUMN,
      BUSINESS_PHONE_COLUMN,
      BUSINESS_CONNECTED_COLUMN,
    ].join(",");

    const baseUrl =
      SUPABASE_URL.replace(/\/$/, "");

    const url =
      `${baseUrl}/rest/v1/${SUPABASE_BUSINESSES_TABLE}` +
      `?select=${encodeURIComponent(columns)}` +
      `&${encodeURIComponent(
        BUSINESS_ID_COLUMN
      )}=eq.${encodeURIComponent(businessId)}` +
      `&limit=1`;

    const response = await fetch(
      url,
      {
        method: "GET",

        headers: {
          apikey:
            SUPABASE_SERVICE_ROLE_KEY,

          Authorization:
            `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,

          "Content-Type":
            "application/json",
        },
      }
    );

    const data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data?.message ||
          data?.error_description ||
          `Supabase request failed with status ${response.status}`
      );
    }

    const business =
      Array.isArray(data)
        ? data[0]
        : null;

    if (!business) {
      logger.warn(
        {
          businessId,
        },
        "Business configuration not found. Using default AI prompt."
      );

      return {
        businessId,
        businessName: null,
        aiPrompt: DEFAULT_AI_PROMPT,
        aiNumber: null,
        whatsappConnected: null,
      };
    }

    const aiPrompt =
      String(
        business[BUSINESS_PROMPT_COLUMN] ||
          ""
      ).trim();

    const result = {
      businessId,

      businessName:
        business[BUSINESS_NAME_COLUMN] ||
        null,

      aiPrompt:
        aiPrompt || DEFAULT_AI_PROMPT,

      aiNumber:
        business[BUSINESS_PHONE_COLUMN] ||
        null,

      whatsappConnected:
        business[BUSINESS_CONNECTED_COLUMN] ??
        null,
    };

    logger.info(
      {
        businessId,
        businessName:
          result.businessName,
        hasBusinessPrompt:
          Boolean(aiPrompt),
      },
      "Business AI configuration loaded."
    );

    return result;
  } catch (error) {
    logger.error(
      {
        businessId,
        error:
          error?.message,
      },
      "Failed to load business configuration. Using default AI prompt."
    );

    return {
      businessId,
      businessName: null,
      aiPrompt: DEFAULT_AI_PROMPT,
      aiNumber: null,
      whatsappConnected: null,
    };
  }
}

/*
|--------------------------------------------------------------------------
| CREATE WHATSAPP SESSION
|--------------------------------------------------------------------------
*/

async function createSession(
  sessionId,
  businessId
) {
  const id =
    safeId(sessionId);

  if (!id) {
    throw new Error(
      "sessionId is required."
    );
  }

  if (!businessId) {
    throw new Error(
      "businessId is required."
    );
  }

  /*
   * Return existing session.
   */
  if (sessions.has(id)) {
    return sessions.get(id);
  }

  const authPath =
    getAuthFolder(id);

  fs.mkdirSync(
    authPath,
    {
      recursive: true,
    }
  );

  /*
   * Load or create WhatsApp authentication.
   */
  const {
    state,
    saveCreds,
  } = await useMultiFileAuthState(
    authPath
  );

  const registered =
    Boolean(
      state.creds.registered
    );

  const session = {
    sessionId: id,

    businessId:
      String(businessId),

    status:
      registered
        ? "connecting"
        : "qr_pending",

    phoneNumber:
      state.creds.me?.id
        ?.split(":")[0] || null,

    qrCode: null,

    lastError: null,

    updatedAt:
      new Date().toISOString(),

    socket: null,

    reconnectTimer: null,
  };

  sessions.set(
    id,
    session
  );

  logger.info(
    {
      sessionId: id,
      businessId,
      registered,
    },
    "Starting WhatsApp session."
  );

  /*
   * Create WhatsApp socket.
   */
  const socket =
    makeWASocket({
      auth: state,

      logger: pino({
        level: "silent",
      }),

      printQRInTerminal: false,

      browser: [
        "Sodah",
        "Chrome",
        "1.0.0",
      ],

      markOnlineOnConnect: false,

      syncFullHistory: false,
    });

  session.socket =
    socket;

  /*
   * Save WhatsApp credentials.
   */
  socket.ev.on(
    "creds.update",
    saveCreds
  );

  /*
  |--------------------------------------------------------------------------
  | CONNECTION UPDATE
  |--------------------------------------------------------------------------
  */

  socket.ev.on(
    "connection.update",
    async (update) => {
      const {
        connection,
        lastDisconnect,
        qr,
      } = update;

      session.updatedAt =
        new Date().toISOString();

      /*
       * QR CODE GENERATED
       */
      if (qr) {
        try {
          session.qrCode =
            await QRCode.toDataURL(
              qr,
              {
                width: 420,
                margin: 2,
                errorCorrectionLevel:
                  "M",
              }
            );

          session.status =
            "qr_pending";

          session.lastError =
            null;

          logger.info(
            {
              sessionId: id,
              businessId,
            },
            "WhatsApp QR code generated."
          );
        } catch (error) {
          session.status =
            "error";

          session.lastError =
            error?.message ||
            "QR generation failed.";

          logger.error(
            {
              sessionId: id,
              businessId,
              error:
                error?.message,
            },
            "QR generation failed."
          );
        }
      }

      /*
       * CONNECTING
       */
      if (
        connection ===
        "connecting"
      ) {
        if (!session.qrCode) {
          session.status =
            "connecting";
        }

        logger.info(
          {
            sessionId: id,
            businessId,
          },
          "WhatsApp connecting."
        );
      }

      /*
       * CONNECTED
       */
      if (
        connection === "open"
      ) {
        session.status =
          "connected";

        session.qrCode =
          null;

        session.lastError =
          null;

        session.phoneNumber =
          (
            socket.user?.id ||
            state.creds.me?.id ||
            ""
          )
            .split(":")[0] ||
          null;

        session.updatedAt =
          new Date().toISOString();

        logger.info(
          {
            sessionId: id,
            businessId,
            phoneNumber:
              session.phoneNumber,
          },
          "WhatsApp connected."
        );
      }

      /*
       * DISCONNECTED
       */
      if (
        connection === "close"
      ) {
        const code =
          lastDisconnect
            ?.error
            ?.output
            ?.statusCode;

        session.updatedAt =
          new Date().toISOString();

        logger.warn(
          {
            sessionId: id,
            businessId,
            code,
          },
          "WhatsApp connection closed."
        );

        /*
         * LOGGED OUT
         */
        if (
          code ===
          DisconnectReason.loggedOut
        ) {
          session.status =
            "disconnected";

          session.qrCode =
            null;

          session.lastError =
            "WhatsApp session was logged out.";

          return;
        }

        /*
         * BAD SESSION
         */
        if (
          code ===
          DisconnectReason.badSession
        ) {
          session.status =
            "disconnected";

          session.qrCode =
            null;

          session.lastError =
            "WhatsApp authentication session is invalid.";

          return;
        }

        /*
         * TEMPORARY FAILURE
         */
        session.status =
          "reconnecting";

        session.qrCode =
          null;

        session.lastError =
          lastDisconnect
            ?.error
            ?.message ||
          "WhatsApp connection closed.";

        /*
         * Avoid multiple reconnect timers.
         */
        if (
          session.reconnectTimer
        ) {
          return;
        }

        session.reconnectTimer =
          setTimeout(
            async () => {
              session.reconnectTimer =
                null;

              if (
                sessions.get(id) !==
                session
              ) {
                return;
              }

              try {
                sessions.delete(id);

                await createSession(
                  id,
                  businessId
                );

                logger.info(
                  {
                    sessionId: id,
                    businessId,
                  },
                  "WhatsApp session recreated."
                );
              } catch (error) {
                logger.error(
                  {
                    sessionId: id,
                    businessId,
                    error:
                      error?.message,
                  },
                  "WhatsApp reconnect failed."
                );
              }
            },
            3000
          );
      }
    }
  );

  /*
  |--------------------------------------------------------------------------
  | INCOMING MESSAGES
  |--------------------------------------------------------------------------
  */

  socket.ev.on(
    "messages.upsert",
    async ({
      messages,
      type,
    }) => {
      /*
       * Only process new notifications.
       */
      if (
        type !== "notify"
      ) {
        return;
      }

      for (
        const message of messages
      ) {
        try {
          if (
            !message?.message
          ) {
            continue;
          }

          /*
           * Ignore messages sent
           * by the business itself.
           */
          if (
            IGNORE_FROM_ME &&
            message.key?.fromMe
          ) {
            continue;
          }

          const from =
            message.key
              ?.remoteJid || "";

          /*
           * Ignore WhatsApp status.
           */
          if (
            IGNORE_STATUS &&
            from ===
              "status@broadcast"
          ) {
            continue;
          }

          /*
           * Ignore groups.
           */
          if (
            IGNORE_GROUPS &&
            from.endsWith(
              "@g.us"
            )
          ) {
            continue;
          }

          /*
           * Extract message text.
           */
          const text =
            extractMessageText(
              message
            );

          if (
            !text.trim()
          ) {
            continue;
          }

          /*
           * Message ID.
           */
          const messageId =
            message.key?.id;

          if (!messageId) {
            continue;
          }

          /*
           * Prevent duplicate processing.
           */
          if (
            processedMessages.has(
              messageId
            )
          ) {
            continue;
          }

          processedMessages.set(
            messageId,
            Date.now()
          );

          logger.info(
            {
              sessionId: id,
              businessId,
              from,
              text,
              messageId,
            },
            "Incoming WhatsApp message."
          );

          /*
           * Direct AI reply.
           */
          await handleIncomingMessage({
            session,
            message,
            socket,
          });
        } catch (error) {
          logger.error(
            {
              sessionId: id,
              businessId,
              error:
                error?.message,
            },
            "Incoming message processing failed."
          );
        }
      }
    }
  );

  return session;
}

/*
|--------------------------------------------------------------------------
| HEALTH
|--------------------------------------------------------------------------
*/

app.get(
  "/health",
  (req, res) => {
    res.json({
      success: true,

      service:
        "sodah-whatsapp-qr-provider",

      status:
        "ok",

      sessions:
        sessions.size,

      aiEnabled:
        AI_ENABLED,

      openaiConfigured:
        Boolean(
          OPENAI_API_KEY
        ),

      openaiModel:
        OPENAI_MODEL,

      supabaseConfigured:
        Boolean(
          SUPABASE_URL &&
          SUPABASE_SERVICE_ROLE_KEY
        ),

      port:
        PORT,

      time:
        new Date().toISOString(),
    });
  }
);

/*
|--------------------------------------------------------------------------
| ROOT
|--------------------------------------------------------------------------
*/

app.get(
  "/",
  (req, res) => {
    res.json({
      service:
        "sodah-whatsapp-qr-provider",

      status:
        "online",

      health:
        "/health",

      qr:
        "/qr?sessionId=SESSION_ID&businessId=BUSINESS_ID",

      endpoints: {
        createSession:
          "POST /session/create",

        status:
          "GET /session/:sessionId/status",

        qr:
          "GET /session/:sessionId/qr",

        send:
          "POST /session/:sessionId/send",

        logout:
          "POST /session/:sessionId/logout",

        delete:
          "DELETE /session/:sessionId",
      },
    });
  }
);

/*
|--------------------------------------------------------------------------
| SIMPLE /QR ENDPOINT
|--------------------------------------------------------------------------
|
| This is the endpoint we specifically added so:
|
| /qr?sessionId=...&businessId=...
|
| works directly.
|
*/

app.get(
  "/qr",
  async (req, res) => {
    try {
      const requestedSessionId =
        req.query.sessionId ||
        req.query.businessId;

      const requestedBusinessId =
        req.query.businessId ||
        req.query.sessionId;

      const sessionId =
        safeId(
          requestedSessionId
        );

      const businessId =
        String(
          requestedBusinessId || ""
        ).trim();

      if (!sessionId) {
        return res.status(400).json({
          success: false,
          message:
            "sessionId is required.",
        });
      }

      if (!businessId) {
        return res.status(400).json({
          success: false,
          message:
            "businessId is required.",
        });
      }

      let session =
        sessions.get(
          sessionId
        );

      /*
       * Automatically create session.
       */
      if (!session) {
        logger.info(
          {
            sessionId,
            businessId,
          },
          "Creating WhatsApp session from /qr."
        );

        session =
          await createSession(
            sessionId,
            businessId
          );
      }

      /*
       * Already connected.
       */
      if (
        session.status ===
        "connected"
      ) {
        return res.json({
          success: true,

          sessionId:
            session.sessionId,

          businessId:
            session.businessId,

          status:
            "connected",

          connected:
            true,

          qrCode:
            null,

          phoneNumber:
            session.phoneNumber ||
            null,
        });
      }

      /*
       * Give Baileys a short amount
       * of time to generate QR.
       */
      if (
        !session.qrCode
      ) {
        await new Promise(
          (resolve) =>
            setTimeout(
              resolve,
              2000
            )
        );
      }

      /*
       * QR available.
       */
      if (
        session.qrCode
      ) {
        return res.json({
          success: true,

          sessionId:
            session.sessionId,

          businessId:
            session.businessId,

          status:
            "qr_pending",

          connected:
            false,

          qrCode:
            session.qrCode,

          phoneNumber:
            session.phoneNumber ||
            null,
        });
      }

      /*
       * Still starting.
       */
      return res.status(202).json({
        success: true,

        sessionId:
          session.sessionId,

        businessId:
          session.businessId,

        status:
          session.status ||
          "connecting",

        connected:
          false,

        qrCode:
          null,

        phoneNumber:
          session.phoneNumber ||
          null,

        message:
          "WhatsApp session is starting. Please request the QR code again shortly.",
      });
    } catch (error) {
      logger.error(
        {
          error:
            error?.message,
        },
        "GET /qr failed."
      );

      return res.status(500).json({
        success: false,

        message:
          error?.message ||
          "Unable to generate WhatsApp QR code.",
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| CREATE SESSION
|--------------------------------------------------------------------------
*/

app.post(
  "/session/create",
  async (req, res) => {
    try {
      const {
        sessionId,
        businessId,
      } = req.body || {};

      if (!sessionId) {
        return res.status(400).json({
          success: false,
          message:
            "sessionId is required.",
        });
      }

      if (!businessId) {
        return res.status(400).json({
          success: false,
          message:
            "businessId is required.",
        });
      }

      const session =
        await createSession(
          sessionId,
          businessId
        );

      /*
       * Give Baileys time to emit
       * the first QR event.
       */
      if (
        session.status ===
          "qr_pending" &&
        !session.qrCode
      ) {
        await new Promise(
          (resolve) =>
            setTimeout(
              resolve,
              2000
            )
        );
      }

      return res.json({
        success: true,

        ...publicSession(
          session
        ),
      });
    } catch (error) {
      logger.error(
        {
          error:
            error?.message,
        },
        "Create session failed."
      );

      return res.status(500).json({
        success: false,

        message:
          error?.message ||
          "Unable to create WhatsApp session.",
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| SESSION STATUS
|--------------------------------------------------------------------------
*/

app.get(
  "/session/:sessionId/status",
  async (req, res) => {
    try {
      const id =
        safeId(
          req.params.sessionId
        );

      if (!id) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid session ID.",
        });
      }

      const session =
        sessions.get(id);

      /*
       * Do NOT silently create a session
       * here without knowing the business ID.
       */
      if (!session) {
        return res.status(404).json({
          success: false,
          message:
            "Session not found.",
          sessionId:
            id,
        });
      }

      return res.json({
        success: true,

        ...publicSession(
          session
        ),
      });
    } catch (error) {
      logger.error(
        {
          error:
            error?.message,
        },
        "Status request failed."
      );

      return res.status(500).json({
        success: false,

        message:
          error?.message ||
          "Unable to get WhatsApp session status.",
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| SESSION QR
|--------------------------------------------------------------------------
*/

app.get(
  "/session/:sessionId/qr",
  async (req, res) => {
    try {
      const id =
        safeId(
          req.params.sessionId
        );

      if (!id) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid session ID.",
        });
      }

      let session =
        sessions.get(id);

      /*
       * If the session does not exist,
       * businessId must be supplied.
       */
      if (!session) {
        const businessId =
          String(
            req.query.businessId ||
              ""
          ).trim();

        if (!businessId) {
          return res.status(404).json({
            success: false,

            message:
              "Session not found. Provide businessId to create it.",
          });
        }

        session =
          await createSession(
            id,
            businessId
          );
      }

      /*
       * Already connected.
       */
      if (
        session.status ===
        "connected"
      ) {
        return res.json({
          success: true,

          sessionId:
            session.sessionId,

          status:
            "connected",

          connected:
            true,

          qrCode:
            null,

          phoneNumber:
            session.phoneNumber ||
            null,
        });
      }

      /*
       * Wait for QR.
       */
      if (
        !session.qrCode
      ) {
        await new Promise(
          (resolve) =>
            setTimeout(
              resolve,
              2000
            )
        );
      }

      /*
       * QR available.
       */
      if (
        session.qrCode
      ) {
        return res.json({
          success: true,

          sessionId:
            session.sessionId,

          status:
            "qr_pending",

          connected:
            false,

          qrCode:
            session.qrCode,

          phoneNumber:
            session.phoneNumber ||
            null,
        });
      }

      /*
       * QR not ready.
       */
      return res.status(202).json({
        success: true,

        sessionId:
          session.sessionId,

        status:
          session.status ||
          "connecting",

        connected:
          false,

        qrCode:
          null,

        phoneNumber:
          session.phoneNumber ||
          null,

        message:
          "WhatsApp session is starting. Please try again shortly.",
      });
    } catch (error) {
      logger.error(
        {
          error:
            error?.message,
        },
        "QR request failed."
      );

      return res.status(500).json({
        success: false,

        message:
          error?.message ||
          "Unable to generate WhatsApp QR code.",
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| SEND MESSAGE
|--------------------------------------------------------------------------
*/

app.post(
  "/session/:sessionId/send",
  async (req, res) => {
    try {
      const id =
        safeId(
          req.params.sessionId
        );

      const session =
        sessions.get(id);

      if (!session) {
        return res.status(404).json({
          success: false,

          message:
            "WhatsApp session not found.",
        });
      }

      if (
        session.status !==
        "connected"
      ) {
        return res.status(409).json({
          success: false,

          message:
            "WhatsApp is not connected.",

          status:
            session.status,
        });
      }

      const {
        to,
        message,
      } = req.body || {};

      if (
        !to ||
        !message
      ) {
        return res.status(400).json({
          success: false,

          message:
            "Both 'to' and 'message' are required.",
        });
      }

      const phone =
        String(to).replace(
          /\D/g,
          ""
        );

      if (
        phone.length < 7
      ) {
        return res.status(400).json({
          success: false,

          message:
            "Invalid WhatsApp phone number.",
        });
      }

      const result =
        await session.socket.sendMessage(
          `${phone}@s.whatsapp.net`,
          {
            text:
              String(message),
          }
        );

      return res.json({
        success: true,

        messageId:
          result?.key?.id ||
          null,

        to:
          phone,
      });
    } catch (error) {
      logger.error(
        {
          error:
            error?.message,
        },
        "Send failed."
      );

      return res.status(500).json({
        success: false,

        message:
          error?.message ||
          "Unable to send WhatsApp message.",
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| LOGOUT
|--------------------------------------------------------------------------
*/

app.post(
  "/session/:sessionId/logout",
  async (req, res) => {
    const id =
      safeId(
        req.params.sessionId
      );

    const session =
      sessions.get(id);

    if (!session) {
      return res.json({
        success: true,

        sessionId:
          id,

        status:
          "disconnected",
      });
    }

    try {
      await session.socket?.logout();
    } catch (error) {
      logger.warn(
        {
          sessionId: id,
          error:
            error?.message,
        },
        "WhatsApp logout returned an error."
      );
    }

    session.status =
      "disconnected";

    session.qrCode =
      null;

    session.lastError =
      null;

    session.updatedAt =
      new Date().toISOString();

    return res.json({
      success: true,

      sessionId:
        id,

      status:
        "disconnected",
    });
  }
);

/*
|--------------------------------------------------------------------------
| DELETE SESSION
|--------------------------------------------------------------------------
*/

app.delete(
  "/session/:sessionId",
  async (req, res) => {
    const id =
      safeId(
        req.params.sessionId
      );

    const session =
      sessions.get(id);

    try {
      /*
       * Stop socket.
       */
      try {
        session?.socket?.end(
          undefined
        );
      } catch {}

      /*
       * Clear reconnect timer.
       */
      if (
        session?.reconnectTimer
      ) {
        clearTimeout(
          session.reconnectTimer
        );
      }

      /*
       * Remove from memory.
       */
      sessions.delete(id);

      /*
       * Remove authentication.
       */
      const dir =
        getAuthFolder(id);

      if (
        fs.existsSync(dir)
      ) {
        fs.rmSync(
          dir,
          {
            recursive: true,
            force: true,
          }
        );
      }

      return res.json({
        success: true,

        sessionId:
          id,

        status:
          "deleted",
      });
    } catch (error) {
      logger.error(
        {
          sessionId: id,
          error:
            error?.message,
        },
        "Delete session failed."
      );

      return res.status(500).json({
        success: false,

        message:
          error?.message ||
          "Unable to delete session.",
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| START SERVER
|--------------------------------------------------------------------------
*/

const server =
  app.listen(
    PORT,
    HOST,
    () => {
      logger.info(
        {
          host:
            HOST,

          port:
            PORT,

          aiEnabled:
            AI_ENABLED,

          openaiConfigured:
            Boolean(
              OPENAI_API_KEY
            ),

          openaiModel:
            OPENAI_MODEL,

          supabaseConfigured:
            Boolean(
              SUPABASE_URL &&
              SUPABASE_SERVICE_ROLE_KEY
            ),
        },
        "Sodah WhatsApp QR Provider started."
      );
    }
  );

/*
|--------------------------------------------------------------------------
| SERVER ERROR
|--------------------------------------------------------------------------
*/

server.on(
  "error",
  (error) => {
    if (
      error.code ===
      "EADDRINUSE"
    ) {
      logger.error(
        {
          port:
            PORT,
        },
        `Port ${PORT} is already in use.`
      );
    } else {
      logger.error(
        {
          error:
            error?.message,
        },
        "Server error."
      );
    }
  }
);

/*
|--------------------------------------------------------------------------
| GRACEFUL SHUTDOWN
|--------------------------------------------------------------------------
*/

async function shutdown(
  signal
) {
  logger.info(
    {
      signal,
    },
    "Shutting down server."
  );

  for (
    const session of
      sessions.values()
  ) {
    try {
      if (
        session.reconnectTimer
      ) {
        clearTimeout(
          session.reconnectTimer
        );
      }

      session.socket?.end(
        undefined
      );
    } catch {}
  }

  server.close(
    () => {
      process.exit(0);
    }
  );
}

process.on(
  "SIGTERM",
  () => shutdown("SIGTERM")
);

process.on(
  "SIGINT",
  () => shutdown("SIGINT")
);