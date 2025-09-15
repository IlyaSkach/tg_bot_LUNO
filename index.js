require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Telegraf, Markup, session } = require("telegraf");
const Jimp = require("jimp");

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error(
    "Не найден BOT_TOKEN в .env. Создайте файл .env с BOT_TOKEN=..."
  );
  process.exit(1);
}
const MANAGER_CHAT_ID_RAW = process.env.MANAGER_CHAT_ID;
const MANAGER_CHAT_ID =
  MANAGER_CHAT_ID_RAW && !isNaN(Number(MANAGER_CHAT_ID_RAW))
    ? Number(MANAGER_CHAT_ID_RAW)
    : undefined;

// Отдельный получатель алертов о падениях
const ALERT_CHAT_ID_RAW = process.env.ALERT_CHAT_ID;
const ALERT_CHAT_ID =
  ALERT_CHAT_ID_RAW && !isNaN(Number(ALERT_CHAT_ID_RAW))
    ? Number(ALERT_CHAT_ID_RAW)
    : undefined;

const { spawn } = require("child_process");

async function notifyAlert(text) {
  // Отправляем только если указан личный ALERT_CHAT_ID
  if (!ALERT_CHAT_ID || !BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: ALERT_CHAT_ID, text }),
    });
  } catch (_) {}
}

function notifyAlertFast(text) {
  if (!ALERT_CHAT_ID || !BOT_TOKEN) return;
  try {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const payload = JSON.stringify({ chat_id: ALERT_CHAT_ID, text });
    const child = spawn(
      "curl",
      [
        "-sS",
        "-X",
        "POST",
        "-H",
        "Content-Type: application/json",
        "-d",
        payload,
        url,
      ],
      { stdio: "ignore", detached: true }
    );
    child.unref();
  } catch (_) {}
}

const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

// ===== Трекинг лидов (визит, прогресс по шагам, завершение) =====
const LEAD_KEYS_ORDER = [
  "type",
  "recipient",
  "origin",
  "shape",
  "color_group",
  "budget_tier",
];

function getUserDisplay(ctx) {
  const id = ctx.from?.id;
  const name = [ctx.from?.first_name, ctx.from?.last_name]
    .filter(Boolean)
    .join(" ");
  const link = ctx.from?.username
    ? `@${ctx.from.username}`
    : id
    ? `tg://user?id=${id}`
    : "(unknown)";
  return { id, name: name || "", link };
}

function formatAnswers(a) {
  const labels = {
    type: "Тип",
    recipient: "Получатель",
    origin: "Происхождение",
    shape: "Форма",
    color_group: "Цвет",
    budget_tier: "Сегмент",
  };
  const lines = [];
  for (const key of LEAD_KEYS_ORDER) {
    if (a && a[key]) lines.push(`${labels[key]}: ${a[key]}`);
  }
  return lines.join("\n");
}

function buildLeadText(ctx, statusLabel) {
  ensureSession(ctx);
  const { id, name, link } = getUserDisplay(ctx);
  const a = ctx.session.flow?.answers || {};
  const stepIdx = ctx.session.flow?.step ?? 0;
  const total = QUESTIONS.length;
  const currentQ =
    QUESTIONS[stepIdx]?.question || (stepIdx >= total ? "Результат" : "");
  const answersText = formatAnswers(a);
  const stamp = new Date().toLocaleString("ru-RU");
  const stepLine =
    stepIdx < total
      ? `${stepIdx + 1}/${total} — ${currentQ}`
      : `завершил (${total}/${total})`;
  return [
    `Лид: ${link}${name ? ` (${name})` : ""} [id:${id}]`,
    `Статус: ${statusLabel}`,
    `Шаг: ${stepLine}`,
    answersText ? `Ответы:\n${answersText}` : "Ответы: —",
    `Обновлено: ${stamp}`,
  ].join("\n");
}

async function upsertLeadProgress(ctx, statusLabel) {
  if (!MANAGER_CHAT_ID) return; // отправляем только если указан менеджерский чат
  try {
    ensureSession(ctx);
    if (!ctx.session.lead) ctx.session.lead = {};
    const text = buildLeadText(ctx, statusLabel);
    if (ctx.session.lead.message_id) {
      try {
        await ctx.telegram.editMessageText(
          MANAGER_CHAT_ID,
          ctx.session.lead.message_id,
          undefined,
          text,
          { disable_web_page_preview: true }
        );
        return;
      } catch (_) {
        // если нельзя отредактировать (удалено/истекло) — пришлём новое
      }
    }
    const sent = await ctx.telegram.sendMessage(MANAGER_CHAT_ID, text, {
      disable_web_page_preview: true,
    });
    ctx.session.lead.message_id = sent.message_id;
  } catch (_) {}
}

// ===== Автопинг простоя (15 минут по умолчанию) =====
const IDLE_MINUTES = Number(process.env.IDLE_MINUTES || 15);

function ensureLeadRuntime(ctx) {
  ensureSession(ctx);
  if (!ctx.session.lead) ctx.session.lead = {};
  if (!ctx.session.lead.runtime) ctx.session.lead.runtime = {};
  return ctx.session.lead.runtime;
}

async function sendIdlePing(ctx) {
  if (!MANAGER_CHAT_ID) return;
  try {
    const rt = ensureLeadRuntime(ctx);
    if (rt.idlePingSent) return;
    rt.idlePingSent = true;
    const { id, name, link } = getUserDisplay(ctx);
    const stepIdx = ctx.session.flow?.step ?? 0;
    const total = QUESTIONS.length;
    const currentQ =
      QUESTIONS[stepIdx]?.question || (stepIdx >= total ? "Результат" : "");
    const answersText = formatAnswers(ctx.session.flow?.answers || {});
    const text = [
      `Автопинг: пользователь ушёл (нет активности ${IDLE_MINUTES} минут)`,
      `Лид: ${link}${name ? ` (${name})` : ""} [id:${id}]`,
      `Шаг: ${
        stepIdx < total
          ? `${stepIdx + 1}/${total} — ${currentQ}`
          : `завершил (${total}/${total})`
      }`,
      answersText ? `Ответы:\n${answersText}` : "Ответы: —",
    ].join("\n");
    await ctx.telegram.sendMessage(MANAGER_CHAT_ID, text, {
      disable_web_page_preview: true,
    });
  } catch (_) {}
}

function scheduleIdleTimer(ctx) {
  try {
    const rt = ensureLeadRuntime(ctx);
    if (rt.idleTimer) clearTimeout(rt.idleTimer);
    rt.idleTimer = setTimeout(() => {
      sendIdlePing(ctx);
    }, IDLE_MINUTES * 60 * 1000);
  } catch (_) {}
}

function markActivity(ctx) {
  const rt = ensureLeadRuntime(ctx);
  rt.lastActivityAt = Date.now();
  rt.idlePingSent = false; // разрешаем следующий пинг после возвращения
  scheduleIdleTimer(ctx);
}

// ===== Ежедневный дайджест лидов =====
const DIGEST_FILE = path.join(__dirname, "leads-digest.json");

function loadDigest() {
  try {
    if (fs.existsSync(DIGEST_FILE)) {
      const raw = fs.readFileSync(DIGEST_FILE, "utf8");
      return JSON.parse(raw);
    }
  } catch (_) {}
  return { days: {} };
}

function saveDigest(store) {
  try {
    fs.writeFileSync(DIGEST_FILE, JSON.stringify(store, null, 2));
  } catch (_) {}
}

const DIGEST_STORE = loadDigest();

function dateStr(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function ensureDay(day) {
  if (!DIGEST_STORE.days[day]) {
    DIGEST_STORE.days[day] = {
      metrics: {
        visits: 0,
        questionsViewed: 0,
        resultsShown: 0,
        likes: 0,
        dislikes: 0,
      },
      users: {},
    };
  }
  return DIGEST_STORE.days[day];
}

function digestTouchUser(day, ctx) {
  const u = getUserDisplay(ctx);
  const dayObj = ensureDay(day);
  if (!dayObj.users[u.id]) {
    dayObj.users[u.id] = {
      name: u.name,
      username: ctx.from?.username || null,
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
      maxStep: 0,
      finished: false,
      liked: false,
      disliked: false,
    };
  } else {
    dayObj.users[u.id].lastSeenAt = Date.now();
  }
  return dayObj.users[u.id];
}

function digestEvent(ctx, type) {
  const day = dateStr();
  const dayObj = ensureDay(day);
  const du = digestTouchUser(day, ctx);
  switch (type) {
    case "visit":
      dayObj.metrics.visits++;
      break;
    case "question_view":
      dayObj.metrics.questionsViewed++;
      {
        const stepIdx = ctx.session.flow?.step ?? 0;
        const reached = Math.max(1, Math.min(QUESTIONS.length, stepIdx + 1));
        if (reached > du.maxStep) du.maxStep = reached;
      }
      break;
    case "result_shown":
      dayObj.metrics.resultsShown++;
      du.finished = true;
      du.maxStep = Math.max(du.maxStep, QUESTIONS.length);
      break;
    case "like":
      dayObj.metrics.likes++;
      du.liked = true;
      break;
    case "dislike":
      dayObj.metrics.dislikes++;
      du.disliked = true;
      break;
  }
  saveDigest(DIGEST_STORE);
}

function buildDayDigestText(day) {
  const dayObj = DIGEST_STORE.days[day];
  if (!dayObj) return `Дайджест за ${day}: данных нет`;
  const uniqueUsers = Object.keys(dayObj.users).length;
  const m = dayObj.metrics;
  return [
    `Дайджест лидов за ${day}`,
    `Уникальных пользователей: ${uniqueUsers}`,
    `Визитов: ${m.visits}`,
    `Показов вопросов: ${m.questionsViewed}`,
    `Показов результата: ${m.resultsShown}`,
    `Конверсии: нравится — ${m.likes}, не подходит — ${m.dislikes}`,
  ].join("\n");
}

async function sendDayDigest(day) {
  if (!MANAGER_CHAT_ID) return;
  const text = buildDayDigestText(day);
  try {
    await bot.telegram.sendMessage(MANAGER_CHAT_ID, text, {
      disable_web_page_preview: true,
    });
  } catch (_) {}
}

const DIGEST_AT = process.env.DIGEST_AT || "09:00"; // Локальное время
function computeNextDigestTs(now = new Date()) {
  const [hh, mm] = DIGEST_AT.split(":").map((x) => Number(x) || 0);
  const d = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    hh,
    mm,
    0,
    0
  );
  if (d <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function scheduleDailyDigestTimer() {
  let nextTs = computeNextDigestTs();
  const planNext = () => {
    const delay = Math.max(5000, nextTs - Date.now());
    setTimeout(async () => {
      const y = new Date(Date.now() - 24 * 60 * 60 * 1000);
      await sendDayDigest(dateStr(y.getTime()));
      nextTs = computeNextDigestTs();
      planNext();
    }, delay);
  };
  planNext();
}

// Карта для старой структуры каталога (сохраняем как фолбэк)
const SLUGS = {
  type: {
    Кольцо: "ring",
    Серьги: "earrings",
    Колье: "necklace",
  },
  shape: {
    Круг: "round",
    Принцесса: "princess",
    Кушон: "cushion",
  },
  color: {
    Белый: "white",
    Желтый: "yellow",
    Розовый: "pink",
  },
};

// Для красивой фразы результата (падежи и предлоги)
const DISPLAY = {
  recipientPhrase: {
    Себе: "для себя",
    "Для себя": "для себя",
    "В подарок": "в подарок",
  },
  originInstr: {
    Природным: "природным",
    Природный: "природным",
    "Лабораторно-выращенным": "лабораторно-выращенным",
    "Лабораторно-выращенный": "лабораторно-выращенным",
  },
  colorGenitive: {
    Белый: "белого",
    Желтый: "желтого",
    Розовый: "розового",
  },
  colorGroupGenitive: {
    Бесцветный: "бесцветного",
    "Fancy (цветной)": "цветного",
  },
};

// Ценовые сегменты по комбинации происхождение + цветовая группа
const BUDGET_MATRIX = {
  "Лабораторно-выращенный": {
    Бесцветный: ["100001 - 150000", "150001 - 250000", "250001 - 400000"],
    "Fancy (цветной)": [
      "250003 - 350000",
      "350001 - 450000",
      "450001 - 550000",
    ],
  },
  Природный: {
    Бесцветный: ["до 500тр", "500000-1 млн", "выше 1 млн"],
    "Fancy (цветной)": ["до 500тр", "500000-1 млн", "выше 1 млн"],
  },
};

// Вопросы по порядку (новая логика)
const QUESTIONS = [
  {
    key: "type",
    question: "1. Какое украшение вы хотите создать?",
    answers: ["Кольцо", "Колье", "Серьги"],
  },
  {
    key: "recipient",
    question: "2. Для кого будет украшение?",
    answers: ["Для себя", "В подарок"],
  },
  {
    key: "origin",
    question: "3. Какой бриллиант украсит ваше изделие?",
    answers: ["Лабораторно-выращенный", "Природный"],
  },
  {
    key: "shape",
    question: "4. Какая будет форма бриллианта?",
    answers: ["Круг", "Кушон", "Принцесса"],
  },
  {
    key: "color_group",
    question: "5. Бриллиант какого цвета будет на украшении?",
    answers: ["Бесцветный", "Fancy (цветной)"],
  },
  {
    key: "budget_tier",
    question: "6. Ценовой сегмент:",
    answers: [], // наполняется динамически из матрицы
  },
];

function ensureSession(ctx) {
  if (!ctx.session) ctx.session = {};
  if (!ctx.session.flow)
    ctx.session.flow = { step: 0, answers: {}, optionMap: {} };
}

function buildKeyboard(options, key, labels = null, perRow = 3) {
  const rows = [];
  let row = [];
  const texts = labels && labels.length === options.length ? labels : options;
  texts.forEach((text, idx) => {
    row.push(Markup.button.callback(text, `ans:${key}:${idx}`));
    if (row.length === perRow || idx === texts.length - 1) {
      rows.push(row);
      row = [];
    }
  });
  return Markup.inlineKeyboard(rows);
}

async function ensurePlaceholder(step) {
  const dir = path.join(__dirname, "assets", "placeholders");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, `q${step + 1}`);
  const candidates = [".jpg", ".jpeg", ".png"].map((ext) => base + ext);
  for (const file of candidates) {
    if (fs.existsSync(file)) return file;
  }
  const file = base + ".jpg";
  try {
    const width = 1280;
    const height = 720;
    const bg = await new Jimp({ width, height, color: 0xfff4e5ff });
    await new Promise((resolve, reject) => {
      bg.write(file, (err) => (err ? reject(err) : resolve()));
    });
    return file;
  } catch (_) {
    return file;
  }
}

// Найти любую подходящую картинку из каталога для вопроса 7
function findAnyCatalogImage(answers) {
  const typeSlug = SLUGS.type[answers.type];
  const shapeSlug = SLUGS.shape[answers.shape];
  const colorSlug = SLUGS.color[answers.color];

  const base = path.join(__dirname, "assets", "catalog");
  const TYPES = ["ring", "earrings", "necklace"];
  const SHAPES = ["round", "princess", "cushion"];
  const COLORS = ["white", "yellow", "pink"];

  const tryPaths = [];
  if (typeSlug && shapeSlug && colorSlug) {
    tryPaths.push(path.join(base, typeSlug, shapeSlug, colorSlug, "image.jpg"));
    tryPaths.push(path.join(base, typeSlug, shapeSlug, colorSlug));
  }
  for (const t of TYPES) {
    for (const s of SHAPES) {
      for (const c of COLORS) {
        tryPaths.push(path.join(base, t, s, c, "image.jpg"));
        tryPaths.push(path.join(base, t, s, c));
      }
      tryPaths.push(path.join(base, t, s));
    }
    tryPaths.push(path.join(base, t));
  }

  for (const p of tryPaths) {
    if (p.endsWith("image.jpg") && fs.existsSync(p)) return p;
    if (
      !p.endsWith(".jpg") &&
      fs.existsSync(p) &&
      fs.statSync(p).isDirectory()
    ) {
      try {
        const files = fs
          .readdirSync(p)
          .filter((f) => !f.startsWith("."))
          .map((f) => path.join(p, f));
        const preferred = files.find((f) => /image\.(jpg|jpeg|png)$/i.test(f));
        if (preferred && fs.existsSync(preferred)) return preferred;
        const anyImg = files.find((f) => /\.(png|jpe?g)$/i.test(f));
        if (anyImg && fs.existsSync(anyImg)) return anyImg;
      } catch (_) {}
    }
  }
  return null;
}

// Найти несколько картинок (до limit) для 7-го шага
function findCatalogImages(answers, limit = 6) {
  const base = path.join(__dirname, "assets", "catalog");
  const TYPES = ["ring", "earrings", "necklace"];
  const SHAPES = ["round", "princess", "cushion"];
  const COLORS = ["white", "yellow", "pink"];

  const collected = [];

  function pushIfImage(p) {
    if (
      fs.existsSync(p) &&
      fs.statSync(p).isFile() &&
      /\.(png|jpe?g)$/i.test(p)
    ) {
      collected.push(p);
      return true;
    }
    return false;
  }

  function pickFromDir(dir) {
    try {
      const files = fs
        .readdirSync(dir)
        .filter((f) => !f.startsWith("."))
        .map((f) => path.join(dir, f));
      const preferred = files.filter((f) => /image\.(jpg|jpeg|png)$/i.test(f));
      for (const f of preferred) {
        if (pushIfImage(f) && collected.length >= limit) return;
      }
      for (const f of files) {
        if (
          /\.(png|jpe?g)$/i.test(f) &&
          pushIfImage(f) &&
          collected.length >= limit
        )
          return;
      }
    } catch (_) {}
  }

  const typeSlug = SLUGS.type[answers.type];
  const shapeSlug = SLUGS.shape[answers.shape];
  const colorSlug = SLUGS.color[answers.color];

  // 1) Точный каталог
  if (typeSlug && shapeSlug && colorSlug)
    pickFromDir(path.join(base, typeSlug, shapeSlug, colorSlug));
  // 2) Остальные комбинации
  for (const t of TYPES) {
    for (const s of SHAPES) {
      for (const c of COLORS) {
        pickFromDir(path.join(base, t, s, c));
        if (collected.length >= limit) return collected;
      }
      if (collected.length >= limit) return collected;
    }
    if (collected.length >= limit) return collected;
  }
  return collected;
}

// Картинки для вопросов 1..5 из assets/placeholders
function findQuestionImages(step) {
  // step: 0-based, вопросы: 1..7
  const qn = step + 1;
  const dir = path.join(__dirname, "assets", "placeholders");
  const exists = (p) => fs.existsSync(p) && fs.statSync(p).isFile();
  const makeCandidates = (base) =>
    [".jpeg", ".jpg", ".png"].map((e) => base + e);

  // Только для 1..5 включительно
  if (qn < 1 || qn > 5) return [];

  // Остальные: q{n}.jpeg (с фолбэком на jpg/png)
  for (const c of makeCandidates(path.join(dir, `q${qn}`))) {
    if (exists(c)) return [c];
  }
  return [];
}

async function askCurrentQuestion(ctx) {
  ensureSession(ctx);
  const { step } = ctx.session.flow;
  const current = QUESTIONS[step];
  if (!current) return;

  // Динамическая подстановка ответов для ценового сегмента
  let answers = current.answers;
  if (current.key === "budget_tier") {
    const a = ctx.session.flow.answers;
    const origin = a.origin;
    const colorGroup = a.color_group;
    answers =
      (origin &&
        colorGroup &&
        BUDGET_MATRIX[origin] &&
        BUDGET_MATRIX[origin][colorGroup]) ||
      [];
    if (!answers.length) {
      // Если по какой-то причине список пуст — пропустим этот шаг
      ctx.session.flow.step = step + 1;
      await askCurrentQuestion(ctx);
      return;
    }
  }

  // Сохраняем карту вариантов для дешифровки индекса
  ctx.session.flow.optionMap[current.key] = answers;

  // Сегменты бюджета — без картинок, только текст и кнопки
  if (current.key === "budget_tier") {
    const keyboard = buildKeyboard(answers, current.key, null, 1);
    await ctx.reply(current.question, keyboard);
    await upsertLeadProgress(ctx, "Просмотр вопроса");
    // учёт метрик и активности для автопинга
    try {
      digestEvent(ctx, "question_view");
    } catch (_) {}
    try {
      markActivity(ctx);
    } catch (_) {}
    return;
  }

  // Для вопросов 1..5 прикрепляем изображения из placeholders
  const keyboard = buildKeyboard(answers, current.key, null, 1);
  const imgs = findQuestionImages(step);
  if (imgs.length > 1) {
    // Для вопроса 3: не показываем дополнительную строку "Выберите вариант"; кнопки сразу под фото
    const media = imgs.map((p, i) => ({
      type: "photo",
      media: { source: p },
      caption: i === 0 ? current.question : undefined,
    }));
    try {
      await ctx.replyWithMediaGroup(media);
    } catch (_) {
      await ctx.replyWithPhoto(
        { source: imgs[0] },
        { caption: current.question }
      );
    }
    if (current.key !== "origin") {
      await ctx.reply("Выберите вариант:", keyboard);
    } else {
      // Невидимый символ, чтобы прикрепить клавиатуру без лишнего текста
      await ctx.reply("\u2063", keyboard);
    }
    await upsertLeadProgress(ctx, "Просмотр вопроса");
    try {
      digestEvent(ctx, "question_view");
    } catch (_) {}
    try {
      markActivity(ctx);
    } catch (_) {}
    return;
  } else if (imgs.length === 1) {
    await ctx.replyWithPhoto(
      { source: imgs[0] },
      { caption: current.question, ...keyboard }
    );
    await upsertLeadProgress(ctx, "Просмотр вопроса");
    try {
      digestEvent(ctx, "question_view");
    } catch (_) {}
    try {
      markActivity(ctx);
    } catch (_) {}
    return;
  }

  // Если картинок нет — просто текст
  await ctx.reply(current.question, keyboard);
  await upsertLeadProgress(ctx, "Просмотр вопроса");
  try {
    digestEvent(ctx, "question_view");
  } catch (_) {}
  try {
    markActivity(ctx);
  } catch (_) {}
}

function getResultImagePath(answers) {
  // Новая логика: русскоязычные папки с png-файлами
  const baseDir = path.join(__dirname, "assets", "catalog");
  const origin = answers.origin;
  const rootName =
    origin === "Лабораторно-выращенный"
      ? "Лаб"
      : origin === "Природный"
      ? "Природа"
      : null;
  if (rootName) {
    const isColorless = answers.color_group === "Бесцветный";
    const colorPart = isColorless ? "бесцветные" : "цветные";
    const typePlural =
      answers.type === "Кольцо"
        ? "кольца"
        : answers.type === "Колье"
        ? "колье"
        : "серьги";
    const topFolderName = `${rootName} ${colorPart} ${typePlural}`; // пример: "Лаб бесцветные кольца"
    // Структура: /assets/catalog/Лаб/Лаб бесцветные кольца/<сегмент>/<форма>.png
    const topDir = path.join(baseDir, rootName, topFolderName);

    // Сопоставляем выбранный сегмент с названием папки
    const tier = answers.budget_tier || "";
    let budgetMatcher = null;
    if (rootName === "Лаб" && isColorless) {
      if (/100001/.test(tier)) budgetMatcher = /до\s*150/i;
      else if (/150001/.test(tier)) budgetMatcher = /150\s*-\s*250/i;
      else if (/250001/.test(tier)) budgetMatcher = /250\s*-\s*400/i;
    } else if (rootName === "Лаб" && !isColorless) {
      if (/250003/.test(tier)) budgetMatcher = /250\s*-\s*350/i;
      else if (/350001/.test(tier)) budgetMatcher = /350\s*-\s*450/i;
      else if (/450001/.test(tier)) budgetMatcher = /450\s*-\s*550/i;
    } else if (rootName === "Природа") {
      if (/до\s*500/i.test(tier)) budgetMatcher = /до\s*500/i;
      else if (
        /500000\s*-?\s*1\s*млн/i.test(tier) ||
        /500\s*-?\s*1\s*млн/i.test(tier) ||
        /500\s*-?1млн/i.test(tier)
      )
        budgetMatcher = /(500\s*-\s*1\s*млн|500-?\s*1\s*млн|500-?1млн)/i;
      else if (/выше\s*1\s*млн/i.test(tier)) budgetMatcher = /выше\s*1\s*млн/i;
    }

    try {
      if (fs.existsSync(topDir) && fs.statSync(topDir).isDirectory()) {
        const budgetDirs = fs
          .readdirSync(topDir)
          .filter((f) => !f.startsWith("."))
          .map((f) => ({ name: f, path: path.join(topDir, f) }))
          .filter((e) => fs.statSync(e.path).isDirectory());
        let chosenBudgetDir = null;
        if (budgetMatcher)
          chosenBudgetDir = budgetDirs.find((e) => budgetMatcher.test(e.name));
        if (!chosenBudgetDir) chosenBudgetDir = budgetDirs[0];
        if (chosenBudgetDir) {
          const shapeFile =
            answers.shape === "Круг"
              ? "круг.png"
              : answers.shape === "Кушон"
              ? "кушон.png"
              : "принцесса.png";
          const candidate = path.join(chosenBudgetDir.path, shapeFile);
          if (fs.existsSync(candidate) && fs.statSync(candidate).isFile())
            return candidate;
          const any = fs
            .readdirSync(chosenBudgetDir.path)
            .filter((f) => /\.(png|jpe?g)$/i.test(f) && !f.startsWith("."))
            .map((f) => path.join(chosenBudgetDir.path, f))[0];
          if (any) return any;
        }
      }
    } catch (_) {}
  }

  // Фолбэк: старая структура по type/shape/color
  const typeSlug = SLUGS.type[answers.type];
  const shapeSlug = SLUGS.shape[answers.shape];
  const colorSlug =
    SLUGS.color && answers.color ? SLUGS.color[answers.color] : null;
  if (typeSlug && shapeSlug && colorSlug) {
    return path.join(
      __dirname,
      "assets",
      "catalog",
      typeSlug,
      shapeSlug,
      colorSlug,
      "image.jpg"
    );
  }
  return null;
}

function buildResultText(a) {
  const recipientPhrase =
    DISPLAY.recipientPhrase[a.recipient] || a.recipient.toLowerCase();
  const originInstr = DISPLAY.originInstr[a.origin] || a.origin.toLowerCase();
  const colorGroupGen =
    (a.color_group &&
      DISPLAY.colorGroupGenitive &&
      DISPLAY.colorGroupGenitive[a.color_group]) ||
    null;
  let colorPart = "";
  if (a.color_group === "Fancy (цветной)") {
    colorPart = " цвета Fancy";
  } else if (colorGroupGen) {
    colorPart = ` ${colorGroupGen} цвета`;
  }
  return `Ваш выбор — ${a.type.toLowerCase()} ${recipientPhrase} с ${originInstr} бриллиантом огранки ${a.shape.toLowerCase()}${colorPart}👇`;
}

async function showResult(ctx) {
  const a = ctx.session.flow.answers;
  const resultText = buildResultText(a);
  const imgPath = getResultImagePath(a);

  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback("Мне нравится", "like_choice")],
    [Markup.button.callback("Мне не подходит", "dislike_choice")],
    [Markup.button.callback("Рассчитать заново", "restart")],
  ]);

  if (imgPath && fs.existsSync(imgPath)) {
    await ctx.replyWithPhoto(
      { source: imgPath },
      { caption: resultText, ...buttons }
    );
  } else {
    await ctx.reply(
      `${resultText}\n(Изображение не найдено. Поместите файл image.jpg в каталог результата.)`,
      buttons
    );
  }
  await upsertLeadProgress(ctx, "Показан результат");
  try {
    digestEvent(ctx, "result_shown");
  } catch (_) {}
  try {
    markActivity(ctx);
  } catch (_) {}
}

function resetFlow(ctx) {
  if (!ctx.session) ctx.session = {};
  ctx.session.flow = { step: 0, answers: {}, optionMap: {} };
}

async function safeAnswerCb(ctx) {
  try {
    await ctx.answerCbQuery();
  } catch (_) {}
}

const WELCOME_TEXT = [
  "Говорят, украшения — это не про золото, а про историю, которую они рассказывают. Сегодня вы создадите украшение, которое станет вашим личным символом силы и успеха 🍸",
  "Отвечайте смело — ваш выбор превратится в эскиз, который будет создан только для вас 👇",
].join("\n");

bot.start(async (ctx) => {
  ensureSession(ctx);
  const welcomePath = path.join(__dirname, "assets", "welcome.jpg");
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("Создай свое украшение", "start_quiz")],
  ]);
  if (fs.existsSync(welcomePath)) {
    await ctx.replyWithPhoto(
      { source: welcomePath },
      { caption: WELCOME_TEXT, ...keyboard }
    );
  } else {
    await ctx.reply(WELCOME_TEXT, keyboard);
  }
  await upsertLeadProgress(ctx, "Визит");
  try {
    digestEvent(ctx, "visit");
  } catch (_) {}
  try {
    markActivity(ctx);
  } catch (_) {}
});

bot.command("whoami", async (ctx) => {
  const info = `Ваш chat_id: ${ctx.from.id}\nusername: ${
    ctx.from.username ? "@" + ctx.from.username : "(нет)"
  }\nИмя: ${ctx.from.first_name || ""}`;
  await ctx.reply(info);
});

// Тестовая команда, чтобы сымитировать падение и проверить алерты
bot.command("crash", async (ctx) => {
  await ctx.reply("Сейчас сымитируем ошибку и остановим процесс…");
  setTimeout(() => {
    throw new Error("Test crash by /crash");
  }, 100);
});

// Тестовая команда для проверки уведомления о штатной остановке
bot.command("shutdown", async (ctx) => {
  await ctx.reply("Отправляю SIGTERM…");
  setTimeout(() => {
    try {
      process.kill(process.pid, "SIGTERM");
    } catch (_) {}
  }, 200);
});

bot.action("start_quiz", async (ctx) => {
  await safeAnswerCb(ctx);
  resetFlow(ctx);
  await askCurrentQuestion(ctx);
  try {
    markActivity(ctx);
  } catch (_) {}
});

bot.action("restart", async (ctx) => {
  await safeAnswerCb(ctx);
  resetFlow(ctx);
  await askCurrentQuestion(ctx);
  try {
    markActivity(ctx);
  } catch (_) {}
});

bot.action("like_choice", async (ctx) => {
  await safeAnswerCb(ctx);
  ensureSession(ctx);
  const a = ctx.session.flow.answers;
  if (!a || Object.keys(a).length === 0) {
    await ctx.reply("Похоже, вы еще не прошли опрос. Нажмите /start.");
    return;
  }

  const resultText = buildResultText(a);
  const budgetLines = [];
  if (a.budget_tier) budgetLines.push(`Сегмент: ${a.budget_tier}`);
  const priceText = budgetLines.length ? `\n${budgetLines.join("\n")}` : "";
  const userLink = ctx.from.username
    ? `@${ctx.from.username}`
    : `tg://user?id=${ctx.from.id}`;
  const note = `Заявка на эскиз\n${resultText}${priceText}\n\nКлиент: ${userLink}`;

  const targetId = MANAGER_CHAT_ID || ctx.from.id;
  const imgPath = getResultImagePath(a);

  try {
    if (imgPath && fs.existsSync(imgPath)) {
      await ctx.telegram.sendPhoto(
        targetId,
        { source: imgPath },
        { caption: note }
      );
    } else {
      await ctx.telegram.sendMessage(targetId, note);
    }
  } catch (e) {
    await ctx.reply(
      `Не удалось отправить менеджеру. Причина: ${
        e.description || e.message || e
      }`
    );
    // Резерв: отправим текст заявки в этот же чат, чтобы ничего не потерялось
    await ctx.reply(note);
  }

  await ctx.reply(
    "Мы очень рады! Чтобы узнать стоимость выбранного украшения с учетом всех ваших пожеланий и увидеть ещё несколько уникальных вариантов, подобранных специально для вас, напишите в чат менеджеру 💎",
    Markup.inlineKeyboard([
      [Markup.button.url("Написать менеджеру", "https://t.me/lunodiamonds")],
    ])
  );
  await upsertLeadProgress(ctx, "Конверсия: Мне нравится");
  try {
    digestEvent(ctx, "like");
  } catch (_) {}
  try {
    markActivity(ctx);
  } catch (_) {}
});

bot.action("dislike_choice", async (ctx) => {
  await safeAnswerCb(ctx);
  await ctx.reply(
    "К сожалению, мы могли показать лишь несколько возможных вариантов. Давайте соберём подборку под ваши уникальные пожелания и покажем модели, которые мы храним в ателье только для частных клиентов? Наш менеджер отправит вам подборку лично 💎",
    Markup.inlineKeyboard([
      [Markup.button.url("Написать менеджеру", "https://t.me/lunodiamonds")],
    ])
  );
  await upsertLeadProgress(ctx, "Конверсия: Мне не подходит");
  try {
    digestEvent(ctx, "dislike");
  } catch (_) {}
  try {
    markActivity(ctx);
  } catch (_) {}
});

bot.action(/^ans:([a-z_]+):(\d+)$/i, async (ctx) => {
  await safeAnswerCb(ctx);
  ensureSession(ctx);
  const { step, answers, optionMap } = ctx.session.flow;
  const current = QUESTIONS[step];
  if (!current) return;
  const key = ctx.match[1];
  const idx = Number(ctx.match[2]);
  const options = optionMap[key] || [];
  const value = options[idx];
  if (typeof value === "undefined") return;
  answers[key] = value;
  ctx.session.flow.step = step + 1;
  try {
    markActivity(ctx);
  } catch (_) {}
  if (ctx.session.flow.step >= QUESTIONS.length) {
    await showResult(ctx);
  } else {
    await askCurrentQuestion(ctx);
  }
});

bot.command("reset", async (ctx) => {
  resetFlow(ctx);
  await ctx.reply("Начнем заново.");
  await askCurrentQuestion(ctx);
});

bot.launch().then(() => {
  console.log("Бот запущен. Нажмите /start в Telegram.");
  try {
    scheduleDailyDigestTimer();
  } catch (_) {}
});

// Ручная команда для отправки дайджеста: /digest [YYYY-MM-DD]
bot.command("digest", async (ctx) => {
  const parts = (ctx.message?.text || "").trim().split(/\s+/);
  const day = parts[1] || dateStr(Date.now() - 24 * 60 * 60 * 1000);
  await sendDayDigest(day);
});

// Алерты о падениях/остановках на личный ALERT_CHAT_ID
process.on("uncaughtException", (e) => {
  notifyAlert(`❌ uncaughtException: ${e?.stack || e}`);
  setTimeout(() => process.exit(1), 500);
});
process.on("unhandledRejection", (r) => {
  notifyAlert(`⚠️ unhandledRejection: ${r}`);
});

async function handleShutdown(signalLabel) {
  // быстрый не-блокирующий канал + обычный await для надёжности
  notifyAlertFast(`⛔ Бот остановлен (${signalLabel})`);
  try {
    await notifyAlert(`⛔ Бот остановлен (${signalLabel})`);
  } catch (_) {}
  try {
    bot.stop(signalLabel);
  } catch (_) {}
  setTimeout(() => process.exit(0), 1500);
}

["SIGINT", "SIGTERM", "SIGQUIT", "SIGHUP", "SIGUSR1", "SIGUSR2"].forEach(
  (sig) => process.once(sig, () => handleShutdown(sig))
);

process.on("beforeExit", () => {
  notifyAlert("⛔ Бот заканчивает работу (beforeExit)");
});
