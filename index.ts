// Бот поддержки курьеров: курьер пишет боту -> сообщение приходит в группу админов,
// админ отвечает реплаем -> ответ уходит курьеру.
// Переменные окружения: BOT_TOKEN, ADMIN_CHAT_ID (id группы, узнать командой /chatid в группе).

const TOKEN = Bun.env.BOT_TOKEN ?? "";
const ADMIN_CHAT_ID = (Bun.env.ADMIN_CHAT_ID ?? "").trim();
const DOMAIN = Bun.env.RAILWAY_PUBLIC_DOMAIN ?? Bun.env.RENDER_EXTERNAL_HOSTNAME ?? "";
const SECRET = TOKEN.replace(/[^A-Za-z0-9]/g, "").slice(-40) || "no-token";
const API = `https://api.telegram.org/bot${TOKEN}/`;

async function tg(method: string, body: Record<string, unknown>): Promise<any> {
  try {
    const res = await fetch(API + method, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json: any = await res.json();
    if (!json.ok) console.error(`[tg] ${method} failed:`, json.description);
    return json;
  } catch (e) {
    console.error(`[tg] ${method} error:`, e);
    return { ok: false, description: String(e) };
  }
}

function header(from: any): string {
  const name = [from.first_name, from.last_name].filter(Boolean).join(" ") || "Без имени";
  const user = from.username ? ` (@${from.username})` : "";
  return `👤 ${name}${user}\n🆔 #id${from.id}`;
}

const CAPTION_TYPES = ["photo", "video", "document", "audio", "voice", "animation"];

const WELCOME = "Напишите свое ФИО, номер телефона и описание проблемы";

async function handleCourier(msg: any) {
  const chatId = msg.chat.id;
  const from = msg.from;

  if (msg.text && msg.text.startsWith("/start")) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: WELCOME,
      reply_markup: {
        keyboard: [[{ text: "📱 Отправить номер телефона", request_contact: true }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    });
    return;
  }

  if (!ADMIN_CHAT_ID) {
    await tg("sendMessage", { chat_id: chatId, text: "Бот ещё настраивается, напиши чуть позже 🙏" });
    return;
  }

  if (msg.contact) {
    const own = msg.contact.user_id === from.id;
    await tg("sendMessage", {
      chat_id: ADMIN_CHAT_ID,
      text: `📱 Курьер отправил номер${own ? "" : " (чужой контакт!)"}\n${header(from)}\nТелефон: +${String(msg.contact.phone_number).replace(/^\+/, "")}`,
    });
    await tg("sendMessage", {
      chat_id: chatId,
      text: "Спасибо, номер получили ✅ Теперь опиши свою проблему.",
      reply_markup: { remove_keyboard: true },
    });
    return;
  }

  const head = header(from);
  let sent: any;

  if (msg.text) {
    const full = `${head}\n\n${msg.text}`;
    if (full.length <= 4096) {
      sent = await tg("sendMessage", { chat_id: ADMIN_CHAT_ID, text: full });
    } else {
      await tg("sendMessage", { chat_id: ADMIN_CHAT_ID, text: head });
      sent = await tg("sendMessage", { chat_id: ADMIN_CHAT_ID, text: `#id${from.id}\n\n${msg.text}`.slice(0, 4096) });
    }
  } else if (CAPTION_TYPES.some((t) => msg[t])) {
    const caption = `${head}${msg.caption ? "\n\n" + msg.caption : ""}`.slice(0, 1024);
    sent = await tg("copyMessage", {
      chat_id: ADMIN_CHAT_ID,
      from_chat_id: chatId,
      message_id: msg.message_id,
      caption,
    });
  } else {
    // стикеры, кружки, геолокация и т.п. — сначала шапка, потом само сообщение
    await tg("sendMessage", { chat_id: ADMIN_CHAT_ID, text: head });
    sent = await tg("copyMessage", { chat_id: ADMIN_CHAT_ID, from_chat_id: chatId, message_id: msg.message_id });
  }

  if (sent?.ok) {
    await tg("setMessageReaction", {
      chat_id: chatId,
      message_id: msg.message_id,
      reaction: [{ type: "emoji", emoji: "👍" }],
    });
  } else {
    await tg("sendMessage", { chat_id: chatId, text: "Не получилось отправить сообщение, попробуй ещё раз 🙏" });
  }
}

async function handleAdmin(msg: any) {
  const reply = msg.reply_to_message;
  if (!reply) return;
  const src = `${reply.text ?? ""}\n${reply.caption ?? ""}`;
  const m = src.match(/#id(\d+)/);
  if (!m) {
    if (reply.from?.is_bot) {
      await tg("sendMessage", {
        chat_id: msg.chat.id,
        reply_to_message_id: msg.message_id,
        text: "Не понял, кому отвечать. Отвечай реплаем на сообщение, где есть #id курьера.",
      });
    }
    return;
  }
  const userId = Number(m[1]);
  const res = await tg("copyMessage", { chat_id: userId, from_chat_id: msg.chat.id, message_id: msg.message_id });
  if (res.ok) {
    await tg("setMessageReaction", {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      reaction: [{ type: "emoji", emoji: "👌" }],
    });
  } else {
    await tg("sendMessage", {
      chat_id: msg.chat.id,
      reply_to_message_id: msg.message_id,
      text: `❌ Не доставлено курьеру: ${res.description ?? "ошибка"}`,
    });
  }
}

async function handleUpdate(update: any) {
  const msg = update.message;
  if (!msg || !msg.chat) return;

  if (msg.text && /^\/chatid(@\w+)?$/.test(msg.text.trim())) {
    await tg("sendMessage", { chat_id: msg.chat.id, text: `ID этого чата: ${msg.chat.id}` });
    return;
  }

  if (msg.chat.type === "private") {
    await handleCourier(msg);
  } else if (ADMIN_CHAT_ID && String(msg.chat.id) === ADMIN_CHAT_ID) {
    await handleAdmin(msg);
  }
}

if (TOKEN && DOMAIN) {
  const r = await tg("setWebhook", {
    url: `https://${DOMAIN}/tg`,
    secret_token: SECRET,
    allowed_updates: ["message"],
  });
  console.log("setWebhook:", r.ok ? "ok" : r.description);
  await tg("setMyCommands", { commands: [{ command: "start", description: "Написать в поддержку" }] });
} else {
  console.log("BOT_TOKEN или домен не заданы — вебхук не установлен");
}

Bun.serve({
  port: Number(Bun.env.PORT ?? 3000),
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/tg") {
      if (req.headers.get("x-telegram-bot-api-secret-token") !== SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const update = await req.json().catch(() => null);
      if (update) {
        try {
          await handleUpdate(update);
        } catch (e) {
          console.error("handleUpdate error:", e);
        }
      }
      return new Response("ok");
    }
    return new Response(TOKEN ? "courier support bot is running" : "BOT_TOKEN is not set");
  },
});

console.log("server started");
