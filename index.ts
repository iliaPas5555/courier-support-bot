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

const ASK_FIO =
  "✍️ Чтобы написать в поддержку, сначала отправь своё ФИО полностью одним сообщением.\n" +
  "Например: Иванов Иван Иванович";

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
let stateMsgId: number | null = null;
// обращения: c — последнее сообщение курьера, a — последний ответ поддержки, d — закрыто, s — последние сообщения курьера
type Info = { c: number; a: number; d: boolean; s: string[] };
const info = new Map<number, Info>();
let lastRemind = 0;
function getInfo(uid: number): Info {
  let i = info.get(uid);
  if (!i) info.set(uid, (i = { c: 0, a: 0, d: true, s: [] }));
  return i;
}

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
        if (u === "_r") { lastRemind = Number(v) || 0; continue; }
        const t = typeof v === "number" ? v : v.t;
        if (t) {
          userToThread.set(Number(u), t);
          threadToUser.set(t, Number(u));
        }
        if (v?.n) userFio.set(Number(u), v.n);
        if (v && typeof v === "object" && "c" in v) info.set(Number(u), { c: v.c || 0, a: v.a || 0, d: !!v.d, s: v.s || [] });
      }
    }
  }
  console.log(`темы: ${isForum ? "включены" : "выключены"}, загружено курьеров: ${userToThread.size}`);
}

let saving = Promise.resolve();
function saveState() {
  saving = saving.then(async () => {
    const data: Record<string, any> = { _r: lastRemind };
    const ids = new Set<number>([...userToThread.keys(), ...info.keys()]);
    for (const u of ids) {
      const t = userToThread.get(u);
      const i = info.get(u);
      if (!i && !userFio.has(u)) { data[u] = t; continue; }
      data[u] = { t, n: userFio.get(u), ...(i ? { c: i.c, a: i.a, d: i.d, s: i.s } : {}) };
    }
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const caption = "🗂 Служебный файл бота (темы и обращения курьеров). Не удалять и не откреплять.";
    if (stateMsgId) {
      // обновляем тот же закреплённый файл, чтобы не спамить группу
      const ef = new FormData();
      ef.append("chat_id", ADMIN_CHAT_ID);
      ef.append("message_id", String(stateMsgId));
      ef.append("media", JSON.stringify({ type: "document", media: "attach://state", caption }));
      ef.append("state", blob, STATE_FILE);
      const er: any = await fetch(API + "editMessageMedia", { method: "POST", body: ef }).then((x) => x.json()).catch(() => null);
      if (er?.ok || /not modified/i.test(er?.description ?? "")) return;
      console.error("editMessageMedia:", er?.description);
    }
    const form = new FormData();
    form.append("chat_id", ADMIN_CHAT_ID);
    form.append("disable_notification", "true");
    form.append("caption", caption);
    form.append("document", blob, STATE_FILE);
    const r: any = await fetch(API + "sendDocument", { method: "POST", body: form }).then((x) => x.json()).catch(() => null);
    if (!r?.ok) return console.error("не удалось сохранить темы", r?.description);
    await tg("pinChatMessage", { chat_id: ADMIN_CHAT_ID, message_id: r.result.message_id, disable_notification: true });
    if (stateMsgId) await tg("deleteMessage", { chat_id: ADMIN_CHAT_ID, message_id: stateMsgId });
    stateMsgId = r.result.message_id;
  });
  return saving;
}

let saveTimer: any = null;
function saveStateSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveState();
  }, 4000);
}

function noteCourier(uid: number, msg: any) {
  const i = getInfo(uid);
  i.c = Date.now();
  i.d = false;
  const tag = msg.photo ? "[фото] " : msg.document ? "[файл] " : msg.voice ? "[голосовое] " : msg.video ? "[видео] " : "";
  const txt = (tag + (msg.text ?? msg.caption ?? "")).replace(/\s+/g, " ").trim();
  if (txt) {
    i.s.push(txt.slice(0, 200));
    if (i.s.length > 5) i.s.shift();
  }
  saveStateSoon();
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
    const STOP = /^(не|пришл|оплат|деньг|привет|здравств|добр|день|вечер|утр|задан|сгорел|помог|помощ|вопрос|проблем|почему|когда|где|как|что|хочу|нужн|смен|заказ|курьер|алло|ау|ок|да|нет|спасибо|скажите|подскаж)/i;
    const words = all.filter((x) => /^[А-ЯЁа-яё-]{2,}$/.test(x));
    if (all.length >= 2 && all.length <= 4 && words.length === all.length && !words.some((w) => STOP.test(w)))
      return words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(" ");
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
        `🆕 Курьер написал в поддержку\n${userFio.has(from.id) ? `📋 ФИО: ${userFio.get(from.id)}\n` : ""}${header(from)}\n\n` +
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
    if (!userFio.has(from.id)) await tg("sendMessage", { chat_id: chatId, text: ASK_FIO });
    return;
  }

  if (!ADMIN_CHAT_ID) {
    await tg("sendMessage", { chat_id: chatId, text: "Бот ещё настраивается, напиши чуть позже 🙏" });
    return;
  }

  if (msg.contact && !userFio.has(from.id)) {
    await tg("sendMessage", { chat_id: chatId, text: ASK_FIO });
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

  // без ФИО в поддержку не пускаем
  if (!userFio.has(from.id)) {
    const fio = extractFio(msg.text ?? msg.caption ?? "", true);
    if (!fio) {
      await tg("sendMessage", { chat_id: chatId, text: ASK_FIO });
      return;
    }
    if (userToThread.has(from.id)) await setFio(from.id, fio); // старая тема — переименуем
    else userFio.set(from.id, fio); // новая тема сразу создастся с ФИО
    const name = fio.split(" ")[1] || fio;
    const src = (msg.text ?? msg.caption ?? "").toLowerCase();
    const rest = fio.toLowerCase().split(" ").reduce((a, w) => a.replace(w, ""), src).replace(/[^а-яёa-z0-9]/gi, "");
    const onlyFio = !msg.photo && !msg.document && !msg.video && !msg.voice && rest.length < 4;
    await tg("sendMessage", {
      chat_id: chatId,
      text: onlyFio
        ? `Спасибо, ${name}! ✅ Теперь опиши свою проблему — можно прикрепить скриншот или фото.`
        : `Спасибо, ${name}! ✅ Сообщение передали в поддержку.`,
      reply_markup: { remove_keyboard: true },
    });
    if (onlyFio && !userToThread.has(from.id) && isForum) {
      await getThread(from); // создаём тему сразу, само ФИО не пересылаем
      return;
    }
    if (onlyFio) return;
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
    noteCourier(from.id, msg);
    await tg("setMessageReaction", {
      chat_id: chatId,
      message_id: msg.message_id,
      reaction: [{ type: "emoji", emoji: "👍" }],
    });
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
    const inf = getInfo(userId);
    inf.a = Date.now();
    saveStateSoon();
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
    if (/^(\/done(@\w+)?|решено|закрыто|✅)$/i.test(text.trim())) {
      const inf = getInfo(userId);
      inf.d = true;
      inf.s = [];
      saveStateSoon();
      await tg("sendMessage", { chat_id: msg.chat.id, message_thread_id: tid, text: "✅ Обращение закрыто — убрал из напоминаний. Если курьер напишет снова, оно откроется само." });
      return;
    }
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

// ---------- напоминания о нерешённых обращениях ----------
const REMIND_EVERY = 3 * 60 * 60 * 1000;
const REMIND_KEY = (Bun.env.REMIND_KEY ?? "").trim();
const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function category(t: string): string {
  const s = t.toLowerCase();
  if (/оплат|деньг|не приш|выплат|перевод|зарплат|сумм|недоплат|реестр/.test(s)) return "💸 Оплата";
  if (/сгор|задани|отклик|принять|приня/.test(s)) return "📋 Задание";
  if (/кабинет|\bлк\b|вход|парол|код|приложени|войти|аккаунт|самозанят|инн/.test(s)) return "🔐 Личный кабинет";
  if (/штраф|удерж/.test(s)) return "⚠️ Штраф";
  if (/смен|график|выход|вахт|заказ|доставк/.test(s)) return "🗓 Работа/смены";
  return "💬 Вопрос";
}

function ago(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} ч ${m % 60} мин`;
  return `${Math.floor(h / 24)} дн`;
}

function topicLink(uid: number): string | null {
  const tid = userToThread.get(uid);
  if (!tid || !ADMIN_CHAT_ID.startsWith("-100")) return null;
  return `https://t.me/c/${ADMIN_CHAT_ID.slice(4)}/${tid}`;
}

function describe(uid: number, i: Info, n: number, now: number, waiting: boolean): string {
  const name = esc(userFio.get(uid) ?? `ID ${uid}`);
  const all = i.s.join(" · ");
  const short = all.length > 160 ? all.slice(0, 157) + "…" : all;
  const link = topicLink(uid);
  const head = link ? `<a href="${link}">${name}</a>` : name;
  const when = waiting ? `ждёт ответа ${ago(now - i.c)}` : `ответили ${ago(now - i.a)} назад, не закрыто`;
  return `${n}. <b>${head}</b> — ${when}\n   ${category(all)}${short ? `: «${esc(short)}»` : ""}`;
}

async function sendReminder(force = false, threadId?: number): Promise<boolean> {
  if (!ADMIN_CHAT_ID) return false;
  const now = Date.now();
  const waiting: [number, Info][] = [];
  const open: [number, Info][] = [];
  for (const [uid, i] of info) {
    if (i.d || !i.c) continue;
    (i.c > i.a ? waiting : open).push([uid, i]);
  }
  const extra = threadId ? { message_thread_id: threadId } : {};
  if (!waiting.length && !open.length) {
    if (force) await tg("sendMessage", { chat_id: ADMIN_CHAT_ID, ...extra, text: "✅ Нерешённых обращений нет." });
    return false;
  }
  waiting.sort((a, b) => a[1].c - b[1].c);
  open.sort((a, b) => a[1].a - b[1].a);
  const parts: string[] = [`⏰ <b>Нерешённые обращения: ${waiting.length + open.length}</b>`];
  if (waiting.length) {
    parts.push(`\n🔴 <b>Ждут ответа (${waiting.length}):</b>`);
    waiting.forEach(([u, i], k) => parts.push(describe(u, i, k + 1, now, true)));
  }
  if (open.length) {
    parts.push(`\n🟡 <b>Ответили, но не закрыто (${open.length}):</b>`);
    open.forEach(([u, i], k) => parts.push(describe(u, i, k + 1, now, false)));
  }
  parts.push(`\nЧтобы закрыть обращение, напиши в теме курьера «решено» или /done. Список в любой момент — /tasks.`);
  // режем на сообщения до 4000 символов
  let buf = "";
  const chunks: string[] = [];
  for (const p of parts) {
    if ((buf + "\n" + p).length > 3900) { chunks.push(buf); buf = ""; }
    buf = buf ? buf + "\n" + p : p;
  }
  if (buf) chunks.push(buf);
  for (const c of chunks) await tg("sendMessage", { chat_id: ADMIN_CHAT_ID, ...extra, text: c, parse_mode: "HTML", disable_web_page_preview: true });
  return true;
}

let reminding = false;
async function maybeRemind(): Promise<string> {
  if (reminding) return "busy";
  const now = Date.now();
  if (now - lastRemind < REMIND_EVERY - 15 * 60 * 1000) return "too early";
  reminding = true;
  try {
    lastRemind = now;
    const sentAny = await sendReminder(false);
    saveStateSoon();
    return sentAny ? "sent" : "nothing to remind";
  } finally {
    reminding = false;
  }
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
    if (msg.text && /^\/tasks(@\w+)?$/.test(msg.text.trim())) {
      await sendReminder(true, msg.message_thread_id);
      return;
    }
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
  await tg("setMyCommands", {
    scope: { type: "all_group_chats" },
    commands: [
      { command: "tasks", description: "Нерешённые обращения" },
      { command: "done", description: "Закрыть обращение (в теме курьера)" },
    ],
  });
  await loadState();
} else {
  console.log("BOT_TOKEN или домен не заданы — вебхук не установлен");
}

Bun.serve({
  port: Number(Bun.env.PORT ?? 3000),
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/remind") {
      // ключ не обязателен: чаще чем раз в ~3 часа напоминание всё равно не уйдёт
      if (REMIND_KEY && url.searchParams.get("key") !== REMIND_KEY) return new Response("forbidden", { status: 403 });
      return new Response(await maybeRemind());
    }
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

// пока сервер не спит — проверяем сами; внешний пинг раз в 3 часа будит его на Render
setInterval(() => {
  maybeRemind().catch((e) => console.error("remind error:", e));
}, 10 * 60 * 1000);

console.log("server started");
