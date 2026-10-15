import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const OFFSET_FILE = new URL("./.telegram-offset", import.meta.url);

export async function telegramRequest(method, body, signal) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Set TELEGRAM_BOT_TOKEN in .env.");
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: body instanceof FormData ? undefined : { "Content-Type": "application/json" },
      body: body instanceof FormData ? body : JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(45_000),
    });
  } catch {
    // Fetch errors can contain the request URL, which includes the bot token.
    throw new Error("Telegram connection failed.");
  }
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(`Telegram request failed (${data.error_code ?? response.status}).`);
  }
  return data.result;
}

export function splitText(text, limit = 3500) {
  const chunks = [];
  let chunk = "";
  for (const character of text) {
    if (chunk.length + character.length > limit) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export async function sendText(chatId, text, entities = []) {
  let offset = 0;
  for (const chunk of splitText(text)) {
    const chunkEntities = entities.filter((entity) => entity.offset < offset + chunk.length &&
      entity.offset + entity.length > offset)
      .map((entity) => ({ ...entity,
        offset: Math.max(entity.offset, offset) - offset,
        length: Math.min(entity.offset + entity.length, offset + chunk.length) - Math.max(entity.offset, offset),
      }));
    await telegramRequest("sendMessage", {
      chat_id: chatId, text: chunk,
      link_preview_options: { is_disabled: true },
      ...(chunkEntities.length ? { entities: chunkEntities } : {}),
    });
    offset += chunk.length;
    await delay(1100);
  }
}

export function formatWord(entry) {
  return wordCard(entry).text;
}

export function wordCard(entry) {
  let text = "";
  const entities = [];
  const add = (value, type) => {
    if (type && value.length) entities.push({ type, offset: text.length, length: value.length });
    text += value;
  };
  const section = (title, content, style) => {
    add("\n\n"); add(title, "bold"); add("\n"); add(content, style);
  };
  add("📖 "); add(entry.word, "bold"); add("\n"); add(entry.pos, "italic");
  section("💡 Meaning", entry.englishDefinition);
  section("🇮🇷 فارسی", entry.persianMeaning, "bold");
  add("\n\n"); add("🗣 Pronunciation", "bold");
  add("\n🇺🇸 US  "); add(entry.pronunciation?.us ?? "Not yet added", "code");
  add("\n🇬🇧 UK  "); add(entry.pronunciation?.uk ?? "Not yet added", "code");
  if (!entry.pronunciation) { add("\nAdd IPA: "); add(`/refresh ${entry.word}`, "code"); }
  section("✍️ In practice", entry.examples.map((example, index) => `${index + 1}. ${example}`).join("\n\n"), "blockquote");
  section("🌱 Word family", entry.wordFamily.join(" · ") || "None listed");
  section("🕰 Word origin", entry.root, "italic");
  return { text, entities };
}

async function sendWord(chatId, entry) {
  const { text, entities } = wordCard(entry);
  await sendText(chatId, text, entities);
}

export function formatList(vocabulary) {
  return [`📚 Your vocabulary · ${vocabulary.length} ${vocabulary.length === 1 ? "word" : "words"}`,
    "Tap a word to review its explanation.", "",
    ...vocabulary.map((entry, index) => `${index + 1}. ${entry.word}\n   ${entry.persianMeaning}`),
  ].join("\n\n");
}

export function linkedList(vocabulary, username) {
  const text = formatList(vocabulary);
  let offset = text.indexOf("1. ");
  const entities = vocabulary.map((entry, index) => {
    const entity = {
      type: "text_link", offset: offset + `${index + 1}. `.length,
      length: entry.word.length,
      url: `https://t.me/${username}?start=vocab_${index}`,
    };
    offset += `${index + 1}. ${entry.word}\n   ${entry.persianMeaning}\n\n`.length;
    return entity;
  });
  entities.push({ type: "bold", offset: 0, length: text.indexOf("\n") });
  return { text, entities };
}

export async function sendList(chatId, vocabulary) {
  const bot = await telegramRequest("getMe", {});
  if (!bot.username) throw new Error("Telegram bot username is missing.");
  const { text, entities } = linkedList(vocabulary, bot.username);
  await sendText(chatId, text, entities);
}

export async function sendVocabulary(chatId, entry, vocabulary) {
  await sendWord(chatId, entry);
  await sendList(chatId, vocabulary);
}

const HELP = "Send an English word or phrase (for example, look out at) to look it up.\n/list — all saved terms\n/export — download vocabulary.json\n/id — your private chat ID\n/help — these instructions";

export async function handleMessage(message, { lookupWord, loadVocabulary }) {
  if (message.chat?.type !== "private" || !message.text) return;
  const chatId = String(message.chat.id);
  const text = message.text.trim();
  const [rawCommand] = text.split(/\s+/);
  const command = rawCommand.toLowerCase().split("@")[0];
  // ID discovery works before configuration; it exposes no vocabulary or API access.
  if (command === "/id") {
    await sendText(chatId, `Your private chat ID: ${chatId}`);
    return;
  }
  if (chatId !== process.env.TELEGRAM_CHAT_ID?.trim()) return;
  const payload = text.slice(rawCommand.length).trim();
  if (command === "/start" && /^vocab_\d+$/.test(payload)) {
    const entry = (await loadVocabulary())[Number(payload.slice(6))];
    if (entry) await sendWord(chatId, entry);
    else await sendText(chatId, "Word not found. Send /list for the current list.");
  } else if (["/start", "/help"].includes(command)) {
    await sendText(chatId, `${HELP}\n/refresh word — fetch updated details including US/UK IPA (uses AvalAI)`);
  } else if (command === "/list") {
    await sendList(chatId, await loadVocabulary());
  } else if (command === "/export") {
    const vocabulary = await loadVocabulary();
    const form = new FormData();
    form.set("chat_id", chatId);
    form.set("document", new Blob([JSON.stringify(vocabulary, null, 2)], {
      type: "application/json",
    }), "vocabulary.json");
    await telegramRequest("sendDocument", form);
  } else if (text.startsWith("/") && !["/word", "/refresh"].includes(command)) {
    await sendText(chatId, HELP);
  } else {
    const word = ["/word", "/refresh"].includes(command) ? text.slice(rawCommand.length).trim() : text;
    let result;
    try {
      result = await lookupWord(word, { refresh: command === "/refresh" });
    } catch (error) {
      console.error("Lookup failed:", error instanceof Error ? error.message : String(error));
      await sendText(chatId, "Lookup failed. Send an English word or short phrase; check the bot console for details.");
      return;
    }
    // Persistence finishes before delivery; sending an existing word uses local data.
    await sendVocabulary(chatId, result.entry, await loadVocabulary());
  }
}

export async function runBot(services) {
  if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error("Set TELEGRAM_BOT_TOKEN in .env.");
  await services.loadVocabulary();
  const webhook = await telegramRequest("getWebhookInfo", {});
  if (webhook.url) throw new Error("This bot has a webhook configured. Remove it before using polling.");
  let offset = 0;
  try {
    offset = Number((await readFile(OFFSET_FILE, "utf8")).trim());
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid .telegram-offset file.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.log("Telegram bot running. Keep this process open; press Ctrl+C to stop.");
  if (!process.env.TELEGRAM_CHAT_ID) console.log("Send /id to your bot, add TELEGRAM_CHAT_ID to .env, then restart.");
  try {
    while (!controller.signal.aborted) {
      try {
        const updates = await telegramRequest("getUpdates", {
          offset, timeout: 30, allowed_updates: ["message"],
        }, AbortSignal.any([controller.signal, AbortSignal.timeout(40_000)]));
        for (const update of updates) {
          if (controller.signal.aborted) break;
          if (update.message) await handleMessage(update.message, services);
          // Acknowledge only after handling: failures are retried using cached words.
          offset = update.update_id + 1;
          await writeFile(OFFSET_FILE, String(offset), "utf8");
        }
      } catch (error) {
        if (controller.signal.aborted) break;
        console.error(`Telegram processing failed: ${error instanceof Error ? error.message : String(error)}. Retrying in 5 seconds.`);
        await delay(5000, undefined, { signal: controller.signal }).catch(() => {});
      }
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
