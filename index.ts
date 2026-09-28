// Бот поддержки курьеров.
// Курьер пишет боту -> в группе админов для него создаётся ОТДЕЛЬНАЯ ТЕМА (личный чат),
// туда падает вся его переписка. Админ пишет в эту тему -> сообщение уходит курьеру.
// Сообщения в теме, начинающиеся с "!", — внутренние заметки, курьеру не отправляются.
// Если в группе не включены темы — работает по-старому (реплай на сообщение с #id).
// Переменные окружения: BOT_TOKEN, ADMIN_CHAT_ID (id группы, узнать командой /chatid в группе).

const TOKEN = Bun.env.BOT_TOKEN ?? "";
let ADMIN_CHAT_ID = (Bun.env.ADMIN_CHAT_ID ?? "").trim();
const DOMAIN = Bun.env.RAILWAY_PUBLIC_DOMAIN ?? Bun.env.RENDER_EXTERNAL_HOSTNAME ?? "";
const SECRET = TOKEN.replace(/[^A-Za-z0-9]/g, "").slice(-40) || "no-token";
const API = `https://api.telegram.org/bot${TOKEN}/`;
const STATE_FILE = "topics.json";

async function tg(method: string, body: Record<string, unknown>): Promise<any> {
  try {
    const res = await fetch(API + method, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const json: any = await res.json();
    if (!json.ok) {
      console.error(`[tg] ${method} failed:`, json.description);
      const mig = json.parameters?.migrate_to_chat_id;
      if (mig && String(body.chat_id) === ADMIN_CHAT_ID) {
        console.log("группа стала супергруппой, новый id:", mig);
        ADMIN_CHAT_ID = String(mig);
      }
    }
    return json;
  } catch (e) {
    console.error(`[tg] ${method} error:`, e);
    return { ok: false, description: String(e) };
  }
}

function fullName(from: any): string {
  return [from.first_name, from.last_name].filter(Boolean).join(" ") || "Без имени";
}

function header(from: any): string {
  const user = from.username ? ` (@${from.username})` : "";
  return `👤 ${fullName(from)}${user}\n🆔 #id${from.id}`;
}

const CAPTION_TYPES = ["photo", "video", "document", "audio", "voice", "animation"];

const WELCOME =
  "Привет! Это поддержка курьеров 👋\n\n" +
  "Напиши сюда свою проблему: ФИО, номер телефона и что случилось " +
  "(не пришла оплата, сгорело задание, проблема с личным кабинетом и т.д.). " +
  "Можно прикрепить скриншот или фото.\n\n" +
  "Ответ придёт сюда же, в этот чат.";

const OFF_HOURS_TEXT =
  "🌙 Поддержка работает с 9:00 до 22:00 по МСК.\n" +
  "Твоё сообщение мы получили и ответим утром.";
const offHoursNotified = new Map<number, number>();

function isOffHours(): boolean {
  const mskHour = (new Date().getUTCHours() + 3) % 24; // МСК = UTC+3
  return mskHour >= 22 || mskHour < 9;
}

// ---------- темы: courier id <-> id темы ----------
let isForum = false;
const userToThread = new Map<number, number>();
const threadToUser = new Map<number, number>();
const userFio = new Map<number, string>(); // ФИО курьера (из его сообщений)
const askedFio = new Set<number>();
let stateMsgId: number | null = null;

async function loadState() {
  if (!ADMIN_CHAT_ID) return;
  const chat = await tg("getChat", { chat_id: ADMIN_CHAT_ID });
  isForum = !!chat.result?.is_forum;
  const pinned = chat.result?.pinned_message;
  if (pinned?.document?.file_name === STATE_FILE) {
    stateMsgId = pinned.message_id;
    const f = await tg("getFile", { file_id: pinned.document.file_id });
    if (f.ok) {
      const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${f.result.file_path}`);
      const data: Record<string, any> = await res.json().catch(() => ({}));
      for (const [u, v] of Object.entries(data)) {
        const t = typeof v === "number" ? v : v.t;
        userToThread.set(Number(u), t);
        threadToUser.set(t, Number(u));
        if (v?.n) userFio.set(Number(u), v.n);
      }
    }
  }
  console.log(`темы: ${isForum ? "включены" : "выключены"}, загружено курьеров: ${userToThread.size}`);
}

let saving = Promise.resolve();
function saveState() {
  saving = saving.then(async () => {
    const data: Record<string, any> = {};
    for (const [u, t] of userToThread) data[u] = userFio.has(u) ? { t, n: userFio.get(u) } : t;
    const form = new FormData();
    form.append("chat_id", ADMIN_CHAT_ID);
    form.append("disable_notification", "true");
    form.append("caption", "🗂 Служебный файл бота (список тем курьеров). Не удалять и не откреплять.");
    form.append("document", new Blob([JSON.stringify(data)], { type: "application/json" }), STATE_FILE);
    const r: any = await fetch(API + "sendDocument", { method: "POST", body: form }).then((x) => x.json()).catch(() => null);
    if (!r?.ok) return console.error("не удалось сохранить темы", r?.description);
    await tg("pinChatMessage", { chat_id: ADMIN_CHAT_ID, message_id: r.result.message_id, disable_notification: true });
    if (stateMsgId) await tg("deleteMessage", { chat_id: ADMIN_CHAT_ID, message_id: stateMsgId });
    stateMsgId = r.result.message_id;
  });
  return saving;
}

function topicName(from: any): string {
  return `${userFio.get(from.id) ?? fullName(from)} · ${from.id}`.slice(0, 128);
}

// ищем ФИО в тексте: «Иванов Иван Иванович», «ФИО: Иванов Иван» и т.п.
const W = "[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?";
function extractFio(text: string, lenient = false): string | null {
  if (!text) return null;
  const t = text.replace(/ё/g, "ё").replace(/\s+/g, " ").trim();
  // Фамилия Имя Отчество (отчество на -вич/-вна/-ична/-оглы/-кызы) — в любом месте
  let m = t.match(new RegExp(`(${W}) (${W}) (${W}(?:вич|вна|ична|инична|оглы|кызы))(?![а-яё])`));
  if (m) return `${m[1]} ${m[2]} ${m[3]}`;
  // «ФИО: Иванов Иван ...»
  m = t.match(new RegExp(`ФИО\\s*[:\\-–]?\\s*(${W}(?: ${W}){1,2})`, "i"));
  if (m) return m[1];
  // начало сообщения: два-три слова с заглавной
  m = t.match(new RegExp(`^(${W}(?: ${W}){1,2})(?=$|[\\s,.;:!?\\d])`));
  if (m && (lenient || m[1].split(" ").length >= 2)) return m[1];
  if (lenient) {
    const all = t.split(/[\s,.]+/).filter(Boolean);
    const words = all.filter((x) => /^[А-ЯЁа-яё-]{2,}$/.test(x));
    if (all.length <= 3 && words.length >= 2 && words.length === all.length) return words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(" ");
  }
  return null;
}

async function setFio(userId: number, fio: string) {
  if (userFio.get(userId) === fio) return;
  userFio.set(userId, fio);
  const tid = userToThread.get(userId);
  if (tid) {
    await tg("editForumTopic", { chat_id: ADMIN_CHAT_ID, message_thread_id: tid, name: `${fio} · ${userId}`.slice(0, 128) });
    await tg("sendMessage", { chat_id: ADMIN_CHAT_ID, message_thread_id: tid, text: `✏️ Тема переименована: ${fio}` });
  }
  await saveState();
}

const creating = new Map<number, Promise<number | null>>();
async function getThread(from: any, forceNew = false): Promise<number | null> {
  if (!forceNew && userToThread.has(from.id)) return userToThread.get(from.id)!;
  if (creating.has(from.id)) return creating.get(from.id)!;
  const p = (async () => {
    const name = topicName(from);
    const r = await tg("createForumTopic", { chat_id: ADMIN_CHAT_ID, name });
    if (!r.ok) return null;
    const tid = r.result.message_thread_id;
    const old = userToThread.get(from.id);
    if (old) threadToUser.delete(old);
    userToThread.set(from.id, tid);
    threadToUser.set(tid, from.id);
    await tg("sendMessage", {
      chat_id: ADMIN_CHAT_ID,
      message_thread_id: tid,
      text:
        `🆕 Курьер написал в поддержку\n${header(from)}\n\n` +
        `Всё, что вы напишете в этой теме, уйдёт курьеру.\n` +
        `Начните сообщение с «!», чтобы оставить заметку только для своих.`,
    });
    await saveState();
    return tid;
  })();
  creating.set(from.id, p);
  try {
    return await p;
  } finally {
    creating.delete(from.id);
  }
}

// отправка в группу: в тему курьера (если темы включены) или по-старому
async function toAdmin(from: any, send: (extra: Record<string, unknown>, withHeader: boolean) => Promise<any>) {
  if (isForum) {
    let tid = await getThread(from);
    if (tid) {
      let r = await send({ message_thread_id: tid }, false);
      if (!r.ok && /thread|topic/i.test(r.description ?? "")) {
        tid = await getThread(from, true); // тему удалили — создаём заново
        if (tid) r = await send({ message_thread_id: tid }, false);
      }
      return r;
    }
  }
  return send({}, true);
}

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
    const phone = `+${String(msg.contact.phone_number).replace(/^\+/, "")}`;
    await toAdmin(from, (extra, withHeader) =>
      tg("sendMessage", {
        chat_id: ADMIN_CHAT_ID,
        ...extra,
        text: `📱 Курьер отправил номер${own ? "" : " (чужой контакт!)"}: ${phone}${withHeader ? "\n" + header(from) : ""}`,
      }),
    );
    await tg("sendMessage", {
      chat_id: chatId,
      text: "Спасибо, номер получили ✅ Теперь опиши свою проблему.",
      reply_markup: { remove_keyboard: true },
    });
    return;
  }

  // если ФИО есть уже в первом сообщении — сразу называем тему по нему
  if (isForum && !userFio.has(from.id) && !userToThread.has(from.id)) {
    const fio = extractFio(msg.text ?? msg.caption ?? "");
    if (fio) userFio.set(from.id, fio);
  }

  const sent = await toAdmin(from, async (extra, withHeader) => {
    const head = withHeader ? header(from) : "";
    if (msg.text) {
      const text = withHeader ? `${head}\n\n${msg.text}` : msg.text;
      return tg("sendMessage", { chat_id: ADMIN_CHAT_ID, ...extra, text: text.slice(0, 4096) });
    }
    if (CAPTION_TYPES.some((t) => msg[t])) {
      const caption = withHeader ? `${head}${msg.caption ? "\n\n" + msg.caption : ""}` : msg.caption ?? "";
      return tg("copyMessage", {
        chat_id: ADMIN_CHAT_ID,
        ...extra,
        from_chat_id: chatId,
        message_id: msg.message_id,
        caption: caption.slice(0, 1024),
      });
    }
    if (withHeader) await tg("sendMessage", { chat_id: ADMIN_CHAT_ID, text: head });
    return tg("copyMessage", { chat_id: ADMIN_CHAT_ID, ...extra, from_chat_id: chatId, message_id: msg.message_id });
  });

  if (sent?.ok) {
    await tg("setMessageReaction", {
      chat_id: chatId,
      message_id: msg.message_id,
      reaction: [{ type: "emoji", emoji: "👍" }],
    });
    if (isForum && !userFio.has(from.id)) {
      const fio = extractFio(msg.text ?? msg.caption ?? "", askedFio.has(from.id));
      if (fio) {
        askedFio.delete(from.id);
        await setFio(from.id, fio);
      } else if (!askedFio.has(from.id)) {
        askedFio.add(from.id);
        await tg("sendMessage", {
          chat_id: chatId,
          text: "Напиши, пожалуйста, своё ФИО полностью одним сообщением (например: Иванов Иван Иванович) 🙏",
        });
      }
    }
    if (isOffHours()) {
      const last = offHoursNotified.get(from.id) ?? 0;
      if (Date.now() - last > 3 * 60 * 60 * 1000) {
        offHoursNotified.set(from.id, Date.now());
        await tg("sendMessage", { chat_id: chatId, text: OFF_HOURS_TEXT });
      }
    }
  } else {
    await tg("sendMessage", { chat_id: chatId, text: "Не получилось отправить сообщение, попробуй ещё раз 🙏" });
  }
}

async function deliver(msg: any, userId: number) {
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
      ...(msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {}),
      reply_to_message_id: msg.message_id,
      text: `❌ Не доставлено курьеру: ${res.description ?? "ошибка"}`,
    });
  }
}

async function handleAdmin(msg: any) {
  if (msg.from?.is_bot) return;
  if (msg.forum_topic_created || msg.forum_topic_edited || msg.forum_topic_closed || msg.forum_topic_reopened) return;
  if (msg.pinned_message || msg.new_chat_members || msg.left_chat_member) return;

  // сообщение внутри темы курьера
  if (msg.is_topic_message && msg.message_thread_id) {
    const tid = msg.message_thread_id;
    let userId = threadToUser.get(tid);
    if (!userId) {
      const topicName = msg.reply_to_message?.forum_topic_created?.name ?? "";
      const m = topicName.match(/·\s*(\d+)\s*$/);
      if (m) {
        userId = Number(m[1]);
        threadToUser.set(tid, userId);
        userToThread.set(userId, tid);
      }
    }
    if (!userId) return; // обычная тема, не курьерская
    const text = msg.text ?? msg.caption ?? "";
    const fioCmd = text.match(/^\/fio(?:@\w+)?\s+(.+)$/i);
    if (fioCmd) {
      await setFio(userId, fioCmd[1].trim().replace(/\s+/g, " "));
      return;
    }
    if (text.startsWith("!") || text.startsWith("/")) return; // заметка для своих / команда
    await deliver(msg, userId);
    return;
  }

  // старый режим: реплай на сообщение с #id
  const reply = msg.reply_to_message;
  if (!reply) return;
  const src = `${reply.text ?? ""}\n${reply.caption ?? ""}`;
  const m = src.match(/#id(\d+)/);
  if (!m) {
    if (reply.from?.is_bot && !reply.document) {
      await tg("sendMessage", {
        chat_id: msg.chat.id,
        reply_to_message_id: msg.message_id,
        text: "Не понял, кому отвечать. Отвечай реплаем на сообщение, где есть #id курьера.",
      });
    }
    return;
  }
  await deliver(msg, Number(m[1]));
}

async function handleUpdate(update: any) {
  const msg = update.message;
  if (!msg || !msg.chat) return;

  if (msg.text && /^\/chatid(@\w+)?$/.test(msg.text.trim())) {
    await tg("sendMessage", {
      chat_id: msg.chat.id,
      ...(msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {}),
      text: `ID этого чата: ${msg.chat.id}`,
    });
    return;
  }

  if (msg.chat.type === "private") {
    await handleCourier(msg);
  } else if (ADMIN_CHAT_ID && String(msg.chat.id) === ADMIN_CHAT_ID) {
    if (msg.forum_topic_created === undefined && !isForum && msg.is_topic_message) isForum = true;
    if (msg.text && /^\/refresh(@\w+)?$/.test(msg.text.trim())) {
      await loadState();
      await tg("sendMessage", {
        chat_id: msg.chat.id,
        ...(msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {}),
        text: `Темы: ${isForum ? "включены ✅" : "выключены ❌"}. Курьеров с темами: ${userToThread.size}`,
      });
      return;
    }
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
  await loadState();
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
