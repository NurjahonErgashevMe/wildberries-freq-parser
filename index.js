const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const fs = require("fs").promises;
const path = require("path");
const xlsx = require("xlsx");
const dotenv = require("dotenv");
const { default: PQueue } = require("p-queue");

// Создаем Express приложение
const app = express();
app.use(express.json());

// Загрузка переменных окружения
dotenv.config();

const { TELEGRAM_BOT_TOKEN, ADMIN_ID } = process.env;
const adminIds = ADMIN_ID.split(",").map((id) => parseInt(id.trim()));

// Инициализация бота в режиме polling
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

const queue = new PQueue({ concurrency: 2, interval: 2000 });

// Временные пути для хранения данных
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

    // Add delay every 10 requests
    if (
      this.logMessages[userId]?.text?.length % 10 === 0 &&
      this.logMessages[userId]?.text?.length > 0
    ) {
      const delayMessage = "⏳ Пауза 10 секунд после 10 запросов...";
      await this.log(delayMessage);
      await bot.editMessageText(
        `📄 *Логи парсинга:*\n${this.logMessages[userId].text.join(
          "\n"
        )}\n${delayMessage}`,
        {
          chat_id: userId,
          message_id: this.logMessages[userId].messageId,
          parse_mode: "Markdown",
        }
      );
      await new Promise((resolve) => setTimeout(resolve, 10000)); // 10 second delay
    }

    if (!this.logMessages[userId]) {
      // Create initial message
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

      // If reached 30 messages, delete old message and create new one
      if (currentLogs.length >= 20) {
        try {
          // Delete old message
          await bot.deleteMessage(userId, this.logMessages[userId].messageId);

          // Create new message with latest logs
          const message = await bot.sendMessage(
            userId,
            `📄 *Логи парсинга:*\n${logMessage}`,
            { parse_mode: "Markdown" }
          );

          // Reset logs array and update message ID
          this.logMessages[userId] = {
            messageId: message.message_id,
            text: [logMessage],
          };
        } catch (error) {
          await this.log(
            `Failed to reset logs for user ${userId}: ${error.message}`,
            "error"
          );
        }
      } else {
        // Update existing message
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

  // Добавьте этот метод в класс FileService
  normalizeProductName(name) {
    if (!name || typeof name !== "string") return name;

    const original = name;
    const normalized = name.trim().replace(/\s+/g, " ");

    if (original !== normalized) {
      console.log(`Normalized product name: "${original}" -> "${normalized}"`);
    }

    return normalized;
  }

  async readExcelFile(filePath, userId) {
    // Уведомляем о начале обработки
    await this.bot.sendMessage(userId, `👁 Смотрю файл...`, {
      reply_markup: { remove_keyboard: true },
    });
    try {
      const fileBuffer = await fs.readFile(filePath);
      const workbook = xlsx.read(fileBuffer);
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      return xlsx.utils.sheet_to_json(worksheet);
    } catch (error) {
      await this.logService.log(
        `Error reading Excel file: ${error.message}`,
        "error"
      );
      throw error;
    }
  }

  async updateExcelFile(filePath, data, updateField) {
    try {
      const fileBuffer = await fs.readFile(filePath);
      const workbook = xlsx.read(fileBuffer);
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];

      // Обновляем данные
      const jsonData = xlsx.utils.sheet_to_json(worksheet);
      const updatedData = jsonData.map((row, index) => ({
        ...row,
        [updateField]: data[index]?.[updateField] || row[updateField] || "",
      }));

      // Создаем новый worksheet с обновленными данными
      const newWorksheet = xlsx.utils.json_to_sheet(updatedData);

      // Устанавливаем ширину столбцов
      newWorksheet["!cols"] = [
        { wch: 50 }, // Название
        { wch: 30 }, // Частота товара
        { wch: 30 }, // Количество товара
      ];

      // Обновляем workbook
      workbook.Sheets[workbook.SheetNames[0]] = newWorksheet;

      // Сохраняем обновленный файл
      await fs.writeFile(
        filePath,
        xlsx.write(workbook, { type: "buffer", bookType: "xlsx" })
      );
      return filePath;
    } catch (error) {
      await this.logService.log(
        `Error updating Excel file: ${error.message}`,
        "error"
      );
      throw error;
    }
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

      // Получаем размер файла
      const stats = await fs.stat(filePath);
      const fileSizeInBytes = stats.size;
      const fileSizeInMegabytes = fileSizeInBytes / (1024 * 1024);

      // Проверяем размер файла (Telegram ограничение ~50MB)
      if (fileSizeInMegabytes > 50) {
        throw new Error("413 Request Entity Too Large");
      }

      await this.bot.sendDocument(userId, filePath, {
        caption,
        parse_mode: "Markdown",
        contentType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
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
      if (error.message.includes("413 Request Entity Too Large")) {
        // Создаем папку output если ее нет
        const outputDir = path.join(process.cwd(), "output");
        try {
          await fs.mkdir(outputDir, { recursive: true });

          // Генерируем имя файла с timestamp
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
          const newFilename = `${filename}_${timestamp}.xlsx`;
          const newFilePath = path.join(outputDir, newFilename);

          // Копируем файл в папку output
          await fs.copyFile(filePath, newFilePath);

          // Отправляем сообщение пользователю
          const message = `📁 Файл слишком большой для отправки через Telegram (>50MB).\nОн был сохранен локально: \`${newFilePath}\``;
          await this.bot.sendMessage(userId, message, {
            parse_mode: "Markdown",
          });

          await this.logService.log(`Large file saved locally: ${newFilePath}`);
        } catch (saveError) {
          await this.logService.log(
            `Failed to save large file locally: ${saveError.message}`,
            "error"
          );
          await this.bot.sendMessage(
            userId,
            `❌ Ошибка при сохранении файла: ${saveError.message}`,
            { parse_mode: "Markdown" }
          );
        }
      } else {
        await this.bot.sendMessage(
          userId,
          `❌ Ошибка при отправке файла: ${error.message}`,
          { parse_mode: "Markdown" }
        );
      }

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
    this.logService = logService;
  }

  async processExcelData(names, fieldToUpdate, progressCallback, userId) {
    const BATCH_SIZE = 100;
    const results = [];
    let processedCount = 0;
    const MAX_RETRIES = 10;
    const RETRY_DELAY = 30000; // 30 seconds

    const normalizedNames = names.map((name) =>
      this.fileService.normalizeProductName(name)
    );

    for (let i = 0; i < normalizedNames.length; i += BATCH_SIZE) {
      // Add delays for large datasets
      if (i > 0) {
        if (i % 100000 === 0) {
          const restMessage =
            "⏳ Делаем перерыв на 60 секунд после 100к запросов...";
          await this.logService.updateLogMessage(userId, restMessage);
          await new Promise((resolve) => setTimeout(resolve, 60000)); // 1 minute delay
        } else if (i % 20000 === 0) {
          const restMessage =
            "⏳ Делаем перерыв на 30 секунд после 20к запросов...";
          await this.logService.updateLogMessage(userId, restMessage);
          await new Promise((resolve) => setTimeout(resolve, 30000)); // 30 seconds delay
        }
      }

      const batch = normalizedNames.slice(i, i + BATCH_SIZE);

      // Update logs based on data size
      if (normalizedNames.length >= 2000) {
        if (i % (BATCH_SIZE * 100) === 0) {
          const logMessage = `🔄 Обрабатываем товары: ${i + 1}-${Math.min(
            i + BATCH_SIZE * 100,
            normalizedNames.length
          )} из ${normalizedNames.length}`;
          await this.logService.updateLogMessage(userId, logMessage);
        } else {
          const logMessage = `🔄 Обрабатываем товары: ${i + 1}-${Math.min(
            i + BATCH_SIZE,
            normalizedNames.length
          )} из ${normalizedNames.length}`;
          await this.logService.log(logMessage);
        }
      } else {
        const logMessage = `🔄 Обрабатываем товары: ${i + 1}-${Math.min(
          i + BATCH_SIZE,
          normalizedNames.length
        )} из ${normalizedNames.length}`;
        await this.logService.updateLogMessage(userId, logMessage);
      }

      let attempt = 0;
      let success = false;

      while (!success && attempt < MAX_RETRIES) {
        try {
          const evirmaResponse = await this.queryEvirmaApi(batch, userId);
          if (evirmaResponse) {
            const batchResults = await this.parseEvirmaResponse(evirmaResponse);
            results.push(...batchResults);
            success = true;
          }
        } catch (error) {
          attempt++;
          const retryMessage = `⚠️ Ошибка (попытка ${attempt}/${MAX_RETRIES}): ${error.message}. Ожидание 30 секунд...`;
          await this.logService.updateLogMessage(userId, retryMessage);

          if (attempt < MAX_RETRIES) {
            await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
          } else {
            const errorMessage = `❌ Не удалось обработать товары ${
              i + 1
            }-${Math.min(
              i + BATCH_SIZE,
              normalizedNames.length
            )} после ${MAX_RETRIES} попыток`;
            await this.logService.updateLogMessage(userId, errorMessage);
          }
        }
      }

      processedCount += batch.length;
      if (progressCallback) progressCallback(processedCount);
    }

    return names.map((name) => {
      const normalizedName = this.fileService.normalizeProductName(name);
      const found = results.find((item) => item["Название"] === normalizedName);
      return {
        Название: normalizedName,
        [fieldToUpdate]: found ? found[fieldToUpdate] : 0,
      };
    });
  }

  async queryEvirmaApi(keywords, userId) {
    const payload = { keywords, an: false };
    const MAX_RETRIES = 3; // Максимальное количество попыток
    let attempt = 0;

    while (attempt < MAX_RETRIES) {
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
        return response.data;
      } catch (error) {
        attempt++;
        const retryMessage = `⚠️ Попытка ${attempt}/${MAX_RETRIES} для ключевых слов`;
        await this.logService.updateLogMessage(userId, retryMessage);

        if (attempt >= MAX_RETRIES) {
          const errorMessage = `❌ Ошибка при запросе к Evirma API: ${error.message}`;
          await this.logService.updateLogMessage(userId, errorMessage);
          throw new Error(errorMessage);
        }
      }
    }
  }

  async parseEvirmaResponse(evirmaData) {
    const parsedData = [];
    if (!evirmaData?.data?.keywords) return parsedData;

    for (const [keyword, keywordData] of Object.entries(
      evirmaData.data.keywords
    )) {
      const normalizedKeyword = this.fileService.normalizeProductName(keyword);
      // Skip if cluster is null or counts are 0
      if (
        !keywordData.cluster ||
        !keywordData.cluster.product_count ||
        !keywordData.cluster.freq_syn?.monthly
      ) {
        continue;
      }

      parsedData.push({
        Название: normalizedKeyword,
        "Количество товара": keywordData.cluster.product_count,
        "Частота товара": keywordData.cluster.freq_syn.monthly,
      });
    }
    return parsedData;
  }
}

class ExcelParser {
  constructor(bot, fileService, evirmaClient, logService) {
    this.bot = bot;
    this.fileService = fileService;
    this.evirmaClient = evirmaClient;
    this.logService = logService;
    this.userStates = {};
  }

  async handleExcelFile(userId, fileId, filePath) {
    try {
      // Читаем Excel файл
      const data = await this.fileService.readExcelFile(filePath, userId);
      const names = data
        .map((row) => this.fileService.normalizeProductName(row["Название"]))
        .filter((name) => name && name.trim() !== "");

      if (!names || names.length === 0) {
        throw new Error("Не найдены названия товаров в колонке 'Название'");
      }

      // Определяем доступные поля
      const hasFrequency = data.some(
        (row) => row["Частота товара"] !== undefined
      );
      const hasQuantity = data.some(
        (row) => row["Количество товара"] !== undefined
      );

      // Сохраняем состояние
      this.userStates[userId] = {
        filePath,
        data,
        names,
        hasFrequency,
        hasQuantity,
      };

      // Отправляем клавиатуру с действиями
      await this.sendActionKeyboard(userId, names.length);
    } catch (error) {
      await this.bot.sendMessage(
        userId,
        `❌ Ошибка при обработке файла: ${error.message}`,
        { parse_mode: "Markdown" }
      );
      await this.logService.log(`Excel file error: ${error.message}`, "error");

      // Удаляем временный файл при ошибке
      try {
        await fs.unlink(filePath);
      } catch (e) {
        await this.logService.log(`Error deleting file: ${e.message}`, "error");
      }
    }
  }

  async sendActionKeyboard(userId, itemsCount) {
    const state = this.userStates[userId];
    if (!state) return;

    const keyboard = {
      keyboard: [],
      resize_keyboard: true,
      one_time_keyboard: true,
    };

    // Формируем кнопки на основе доступных данных
    if (!state.hasFrequency) {
      keyboard.keyboard.push(["Добавить частоту товаров"]);
    } else {
      keyboard.keyboard.push(["Обновить частоту товаров"]);
    }

    if (!state.hasQuantity) {
      keyboard.keyboard.push(["Добавить количество товаров"]);
    } else {
      keyboard.keyboard.push(["Обновить количество товаров"]);
    }

    keyboard.keyboard.push(["Отмена"]);

    await this.bot.sendMessage(
      userId,
      `📊 Файл успешно обработан. Найдено товаров: ${itemsCount}\nВыберите действие:`,
      { reply_markup: keyboard }
    );
  }

  async processUserChoice(userId, choice) {
    if (!this.userStates[userId]) {
      await this.bot.sendMessage(
        userId,
        "❌ Сессия устарела. Пожалуйста, отправьте файл заново.",
        { parse_mode: "Markdown" }
      );
      return;
    }

    const state = this.userStates[userId];
    const { names, filePath } = state;

    try {
      // Очищаем старые логи
      await this.logService.clearLogMessages(userId);

      // Определяем поле для обновления
      const fieldToUpdate = choice.includes("частот")
        ? "Частота товара"
        : "Количество товара";

      // Уведомляем о начале обработки
      const processingMsg = await this.bot.sendMessage(
        userId,
        `⏳ Начинаю ${choice.toLowerCase()} для ${names.length} товаров...`,
        { reply_markup: { remove_keyboard: true } }
      );

      this.logService.log("Обрабатываем данные", "info");
      // Обрабатываем данные
      const results = await this.evirmaClient.processExcelData(
        names,
        fieldToUpdate,
        null,
        userId
      );

      this.logService.log("Обновляем файл", "info");

      // Обновляем файл
      const updatedFilePath = await this.fileService.updateExcelFile(
        filePath,
        results,
        fieldToUpdate
      );

      // Отправляем обновленный файл
      await this.fileService.sendExcelToUser(
        updatedFilePath,
        `updated_${Date.now()}`,
        userId
      );

      // Уведомляем о завершении
      await this.bot.sendMessage(
        userId,
        `✅ ${choice} успешно завершено!\nОбработано товаров: ${names.length}`,
        { parse_mode: "Markdown" }
      );
    } catch (error) {
      if (error.response && error.response.statusCode === 429) {
        const retryAfter = error?.response.body.parameters.retry_after || 10; // По умолчанию 10 секунд
        await this.bot.sendMessage(
          userId,
          `⚠️ Превышен лимит запросов. Повторная попытка через ${retryAfter} секунд...`,
          { parse_mode: "Markdown" }
        );
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        return this.processUserChoice(userId, choice); // Повторяем попытку
      }

      await this.bot.sendMessage(
        userId,
        `❌ Ошибка при ${choice.toLowerCase()}: ${error.message}`,
        { parse_mode: "Markdown" }
      );
      await this.logService.log(
        `Excel processing error: ${error.message}`,
        "error"
      );
    } finally {
      // Очищаем состояние
      // delete this.userStates[userId];
      // Удаляем временный файл
      try {
        await fs.unlink(filePath);
        // await this.logService.log('finally');
      } catch (e) {
        await this.logService.log(`Error deleting file: ${e.message}`, "error");
      }
    }
  }

  async cancelProcessing(userId) {
    if (this.userStates[userId]) {
      delete this.userStates[userId];
      await this.logService.log(
        `Обработка Excel отменена пользователем ${userId}`
      );
    }
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
    this.MAX_PAGES = 50;
    this.activeParsingUsers = new Set();
    this.RETRY_WAIT_TIME = 30000; // 30 секунд
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
            searchQuery: node.searchQuery || null,
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

  async findSearchByUrl(url) {
    try {
      const urlObj = new URL(url);
      const searchParams = urlObj.searchParams;

      // Получаем поисковый запрос
      const searchQuery = searchParams.get("search") || "";
      const decodedQuery = decodeURIComponent(searchQuery);

      // Извлекаем все параметры фильтрации, кроме page
      const filterParams = {};
      for (const [key, value] of searchParams.entries()) {
        if (key !== "search" && key !== "page") {
          filterParams[key] = value;
        }
      }

      await this.logService.log(
        `Search query: ${decodedQuery}\nFilter params: ${JSON.stringify(
          filterParams
        )}`
      );

      return {
        query: decodedQuery,
        filters: filterParams,
      };
    } catch (error) {
      await this.logService.log(
        `Error in findSearchByUrl: ${error.message}`,
        "error"
      );
      throw error;
    }
  }

  async scrapeWbSearchPage(page, searchParams, userId) {
    const { query, filters } = searchParams;
    const encodedQuery = encodeURIComponent(query);

    // Базовый URL поиска
    let url = `https://search.wb.ru/exactmatch/sng/common/v13/search?ab_testing=false&appType=1&curr=rub&dest=-1257786&lang=ru&page=${page}&query=${encodedQuery}&resultset=catalog&sort=popular&spp=0`;

    // Добавляем все параметры фильтрации
    for (const [key, value] of Object.entries(filters)) {
      url += `&${key}=${encodeURIComponent(value)}`;
    }

    await this.logService.log(`Search URL: ${url}`);
    const MAX_RETRIES = 6;
    let attempt = 0;

    while (attempt < MAX_RETRIES) {
      try {
        const response = await axios.get(url, { headers: this.headers });
        const productsCount = response.data.data?.products?.length || 0;
        const logMessage = `Страница поиска ${page}: получено ${productsCount} товаров`;
        await this.logService.log(logMessage);

        // Добавляем задержку между запросами
        if (page % 10 === 0) {
          await this.logService.log("Ждем 10 секунд после 10 страниц...");
          await new Promise((resolve) => setTimeout(resolve, 10000));
        } else {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }

        return { data: response.data, logMessage };
      } catch (error) {
        attempt++;
        if (error.response && error.response.status === 429) {
          const retryMessage = `ℹ️ Возникла ошибка с лимитом Wildberries, отправим через ${
            this.RETRY_WAIT_TIME / 1000
          } секунд.`;
          await this.logService.log(retryMessage, "warning");
          const botMessage = await bot.sendMessage(userId, retryMessage, {
            parse_mode: "markdown",
          });
          await new Promise((resolve) =>
            setTimeout(resolve, this.RETRY_WAIT_TIME)
          );
          const updateMessage = `Отправляем запрос для поиска, страница ${page}, попытка: ${attempt}`;
          await bot.editMessageText(updateMessage, {
            chat_id: userId,
            message_id: botMessage.message_id,
            parse_mode: "markdown",
          });
          await this.logService.log(updateMessage);
          continue;
        }

        let errorMessage = `Ошибка при поиске товаров, страница ${page}: ${error.message}`;
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

    throw new Error(
      `Не удалось выполнить поиск, страница ${page} после ${MAX_RETRIES} попыток.`
    );
  }

  async scrapeWbSearchPageWithQueue(page, searchParams, userId) {
    return queue.add(() => this.scrapeWbSearchPage(page, searchParams, userId));
  }

  async parseSearch(url, userId) {
    if (this.activeParsingUsers.has(userId)) {
      await this.logService.log(
        `Parsing already in progress for user ${userId}`
      );
      return false;
    }

    // Очищаем старые логи
    await this.logService.clearLogMessages(userId);

    this.activeParsingUsers.add(userId);
    const startTime = Date.now();
    this.results = [];

    try {
      const searchParams = await this.findSearchByUrl(url);
      if (!searchParams.query) {
        await this.logService.log(
          "Search query not found. Check the URL.",
          "warning"
        );
        return false;
      }

      for (let page = 1; page <= this.MAX_PAGES; page++) {
        try {
          const { data, logMessage } = await this.scrapeWbSearchPageWithQueue(
            page,
            searchParams,
            userId
          );
          await this.logService.updateLogMessage(userId, logMessage);

          const products = await this.processProducts(data);
          if (!products.length) {
            await this.logService.log(
              `Page ${page}: no products found, stopping parsing.`
            );
            break;
          }

          let evirmaResponse;
          try {
            evirmaResponse = await this.evirmaClient.queryEvirmaApi(
              products,
              userId
            );
            if (!evirmaResponse) break;
          } catch (error) {
            await bot.sendMessage(userId, `❌ ${error.message}`, {
              parse_mode: "Markdown",
            });
            break;
          }

          const pageResults = await this.evirmaClient.parseEvirmaResponse(
            evirmaResponse
          );
          this.results.push(...pageResults);
        } catch (error) {
          await bot.sendMessage(userId, `❌ ${error.message}`, {
            parse_mode: "Markdown",
          });
          break;
        }
      }

      if (!this.results || !this.results.length) {
        return await bot.sendMessage(
          userId,
          `📊 Найдены товары, но у всех частота поиска равна 0.\nВозможно, эти товары редко ищут или они новые в каталоге.`,
          { parse_mode: "Markdown" }
        );
      }

      if (this.results.length > 0) {
        const filename = `search_${searchParams.query}_analysis_${Date.now()}`;
        const filePath = await this.fileService.saveToExcel(
          this.results,
          filename
        );
        if (filePath) {
          await this.fileService.sendExcelToUser(filePath, filename, userId);
        }
      } else {
        await bot.sendMessage(
          userId,
          "❌ Не найдено товаров по данному поисковому запросу с указанными фильтрами.",
          { parse_mode: "Markdown" }
        );
      }

      return true;
    } catch (error) {
      await this.logService.log(
        `Search parsing error: ${error.message}`,
        "error"
      );
      return false;
    } finally {
      this.activeParsingUsers.delete(userId);
      const elapsedTime = (Date.now() - startTime) / 1000;
      await this.logService.log(
        `Total search parsing time: ${elapsedTime.toFixed(2)} seconds`
      );
    }
  }

  async parseUrl(url, userId) {
    // Определяем тип URL (каталог или поиск)
    if (url.includes("/search.aspx?")) {
      return this.parseSearch(url, userId);
    } else {
      return this.parseCategory(url, userId);
    }
  }

  async findCategoryByUrl(url) {
    try {
      if (!this.catalogData) {
        this.catalogData = await this.fetchWbCatalog();
      }

      // Разбираем URL на базовый путь и параметры
      const urlObj = new URL(url);
      const baseUrl = urlObj.pathname;
      const searchParams = urlObj.searchParams;

      // Получаем параметры фильтрации
      const filterParams = {
        priceU: searchParams.get("priceU") || null,
        xsubject: searchParams.get("xsubject") || null,
        fbrand: searchParams.get("fbrand") || null,
        fsupplier: searchParams.get("fsupplier") || null,
        sort: searchParams.get("sort") || "popular",
      };

      await this.logService.log(
        `Searching for category with URL: ${baseUrl}\nFilter params: ${JSON.stringify(
          filterParams
        )}`
      );

      const categories = await this.extractCategoryData(this.catalogData);
      await this.logService.log(`Total categories found: ${categories.length}`);

      const category = categories.find((cat) => {
        const normalizedCatUrl = cat.url.toLowerCase().replace(/\/+$/, "");
        const normalizedSearchUrl = baseUrl.toLowerCase().replace(/\/+$/, "");
        return normalizedCatUrl === normalizedSearchUrl;
      });

      if (category) {
        await this.logService.log(`Found category: ${category.name}`);

        // Добавляем параметры фильтрации к query параметрам категории
        let query = category.query || "";
        if (filterParams.priceU) query += `&priceU=${filterParams.priceU}`;
        if (filterParams.xsubject)
          query += `&xsubject=${filterParams.xsubject}`;
        if (filterParams.fbrand) query += `&fbrand=${filterParams.fbrand}`;
        if (filterParams.fsupplier)
          query += `&fsupplier=${filterParams.fsupplier}`;
        if (filterParams.sort) query += `&sort=${filterParams.sort}`;

        return {
          ...category,
          query: query,
        };
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

  async scrapeWbPage(page, category, userId) {
    console.log(category)
    // const url = `https://catalog.wb.ru/catalog/${category.shard}/catalog?appType=1&curr=rub&dest=-1257786&locale=ru&page=${page}&sort=popular&spp=0&${category.query}`;
    const url = `https://search.wb.ru/exactmatch/sng/common/v14/search?ab_testing=false&appType=1&curr=rub&dest=-1257786&hide_dtype=13;14&lang=ru&page=${page}&query=${category.searchQuery}&resultset=catalog&sort=popular&spp=30&suppressSpellcheck=false`;
    this.logService.log(`URL : ${url}`);
    const MAX_RETRIES = 6;
    let attempt = 0;

    while (attempt < MAX_RETRIES) {
      try {
        const response = await axios.get(url, { headers: this.headers });
        const productsCount = response.data.products?.length || 0;
        const logMessage = `Страница ${page}: получено ${productsCount} товаров`;
        await this.logService.log(url);
        await this.logService.log(logMessage);

        // Добавляем задержку между запросами
        if (page % 10 === 0) {
          await this.logService.log("Ждем 10 секунд после 10 запросов...");
          await new Promise((resolve) => setTimeout(resolve, 10000)); // 10 секунд
        } else {
          await new Promise((resolve) => setTimeout(resolve, 2000)); // 2 секунды
        }

        return { data: response.data, logMessage };
      } catch (error) {
        attempt++;
        if (error.response && error.response.status === 429) {
          const retryMessage = `ℹ️ Возникла ошибка с лимитом Wildberries, отправим через ${
            this.RETRY_WAIT_TIME / 1000
          } секунд.`;
          await this.logService.log(retryMessage, "warning");
          const botMessage = await bot.sendMessage(userId, retryMessage, {
            parse_mode: "markdown",
          });
          await new Promise((resolve) =>
            setTimeout(resolve, this.RETRY_WAIT_TIME)
          );
          const updateMessage = `Отправляем запрос для получения данных для страницы ${page}, попытка: ${attempt}`;
          await bot.editMessageText(updateMessage, {
            chat_id: userId,
            message_id: botMessage.message_id,
            parse_mode: "markdown",
          });
          await this.logService.log(updateMessage);
          continue;
        }

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

    throw new Error(
      `Не удалось получить данные для страницы ${page} после ${MAX_RETRIES} попыток.`
    );
  }

  async scrapeWbPageWithQueue(page, category, userId) {
    return queue.add(() => this.scrapeWbPage(page, category, userId));
  }

  async processProducts(productsData) {
    return (productsData.products || [])
      .filter((product) => "name" in product)
      .map((product) => this.fileService.normalizeProductName(product.name));
  }

  async parseCategory(url, userId) {
    // Проверяем, не идет ли уже парсинг для этого пользователя
    if (this.activeParsingUsers.has(userId)) {
      await this.logService.log(
        `Parsing already in progress for user ${userId}`
      );
      return false;
    }

    this.activeParsingUsers.add(userId);
    const startTime = Date.now();
    this.results = [];

    try {
      const category = await this.findCategoryByUrl(url);
      if (!category) {
        await this.logService.log(
          "Category not found. Check the URL.",
          "warning"
        );
        return false;
      }

      for (let page = 1; page <= this.MAX_PAGES; page++) {
        try {
          const { data, logMessage } = await this.scrapeWbPageWithQueue(
            page,
            category,
            userId
          );
          await this.logService.updateLogMessage(userId, logMessage);

          const products = await this.processProducts(data);
          if (!products.length) {
            await this.logService.log(
              `Page ${page}: no products found, stopping parsing.`
            );
            break;
          }

          let evirmaResponse;
          try {
            evirmaResponse = await this.evirmaClient.queryEvirmaApi(
              products,
              userId
            );
            if (!evirmaResponse) break;
          } catch (error) {
            await bot.sendMessage(userId, `❌ ${error.message}`, {
              parse_mode: "Markdown",
            });
            break;
          }

          const pageResults = await this.evirmaClient.parseEvirmaResponse(
            evirmaResponse
          );
          this.results.push(...pageResults);
        } catch (error) {
          await bot.sendMessage(userId, `❌ ${error.message}`, {
            parse_mode: "Markdown",
          });
          break;
        }
      }

      if (!this.results || !this.results.length) {
        return await bot.sendMessage(
          userId,
          `📊 Найдены товары, но у всех частота поиска равна 0.\nВозможно, эти товары редко ищут или они новые в каталоге.`,
          { parse_mode: "Markdown" }
        );
      }

      if (this.results.length > 0) {
        const filename = `${category.name}_analysis_${Date.now()}`;
        const filePath = await this.fileService.saveToExcel(
          this.results,
          filename
        );
        if (filePath) {
          await this.fileService.sendExcelToUser(filePath, filename, userId);
        }
      } else {
        await bot.sendMessage(
          userId,
          "❌ Не найдено товаров в данной категории с указанными фильтрами.",
          { parse_mode: "Markdown" }
        );
      }

      return true;
    } catch (error) {
      await this.logService.log(`Parsing error: ${error.message}`, "error");
      return false;
    } finally {
      this.activeParsingUsers.delete(userId);
      const elapsedTime = (Date.now() - startTime) / 1000;
      await this.logService.log(
        `Total parsing time: ${elapsedTime.toFixed(2)} seconds`
      );
    }
  }
}

class BotHandlers {
  constructor(bot, parser, logService, excelParser) {
    this.bot = bot;
    this.parser = parser;
    this.logService = logService;
    this.excelParser = excelParser;
    this.waitingForUrl = {};
    this.waitingForExcel = {};
    // this.userLinks = {};
  }

  registerHandlers() {
    this.bot.onText(/\/start/, (msg) => {
      this.start(msg);
    });

    this.bot.onText(/\/list/, (msg) => {
      this.listAdmins(msg);
    });

    this.bot.onText(/\/parsingfromexcel/, (msg) => {
      this.startExcelParse(msg);
    });

    this.bot.onText(/\/parse/, (msg) => {
      this.manualParse(msg);
    });

    this.bot.on("message", async (msg) => {
      if (!msg.text) return;

      const text = msg.text.trim();
      const userId = msg.from.id;

      if (text === "Отмена") {
        return this.handleCancel(msg);
      }

      if (
        this.excelParser.userStates[userId] &&
        (text === "Добавить частоту товаров" ||
          text === "Обновить частоту товаров" ||
          text === "Добавить количество товаров" ||
          text === "Обновить количество товаров")
      ) {
        await this.excelParser.processUserChoice(userId, text);
        return;
      }

      if (!text.startsWith("/")) {
        if (text === "Парсить") return this.manualParse(msg);
        if (text === "Парсить Excel") return this.startExcelParse(msg);
        if (text === "Список подписчиков") return this.listAdmins(msg);
        if (this.waitingForUrl[userId]) return this.handleText(msg);
      }
    });

    this.bot.on("document", async (msg) => {
      await this.handleDocument(msg);
    });

    // this.bot.on("callback_query", async (query) => {
    //   await this.handleCallbackQuery(query);
    // });
  }

  getMainMenu(userId) {
    return {
      keyboard: [["Парсить"], ["Парсить Excel"]],
      resize_keyboard: true,
      one_time_keyboard: true,
    };
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
    if (!adminIds.includes(userId)) {
      return this.handleUnauthorized(msg);
    }

    const welcomeText =
      "🛍️Wilberries Parser Frequency Bot\nЭтот бот анализирует категории Wildberries и предоставляет статистику частоты поиска товаров.\n\nДоступные команды:\n/parse - Запросить анализ категории\n/parsing_from_excel - парсинг продуктов по эксель\n/list - Показать список админов (только для админов)";

    await this.bot.sendMessage(userId, welcomeText, {
      parse_mode: "Markdown",
      ...this.getMainMenu(userId),
    });
  }

  async listAdmins(msg) {
    const userId = msg.from.id;
    if (!adminIds.includes(userId)) {
      return this.handleUnauthorized(msg);
    }

    const adminsList = adminIds.map((id) => `- ${id}`).join("\n");
    await this.bot.sendMessage(userId, `📋 Список админов:\n${adminsList}`, {
      parse_mode: "Markdown",
      ...this.getMainMenu(userId),
    });
  }

  async manualParse(msg) {
    const userId = msg.from.id;
    if (!adminIds.includes(userId)) {
      return this.handleUnauthorized(msg);
    }

    this.waitingForUrl[userId] = true;
    await this.bot.sendMessage(
      userId,
      "🔗 Пожалуйста, отправьте одну или несколько ссылок Wildberries через пробелы:\n\nПример:\nhttps://www.wildberries.ru/catalog/dom-i-dacha/vannaya/aksessuary https://www.wildberries.ru/catalog/elektronika/avtoelektronika https://www.wildberries.ru/catalog/0/search.aspx?search=геймерское+кресло",
      {
        parse_mode: "Markdown",
        reply_markup: { remove_keyboard: true },
      }
    );
  }

  async handleCancel(msg) {
    const userId = msg.from.id;

    if (this.waitingForUrl[userId]) {
      delete this.waitingForUrl[userId];
      delete this.userLinks[userId];
      await this.logService.log(
        `Парсинг по URL отменен пользователем ${userId}`
      );
    }

    if (this.waitingForExcel[userId]) {
      delete this.waitingForExcel[userId];
      await this.logService.log(
        `Парсинг Excel отменен пользователем ${userId}`
      );
    }

    if (this.excelParser.userStates[userId]) {
      await this.excelParser.cancelProcessing(userId);
    }

    await this.showMainMenu(userId, "❌ Действие отменено");
  }

  async showMainMenu(userId, message = "") {
    const text = message
      ? `${message}\n\nВыберите действие:`
      : "Выберите действие:";
    await this.bot.sendMessage(userId, text, {
      parse_mode: "Markdown",
      ...this.getMainMenu(userId),
    });
  }

  async startExcelParse(msg) {
    const userId = msg.from.id;
    if (!adminIds.includes(userId)) {
      return this.handleUnauthorized(msg);
    }

    this.waitingForExcel[userId] = true;
    await this.bot.sendMessage(
      userId,
      "📊 Пожалуйста, отправьте Excel файл с колонкой 'Название'. Файл должен быть в формате .xlsx",
      {
        parse_mode: "Markdown",
        reply_markup: {
          keyboard: [["Отмена"]],
          resize_keyboard: true,
          one_time_keyboard: true,
        },
      }
    );
  }

  async handleDocument(msg) {
    const userId = msg.from.id;
    if (!this.waitingForExcel[userId] || !msg.document) return;

    try {
      if (!msg.document.file_name.endsWith(".xlsx")) {
        throw new Error("Файл должен быть в формате .xlsx");
      }

      const fileId = msg.document.file_id;
      const tempDir = path.join(outputDir, "temp");
      await fs.mkdir(tempDir, { recursive: true });
      const filePath = path.join(tempDir, `${userId}_${fileId}.xlsx`);

      const file = await this.bot.getFile(fileId);
      const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      const response = await axios.get(fileUrl, {
        responseType: "arraybuffer",
      });

      await fs.writeFile(filePath, response.data);
      await this.excelParser.handleExcelFile(userId, fileId, filePath);
    } catch (error) {
      await this.logService.log(
        `Error handling document: ${error.message}`,
        "error"
      );
      await this.bot.sendMessage(
        userId,
        `❌ Ошибка: ${error.message}\nПожалуйста, попробуйте еще раз.`,
        { parse_mode: "Markdown", ...this.getMainMenu(userId) }
      );
      delete this.waitingForExcel[userId];
    }
  }

  async handleText(msg) {
    const userId = msg.from.id;
    const text = msg.text.trim();

    if (!adminIds.includes(userId)) {
      return this.handleUnauthorized(msg);
    }

    if (this.waitingForUrl[userId]) {
      if (this.parser.activeParsingUsers.has(userId)) {
        await this.bot.sendMessage(
          userId,
          "⏳ Парсинг уже выполняется. Пожалуйста, дождитесь завершения.",
          { parse_mode: "Markdown" }
        );
        return;
      }

      // Разбиваем текст на ссылки
      const urls = text
        .split(/\s+/)
        .filter((url) => url.startsWith("https://www.wildberries.ru/catalog/"));

      if (urls.length === 0) {
        await this.bot.sendMessage(
          userId,
          '❌ Не найдено валидных ссылок. Ссылки должны начинаться с "https://www.wildberries.ru/catalog/"',
          { parse_mode: "Markdown" }
        );
        return this.showMainMenu(userId);
      }

      delete this.waitingForUrl[userId];

      // Начинаем парсинг всех ссылок
      await this.bot.sendMessage(
        userId,
        `🔄 Начинаю парсинг ${urls.length} ссылок...`,
        { parse_mode: "Markdown" }
      );

      for (let i = 0; i < urls.length; i++) {
        const link = urls[i];
        await this.bot.sendMessage(
          userId,
          `📌 Парсинг ссылки ${i + 1}/${urls.length}:\n${link}`,
          { parse_mode: "Markdown" }
        );

        const success = await this.parser.parseUrl(link, userId);
        await this.logService.clearLogMessages(userId);

        await this.bot.sendMessage(
          userId,
          success
            ? `✅ Ссылка ${i + 1} успешно обработана`
            : `❌ Ошибка при обработке ссылки ${i + 1}`,
          { parse_mode: "Markdown" }
        );

        // Пауза между запросами (кроме последней ссылки)
        if (i < urls.length - 1) {
          await this.bot.sendMessage(
            userId,
            "⏳ Ожидание 30 секунд перед следующей ссылкой...",
            { parse_mode: "Markdown" }
          );
          await new Promise((resolve) => setTimeout(resolve, 30000));
        }
      }

      await this.bot.sendMessage(
        userId,
        `✅ Все ссылки обработаны (${urls.length})`,
        {
          parse_mode: "Markdown",
          ...this.getMainMenu(userId),
        }
      );
    }
  }

  async handleUnauthorized(msg) {
    const userId = msg.from.id;
    await this.logService.log(
      `Unauthorized access attempt from user ${userId}`,
      "warning"
    );
    await this.bot.sendMessage(userId, "❌ У вас нет доступа к этому боту.", {
      parse_mode: "Markdown",
    });
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
const excelParser = new ExcelParser(bot, fileService, evirmaClient, logService);
const botHandlers = new BotHandlers(
  bot,
  wildberriesParser,
  logService,
  excelParser
);

// Инициализация директорий при старте
ensureDirsExist();

// Регистрируем обработчики
botHandlers.registerHandlers();

// Health check эндпоинт (если нужно сохранить Express)
app.get("/api/health", async (req, res) => {
  res.status(200).send("Bot is running");
});

// Для локальной разработки
if (process.env.NODE_ENV === "development") {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, async () => {
    await logService.log(`Bot starting up on port ${PORT}...`);
  });
}

// Экспортируем приложение для Vercel (если нужно)
module.exports = app;
