const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs").promises;
const path = require("path");
const xlsx = require("xlsx");
const dotenv = require("dotenv");

// Создаем Express приложение
const app = express();
app.use(express.json());

// Загрузка переменных окружения
dotenv.config();

const { TELEGRAM_BOT_TOKEN, ADMIN_ID, VERCEL_APP_URL } = process.env;
const adminIds = ADMIN_ID.split(",").map((id) => parseInt(id.trim()));
const webhookUrl = `${VERCEL_APP_URL}/api/webhook`;

// Инициализация бота в режиме webhook (без polling)
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

// Временные пути для хранения данных (в Vercel это будет работать только в рамках запроса)
const outputDir = "/tmp/output";
const logDir = "/tmp/logs";
const logFilePath = path.join(logDir, "wb_parser.log");

// Создаем временные директории при необходимости
async function ensureDirsExist() {
  for (const dir of [outputDir, logDir]) {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      console.error(`Failed to create directory ${dir}: ${error.message}`);
    }
  }
}

// Services
class LogService {
  constructor() {
    this.logMessages = {};
  }

  async log(message, level = "info") {
    const timestamp = new Date().toISOString();
    const logEntry = `${timestamp} - ${level.toUpperCase()} - ${message}\n`;
    try {
      await fs.appendFile(logFilePath, logEntry, "utf-8");
    } catch (error) {
      console.error(`Failed to write to log file: ${error.message}`);
    }
    console.log(logEntry.trim());
  }

  async updateLogMessage(userId, logMessage) {
    await this.log(logMessage);
    if (!this.logMessages[userId]) {
      const message = await bot.sendMessage(
        userId,
        `📄 *Логи парсинга:*\n${logMessage}`,
        { parse_mode: "Markdown" }
      );
      this.logMessages[userId] = {
        messageId: message.message_id,
        text: [logMessage],
      };
    } else {
      const currentLogs = this.logMessages[userId].text;
      currentLogs.push(logMessage);
      const newText = `📄 *Логи парсинга:*\n${currentLogs.join("\n")}`;
      try {
        await bot.editMessageText(newText, {
          chat_id: userId,
          message_id: this.logMessages[userId].messageId,
          parse_mode: "Markdown",
        });
        this.logMessages[userId].text = currentLogs;
      } catch (error) {
        await this.log(
          `Failed to update log for user ${userId}: ${error.message}`,
          "error"
        );
      }
    }
  }

  async clearLogMessages(userId) {
    if (this.logMessages[userId]) delete this.logMessages[userId];
  }
}

class FileService {
  constructor(bot, logService) {
    this.bot = bot;
    this.logService = logService;
    this.DELETE_FILE_TIMEOUT = 15000; // 15 seconds
  }

  async saveToExcel(data, filename) {
    if (!data.length) {
      await this.logService.log("No data to save to Excel", "warning");
      return null;
    }
    const worksheet = xlsx.utils.json_to_sheet(data);
    const workbook = xlsx.utils.book_new();

    // Устанавливаем ширину столбцов
    worksheet["!cols"] = [
      { wch: 50 }, // Название
      { wch: 30 }, // Количество товара
      { wch: 30 }, // Частота товара
    ];

    xlsx.utils.book_append_sheet(workbook, worksheet, "data");
    const filePath = path.join(outputDir, `${filename}.xlsx`);

    // Ensure directory exists before writing
    await ensureDirsExist();

    await fs.writeFile(
      filePath,
      xlsx.write(workbook, { type: "buffer", bookType: "xlsx" })
    );
    await this.logService.log(`Saved Excel to ${filePath}`);
    return filePath;
  }

  async sendExcelToUser(filePath, filename, userId) {
    try {
      // Проверяем доступ к файлу
      await fs.access(filePath);

      const today = new Date().toLocaleDateString("ru-RU");
      const caption = `📊 *Анализ категории Wildberries* (${today})`;

      await this.bot.sendDocument(userId, filePath, {
        caption,
        parse_mode: "Markdown",
      });

      await this.logService.log(
        `Excel report sent to user ${userId}: ${filePath}`
      );

      // Установка таймера на удаление файла через 15 секунд
      setTimeout(async () => {
        try {
          await fs.unlink(filePath);
          await this.logService.log(`Temporary file deleted: ${filePath}`);
        } catch (error) {
          await this.logService.log(
            `Error deleting temporary file ${filePath}: ${error.message}`,
            "error"
          );
        }
      }, this.DELETE_FILE_TIMEOUT);
    } catch (error) {
      await this.bot.sendMessage(
        userId,
        `❌ Ошибка при отправке файла: ${error.message}`,
        { parse_mode: "Markdown" }
      );
      await this.logService.log(
        `Failed to send Excel to user ${userId}: ${error.message}`,
        "error"
      );
    }
  }
}

class EvirmaClient {
  constructor(fileService) {
    this.fileService = fileService;
    this.headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    this.TIMEOUT = 30000; // 30 секунд
  }

  async queryEvirmaApi(keywords) {
    const payload = { keywords, an: false };
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.TIMEOUT);

      const response = await axios.post(
        "https://evirma.ru/api/v1/keyword/list",
        payload,
        {
          headers: this.headers,
          signal: controller.signal,
          timeout: this.TIMEOUT,
        }
      );

      clearTimeout(timeoutId);

      const filteredData = {
        data: {
          keywords: Object.fromEntries(
            Object.entries(response.data.data?.keywords || {}).filter(
              ([, data]) => data.cluster !== null
            )
          ),
        },
      };
      return Object.keys(filteredData.data.keywords).length
        ? filteredData
        : null;
    } catch (error) {
      if (error.name === "AbortError" || error.code === "ECONNABORTED") {
        const errorMessage =
          "Ошибка сервера Evirma: превышено время ожидания (30 секунд)";
        await logService.log(errorMessage, "error");
        throw new Error(errorMessage);
      }

      await logService.log(error, "error");

      await logService.log(
        `Ошибка при запросе к Evirma API: ${error.message}`,
        "error"
      );
      throw new Error(`Ошибка при запросе к Evirma API: ${error.message}`);
    }
  }

  async parseEvirmaResponse(evirmaData) {
    const parsedData = [];
    if (!evirmaData?.data?.keywords) return parsedData;
    for (const [keyword, keywordData] of Object.entries(
      evirmaData.data.keywords
    )) {
      parsedData.push({
        Название: keyword,
        "Количество товара": keywordData.cluster?.product_count || 0,
        "Частота товара": keywordData.cluster?.freq_syn?.monthly || 0,
      });
    }
    return parsedData;
  }
}

class WildberriesParser {
  constructor(fileService, evirmaClient, logService) {
    this.fileService = fileService;
    this.evirmaClient = evirmaClient;
    this.logService = logService;
    this.catalogData = null;
    this.results = [];
    this.headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    this.MAX_PAGES = 10;
    this.isCancelled = false;
  }

  cancelParsing() {
    this.isCancelled = true;
  }

  resetParsing() {
    this.isCancelled = false;
    this.results = [];
  }

  async fetchWbCatalog() {
    try {
      const response = await axios.get(
        "https://static-basket-01.wbbasket.ru/vol0/data/main-menu-ru-ru-v3.json",
        { headers: this.headers }
      );

      return response.data;
    } catch (error) {
      await this.logService.log(
        `Error fetching WB catalog: ${error.message}`,
        "error"
      );
      throw error;
    }
  }

  async extractCategoryData(catalog) {
    const categories = [];

    const processNode = (node) => {
      if (Array.isArray(node)) {
        // Если node это массив, обрабатываем каждый элемент
        node.forEach((item) => processNode(item));
        return;
      }

      if (node && typeof node === "object") {
        // Проверяем наличие необходимых полей
        if ("name" in node && "url" in node) {
          categories.push({
            name: node.name,
            shard: node.shard || null,
            url: node.url,
            query: node.query || null,
          });
        }

        // Обрабатываем дочерние элементы
        if (node.childs && Array.isArray(node.childs)) {
          node.childs.forEach((child) => processNode(child));
        }
      }
    };

    // Если catalog это массив, обрабатываем каждый элемент
    if (Array.isArray(catalog)) {
      catalog.forEach((item) => processNode(item));
    } else {
      // Если catalog это объект, обрабатываем его напрямую
      processNode(catalog);
    }

    await this.logService.log(`Extracted ${categories.length} categories`);
    return categories;
  }

  async findCategoryByUrl(url) {
    try {
      if (!this.catalogData) {
        this.catalogData = await this.fetchWbCatalog();
      }

      const relativeUrl = url.split("https://www.wildberries.ru")[1];
      await this.logService.log(
        `Searching for category with URL: ${relativeUrl}`
      );

      const categories = await this.extractCategoryData(this.catalogData);

      // Добавляем отладочную информацию
      await this.logService.log(`Total categories found: ${categories.length}`);

      const category = categories.find((cat) => {
        const normalizedCatUrl = cat.url.toLowerCase().replace(/\/+$/, "");
        const normalizedSearchUrl = relativeUrl
          .toLowerCase()
          .replace(/\/+$/, "");
        return normalizedCatUrl === normalizedSearchUrl;
      });

      if (category) {
        await this.logService.log(`Found category: ${category.name}`);
        return category;
      }

      await this.logService.log("Category not found in catalog", "warning");
      return null;
    } catch (error) {
      await this.logService.log(
        `Error in findCategoryByUrl: ${error.message}`,
        "error"
      );
      throw error;
    }
  }

  async scrapeWbPage(page, category, isCancelled) {
    if (isCancelled) {
      throw new Error("Parsing cancelled by user");
    }

    const url = `https://catalog.wb.ru/catalog/${category.shard}/catalog?appType=1&curr=rub&dest=-1257786&locale=ru&page=${page}&sort=popular&spp=0&${category.query}`;
    try {
      const response = await axios.get(url, { headers: this.headers });
      const productsCount = response.data.data?.products?.length || 0;
      const logMessage = `Страница ${page}: получено ${productsCount} товаров`;
      await this.logService.log(logMessage);

      if (isCancelled) {
        throw new Error("Parsing cancelled by user");
      }

      return { data: response.data, logMessage };
    } catch (error) {
      let errorMessage = `Ошибка при получении данных со страницы ${page}: ${error.message}`;
      if (error.response) {
        errorMessage += `\nСтатус: ${error.response.status}`;
        if (error.response.data) {
          errorMessage += `\nОтвет сервера: ${JSON.stringify(
            error.response.data
          )}`;
        }
      }
      await this.logService.log(errorMessage, "error");
      throw new Error(errorMessage);
    }
  }

  async processProducts(productsData) {
    if (this.isCancelled) {
      throw new Error("Parsing cancelled by user");
    }
    return (productsData.data?.products || [])
      .filter((product) => "name" in product)
      .map((product) => product.name);
  }

  async parseCategory(url, userId) {
    const startTime = Date.now();
    this.resetParsing();

    try {
      if (this.isCancelled) {
        await this.logService.log("Парсинг отменен пользователем.");
        return true;
      }

      const category = await this.findCategoryByUrl(url);
      if (!category) {
        await this.logService.log(
          "Category not found. Check the URL.",
          "warning"
        );
        return false;
      }

      for (let page = 1; page <= this.MAX_PAGES; page++) {
        if (this.isCancelled) {
          await this.logService.log("Парсинг отменен пользователем.");
          break;
        }

        try {
          const { data, logMessage } = await this.scrapeWbPage(
            page,
            category,
            this.isCancelled
          );
          await this.logService.updateLogMessage(userId, logMessage);

          if (this.isCancelled) {
            await this.logService.log("Парсинг отменен пользователем.");
            break;
          }

          const products = await this.processProducts(data);
          if (!products.length) {
            await this.logService.log(
              `Page ${page}: no products found, stopping parsing.`
            );
            break;
          }

          if (this.isCancelled) {
            await this.logService.log("Парсинг отменен пользователем.");
            break;
          }

          let evirmaResponse;
          try {
            evirmaResponse = await this.evirmaClient.queryEvirmaApi(products);
            if (!evirmaResponse) break;
          } catch (error) {
            await bot.sendMessage(userId, `❌ ${error.message}`, {
              parse_mode: "Markdown",
            });
            break;
          }

          if (this.isCancelled) {
            await this.logService.log("Парсинг отменен пользователем.");
            break;
          }

          const pageResults = await this.evirmaClient.parseEvirmaResponse(
            evirmaResponse
          );
          this.results.push(...pageResults);

          // Увеличиваем задержку между запросами
          await new Promise((resolve) => setTimeout(resolve, 2000));
        } catch (error) {
          if (error.message === "Parsing cancelled by user") {
            await this.logService.log("Парсинг отменен пользователем.");
            break;
          }

          // Отправляем сообщение пользователю об ошибке
          await bot.sendMessage(userId, `❌ ${error.message}`, {
            parse_mode: "Markdown",
          });

          // Прекращаем парсинг при ошибке scrapeWbPage
          if (
            error.message.includes("Ошибка при получении данных со страницы")
          ) {
            await this.logService.log(
              "Парсинг прекращен из-за ошибки получения данных."
            );
            break;
          }

          throw error;
        }
      }

      if (this.results.length) {
        const filename = `${category.name}_analysis_${Date.now()}`;
        const filePath = await this.fileService.saveToExcel(
          this.results,
          filename
        );
        if (filePath)
          await this.fileService.sendExcelToUser(filePath, filename, userId);
      } else {
        await this.logService.log("No products found matching criteria.");
      }
      return true;
    } catch (error) {
      if (error.message === "Parsing cancelled by user") {
        if (this.results.length) {
          const filename = `${category?.name || "wb"}_analysis_${Date.now()}`;
          const filePath = await this.fileService.saveToExcel(
            this.results,
            filename
          );
          if (filePath)
            await this.fileService.sendExcelToUser(filePath, filename, userId);
        }
        return true;
      }

      if (error.response?.status === 429) {
        await this.logService.log("Maximum products parsed (429 error).");
      } else {
        await this.logService.log(`Parsing error: ${error.message}`, "error");
      }

      if (this.results.length) {
        const filename = `${category?.name || "wb"}_analysis_${Date.now()}`;
        const filePath = await this.fileService.saveToExcel(
          this.results,
          filename
        );
        if (filePath)
          await this.fileService.sendExcelToUser(filePath, filename, userId);
      }
      return true;
    } finally {
      const elapsedTime = (Date.now() - startTime) / 1000;
      await this.logService.log(
        `Total parsing time: ${elapsedTime.toFixed(2)} seconds`
      );
    }
  }
}

class BotHandlers {
  constructor(bot, parser, logService) {
    this.bot = bot;
    this.parser = parser;
    this.logService = logService;
    this.waitingForUrl = {};
  }

  registerHandlers() {
    // Все обработчики сообщений регистрируются на объекте бота
    // но фактически обрабатываются через webhook
  }

  getMainMenu(userId) {
    const keyboard = {
      reply_markup: {
        keyboard: [["Парсить"]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    };
    if (adminIds.includes(userId))
      keyboard.reply_markup.keyboard.push(["Список подписчиков"]);
    return keyboard;
  }

  getUrlInputMenu() {
    return {
      reply_markup: {
        keyboard: [["Отмена"]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    };
  }

  async start(msg) {
    const userId = msg.from.id;
    const welcomeText =
      "🛍️ *Wilberries Parser Frequency Bot*\n\nЭтот бот анализирует категории Wildberries и предоставляет статистику частоты поиска товаров.\n\nДоступные команды:\n/parse - Запросить анализ категории\n/list - Показать список админов (только для админов)";
    await bot.sendMessage(userId, welcomeText, {
      parse_mode: "Markdown",
      ...this.getMainMenu(userId),
    });
  }

  async listAdmins(msg) {
    const userId = msg.from.id;
    const adminsList = adminIds.map((id) => `- ${id}`).join("\n");
    await bot.sendMessage(userId, `📋 Список админов:\n${adminsList}`, {
      parse_mode: "Markdown",
      ...this.getMainMenu(userId),
    });
  }

  async manualParse(msg) {
    const userId = msg.from.id;
    this.waitingForUrl[userId] = "manual";
    await bot.sendMessage(
      userId,
      "🔗 Пожалуйста, отправьте URL категории Wildberries в формате:\nhttps://www.wildberries.ru/catalog/<category>/<subcategory>/<subsubcategory>\nНапример: https://www.wildberries.ru/catalog/dom-i-dacha/vannaya/aksessuary",
      { parse_mode: "Markdown", ...this.getUrlInputMenu() }
    );
  }

  async handleText(msg) {
    const userId = msg.from.id;
    const text = msg.text.trim();
    console.log("Received message:", text);

    if (text === "Парсить") return await this.manualParse(msg);
    if (text === "Список подписчиков") return await this.listAdmins(msg);
    if (text === "Отмена") {
      console.log("Отмена парсинга пользователем:", userId);
      if (this.waitingForUrl[userId]) {
        delete this.waitingForUrl[userId];
        await bot.sendMessage(userId, "❌ Ввод URL отменён.", {
          parse_mode: "Markdown",
          ...this.getMainMenu(userId),
        });
      }
      // Отменяем текущий процесс парсинга
      this.parser.cancelParsing();
      await bot.sendMessage(userId, "🛑 Процесс парсинга отменяется...", {
        parse_mode: "Markdown",
        ...this.getMainMenu(userId),
      });
      return;
    }

    if (this.waitingForUrl[userId]) {
      const urlPattern =
        /^https:\/\/www\.wildberries\.ru\/catalog\/[\w-]+\/[\w-]+\/[\w-]+$/;
      if (!urlPattern.test(text)) {
        await bot.sendMessage(
          userId,
          '❌ Ошибка: URL некорректен. Пожалуйста, используйте формат:\nhttps://www.wildberries.ru/catalog/<category>/<subcategory>/<subsubcategory>\nНапример: https://www.wildberries.ru/catalog/dom-i-dacha/vannaya/aksессuary\nПопробуйте снова или нажмите "Отмена".',
          { parse_mode: "Markdown", ...this.getUrlInputMenu() }
        );
        return;
      }

      await bot.sendMessage(userId, "🔄 Запускаю анализ категории...", {
        reply_markup: { remove_keyboard: true }, // Убираем клавиатуру при начале парсинга
      });

      const success = await this.parser.parseCategory(text, userId);
      await this.logService.clearLogMessages(userId);
      delete this.waitingForUrl[userId];

      await bot.sendMessage(
        userId,
        success
          ? "✅ Парсинг завершён."
          : "❌ Ошибка: Категория не найдена или URL некорректен. Пожалуйста, используйте правильный формат.",
        { parse_mode: "Markdown", ...this.getMainMenu(userId) }
      );
    }
  }

  async handleUnauthorized(msg) {
    const userId = msg.from.id;
    await this.logService.log(
      `Unauthorized access attempt from user ${userId}`,
      "warning"
    );
    await bot.sendMessage(userId, "❌ У вас нет доступа к этому боту.", {
      parse_mode: "Markdown",
    });
  }

  // Метод для обработки входящих обновлений
  async processUpdate(update) {
    // Проверка на наличие
    if (update.message) {
      const msg = update.message;
      const text = msg.text;
      const userId = msg.from.id;

      // Проверка на авторизацию
      if (!adminIds.includes(userId)) {
        return await this.handleUnauthorized(msg);
      }

      // Обработка команд
      if (text === "/start") {
        await this.start(msg);
      } else if (text === "/list") {
        await this.listAdmins(msg);
      } else if (text === "/parse") {
        await this.manualParse(msg);
      } else {
        // Обработка текстовых сообщений
        await this.handleText(msg);
      }
    }
  }
}

// Initialize services
const logService = new LogService();
const fileService = new FileService(bot, logService);
const evirmaClient = new EvirmaClient(fileService);
const wildberriesParser = new WildberriesParser(
  fileService,
  evirmaClient,
  logService
);
const botHandlers = new BotHandlers(bot, wildberriesParser, logService);

// Инициализация директорий при старте
ensureDirsExist();

// API routes для Vercel
// Health check эндпоинт
app.get("/api/health", async (req, res) => {
  res.status(200).send("Bot is running");
});

// Webhook эндпоинт
app.post("/api/webhook", async (req, res) => {
  try {
    await logService.log("Received webhook update");
    await botHandlers.processUpdate(req.body);
    res.status(200).send("OK");
  } catch (error) {
    await logService.log(`Webhook error: ${error.message}`, "error");
    res.status(500).send("Internal Server Error");
  }
});

// Эндпоинт для установки вебхука
app.get("/api/setup", async (req, res) => {
  const secretToken = req.query.token;
  if (secretToken !== process.env.SETUP_SECRET) {
    return res.status(403).send("Unauthorized");
  }

  try {
    // Удаляем старый вебхук, если он был
    await bot.deleteWebHook();
    // Устанавливаем новый вебхук
    await bot.setWebHook(webhookUrl);

    // Отправляем уведомление админам
    for (const adminId of adminIds) {
      try {
        await bot.sendMessage(
          adminId,
          "🤖 *Бот запущен и готов к работе!*\nВаш ID: " +
            adminId +
            "\nИспользуйте /start для начала работы.",
          { parse_mode: "Markdown" }
        );
      } catch (error) {
        await logService.log(
          `Failed to notify admin ${adminId}: ${error.message}`,
          "error"
        );
      }
    }

    res.status(200).send("Webhook setup successful!");
  } catch (error) {
    await logService.log(`Setup webhook error: ${error.message}`, "error");
    res.status(500).send(`Error setting up webhook: ${error.message}`);
  }
});

// Для локальной разработки
if (process.env.NODE_ENV === "development") {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, async () => {
    await logService.log(`Bot starting up on port ${PORT}...`);
    await logService.log(`Webhook URL: ${webhookUrl}`);
  });
}

// Экспортируем приложение для Vercel
module.exports = app;
