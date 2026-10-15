import test from "node:test";
import assert from "node:assert/strict";
import { handleMessage, splitText, formatList, linkedList } from "./telegram.js";
import { lookupWord, loadVocabulary, validateEntry, fetchWordDetails } from "./index.js";
import { formatWord } from "./telegram.js";

test("pronunciations are required from AI and supported in legacy storage", async () => {
  const legacy = { word: "test", pos: "noun", englishDefinition: "An examination.",
    persianMeaning: "آزمون", root: "Latin", wordFamily: ["testing"],
    examples: ["Take a test.", "The test is easy."] };
  assert.equal(validateEntry(legacy).word, "test");
  assert.match(formatWord(legacy), /\/refresh test/);
  const detailed = { ...legacy, pronunciation: { us: "/test/", uk: "/test/" } };
  const client = { chat: { completions: { create: async (request) => {
    assert.ok(request.response_format.json_schema.schema.required.includes("pronunciation"));
    return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(detailed) } }] };
  } } } };
  const entry = await fetchWordDetails(client, "test");
  assert.deepEqual(entry.pronunciation, detailed.pronunciation);
  assert.match(formatWord(entry), /US  \/test\//);
  assert.throws(() => validateEntry({ ...legacy, pronunciation: { us: "", uk: "/test/" } }));
});

test("splits long messages without breaking Unicode characters", () => {
  const text = "hello 😀 فارسی\n".repeat(900);
  const chunks = splitText(text);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.every((chunk) => chunk.length <= 3500));
  assert.ok(chunks.every((chunk) => !/[\uD800-\uDBFF]$/.test(chunk)));
});

test("unauthorized chats and groups cannot look up words or read the list", async () => {
  const previous = process.env.TELEGRAM_CHAT_ID;
  process.env.TELEGRAM_CHAT_ID = "123";
  const services = {
    lookupWord: () => assert.fail("Unauthorized lookup"),
    loadVocabulary: () => assert.fail("Unauthorized read"),
  };
  try {
    await handleMessage({ chat: { id: 999, type: "private" }, text: "/list" }, services);
    await handleMessage({ chat: { id: 999, type: "private" }, text: "hello" }, services);
    await handleMessage({ chat: { id: 123, type: "group" }, text: "hello" }, services);
  } finally {
    if (previous === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = previous;
  }
});

test("authorized word lookup sends details and updated list", async () => {
  const originalFetch = globalThis.fetch;
  const previousId = process.env.TELEGRAM_CHAT_ID;
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_CHAT_ID = "123";
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  const sent = [];
  globalThis.fetch = async (url, options) => {
    if (url.endsWith("/getMe")) return { ok: true, json: async () => ({ ok: true, result: { username: "test_bot" } }) };
    assert.ok(url.endsWith("/sendMessage"));
    sent.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ ok: true, result: {} }) };
  };
  const entry = {
    word: "test", pos: "noun", englishDefinition: "An examination.",
    persianMeaning: "آزمون", root: "Latin", wordFamily: ["testing"],
    examples: ["Take a test.", "The test is easy."],
  };
  try {
    await handleMessage({ chat: { id: 123, type: "private" }, text: "/word test" }, {
      lookupWord: async (word) => {
        assert.equal(word, "test");
        return { entry, cached: false };
      },
      loadVocabulary: async () => [entry],
    });
    assert.equal(sent.length, 2);
    assert.ok(sent.every((body) => body.chat_id === "123"));
    assert.match(sent[0].text, /An examination/);
    assert.equal(sent[1].text, formatList([entry]));
    const entity = sent[1].entities[0];
    assert.equal(sent[1].text.slice(entity.offset, entity.offset + entity.length), "test");
    assert.equal(entity.url, "https://t.me/test_bot?start=vocab_0");
    sent.length = 0;
    await handleMessage({ chat: { id: 123, type: "private" }, text: "/start vocab_0" }, {
      lookupWord: () => assert.fail("Clicking a link must not call AvalAI"),
      loadVocabulary: async () => [entry],
    });
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /An examination/);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of [["TELEGRAM_CHAT_ID", previousId], ["TELEGRAM_BOT_TOKEN", previousToken]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("link offsets handle Unicode meanings and punctuation", () => {
  const entries = [
    { word: "vacancy", persianMeaning: "خالی 😀" },
    { word: "don't", persianMeaning: "<>&" },
  ];
  const { text, entities } = linkedList(entries, "test_bot");
  entities.filter((entity) => entity.type === "text_link").forEach((entity, index) => {
    assert.equal(text.slice(entity.offset, entity.offset + entity.length), entries[index].word);
    assert.equal(entity.url, `https://t.me/test_bot?start=vocab_${index}`);
  });
});

test("existing words are returned without a network request", async () => {
  const vocabulary = await loadVocabulary();
  if (!vocabulary.length) return;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail("Duplicate caused a network request");
  try {
    const result = await lookupWord(` ${vocabulary[0].word.toUpperCase()} `);
    assert.equal(result.cached, true);
    assert.deepEqual(result.entry, vocabulary[0]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
