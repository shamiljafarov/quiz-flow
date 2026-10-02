import OpenAI from 'openai';
import { randomInt, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Question } from './types';
import { estimateTokens, waitForGroqBudget, groqRetryDelay, groqPublicError, sleep } from './groq-limits';

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_MODEL = 'openai/gpt-oss-20b';
const BATCH_SIZE = 5;
const MAX_BATCH_ATTEMPTS = 3;
const MAX_QUESTIONS = 100;
const ANSWER_IDS = ['A', 'B', 'C', 'D'];

const questionSchema = z.object({
  text: z.string().min(1),
  options: z.array(z.string().min(1)).length(4),
  correctIndex: z.number().int().min(-1).max(3),
  source: z.string(),
});

const output = z.object({
  title: z.string(),
  questions: z.array(questionSchema),
});

type AIQuestion = z.infer<typeof questionSchema>;
type AIOutput = z.infer<typeof output>;

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasUniqueOptions(question: AIQuestion): boolean {
  const options = question.options.map(normalizeText);
  return options.every(Boolean) && new Set(options).size === 4;
}


/** Unbiased Fisher–Yates shuffle, using Node's cryptographic randomInt. */
function shuffle<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Allocate correct-answer positions as evenly as possible.
 * For 20 questions there are five A, five B, five C and five D;
 * for other sizes counts differ by at most one. Order is shuffled.
 */
function generateAnswerPositions(count: number): number[] {
  const positions = Array.from({ length: count }, (_, i) => i % 4);
  return shuffle(positions);
}

/**
 * Reorder choices without ever changing which choice is actually correct.
 * Import mode calls this without a target and keeps the document's order.
 */
function convertQuestion(
  question: AIQuestion,
  targetCorrectIndex?: number
): Question {
  const knownAnswer = question.correctIndex >= 0;
  const shouldShuffle = knownAnswer && targetCorrectIndex !== undefined;
  const destination = shouldShuffle ? targetCorrectIndex : question.correctIndex;

  let options = [...question.options];
  if (shouldShuffle) {
    const correctAnswer = options[question.correctIndex];
    const incorrectAnswers = shuffle(
      options.filter((_, index) => index !== question.correctIndex)
    );
    incorrectAnswers.splice(destination, 0, correctAnswer);
    options = incorrectAnswers;
  }

  return {
    id: randomUUID(),
    text: question.text.trim(),
    options: options.map((option, index) => ({
      id: ANSWER_IDS[index],
      text: option.trim(),
    })),
    correctOptionId: knownAnswer ? ANSWER_IDS[destination] : null,
    points: 1,
    source: question.source || '',
    needsReview: !knownAnswer,
  };
}

function createGroqClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('API-ключ Groq не настроен');
  return new OpenAI({
    apiKey,
    baseURL: GROQ_BASE_URL,
    timeout: 55000,
    maxRetries: 0,
  });
}

const JSON_INSTRUCTIONS = `
You are an educational quiz processing engine.
Return ONLY a valid JSON object, without Markdown, comments or explanations.
Required structure:
{
  "title": "Название теста",
  "questions": [
    {
      "text": "Текст вопроса",
      "options": ["Вариант A", "Вариант B", "Вариант C", "Вариант D"],
      "correctIndex": 0,
      "source": "Фрагмент документа"
    }
  ]
}
Every question must have exactly four options. correctIndex must be an integer
from -1 to 3; source must always be a string. Do not add additional properties.
Use the language requested by the user. Do not invent facts outside the document.
`;

const IMPORT_INSTRUCTIONS = `
Ты профессиональный обработчик образовательных тестов.
Извлекай только существующие вопросы и их четыре варианта без изменения смысла.
Ищи явные правильные ответы, в том числе в ключе в конце документа.
Если правильный ответ не указан или неоднозначен, установи correctIndex=-1.
Не угадывай ответы и не придумывай новые вопросы.
Возвращай все обнаруженные подходящие вопросы.
В source указывай номер вопроса или его фрагмент.
Индексы вариантов — от 0 до 3. Ответ — только заданный JSON.
`;

const GENERATE_INSTRUCTIONS = `
Ты профессиональный преподаватель и методист.
Создавай тест исключительно по предоставленному материалу, без внешних фактов.
Создай запрошенное количество вопросов, если материал позволяет.
У каждого вопроса должно быть четыре варианта и ровно один верный ответ.
correctIndex — индекс верного варианта 0..3.
Неверные варианты должны быть правдоподобными и отличаться друг от друга.
Избегай неоднозначности, повторений и вопросов с одинаковым смыслом.
source — короткая точная цитата из исходного материала.
Соблюдай указанные язык и сложность; не повторяй вопросы из списка исключений.
Если материала недостаточно, верни меньше вопросов, не выдумывая содержание.
Ответ должен соответствовать заданной JSON-структуре.
`;

/** Use a bounded source excerpt per package to prevent resending an entire long PDF.
 * Across N generation rounds, samples are spread from beginning to end of document.
 * Each excerpt remains verbatim so source quotations can be checked by the teacher.
 */
function selectDocumentExcerpt(text: string, round: number, expectedRounds: number): string {
  const maxChars = 7000;
  if (text.length <= maxChars) return text;
  const chunks = Math.ceil(text.length / maxChars);
  const index = expectedRounds <= 1
    ? Math.floor((chunks - 1) / 2)
    : Math.round(((round - 1) % expectedRounds) * (chunks - 1) / (expectedRounds - 1));
  const start = Math.floor(index * text.length / chunks);
  const end = Math.min(text.length, Math.floor((index + 1) * text.length / chunks));
  return text.slice(start, end);
}

async function requestAI(
  client: OpenAI,
  documentText: string,
  mode: 'generate' | 'import',
  count: number,
  language: string,
  difficulty: string,
  previousQuestions: string[] = []
): Promise<AIOutput> {
  const exclusions = previousQuestions.length
    ? `УЖЕ СОЗДАННЫЕ ВОПРОСЫ (не повторять по смыслу):\n${previousQuestions
        .map((q, i) => `${i + 1}. ${q}`)
        .join('\n')}\nСоздавай новые вопросы на другие факты и темы.`
    : '';

  const userContent = `РЕЖИМ: ${mode}\nКОЛИЧЕСТВО ВОПРОСОВ: ${count}\nЯЗЫК: ${language}\nСЛОЖНОСТЬ: ${difficulty}\n\n${exclusions}\n\nИСХОДНЫЙ ДОКУМЕНТ:\n${documentText}`;
  await waitForGroqBudget(estimateTokens(
    JSON_INSTRUCTIONS + (mode === 'import' ? IMPORT_INSTRUCTIONS : GENERATE_INSTRUCTIONS) + userContent,
    mode === 'import' ? 1900 : 1700
  ));
  const response = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || DEFAULT_MODEL,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    max_completion_tokens: mode === 'import' ? 3900 : 3200,
    messages: [
      { role: 'system', content: JSON_INSTRUCTIONS },
      {
        role: 'system',
        content: mode === 'import' ? IMPORT_INSTRUCTIONS : GENERATE_INSTRUCTIONS,
      },
      {
        role: 'user',
        content: userContent,
      },
    ],
  });

  const choice = response.choices[0];
  if (!choice) throw new Error('Groq не вернул результат');
  if (choice.finish_reason === 'length') {
    throw new Error('AI достиг лимита генерации ответа');
  }
  const raw = choice.message.content;
  if (!raw) throw new Error('AI вернул пустой ответ');

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error('AI вернул некорректный JSON');
  }
  const validation = output.safeParse(json);
  if (!validation.success) {
    console.error('AI validation error:', validation.error.flatten());
    throw new Error('AI вернул некорректную структуру вопросов');
  }
  return validation.data;
}

async function requestWithRetry(
  client: OpenAI,
  documentText: string,
  mode: 'generate' | 'import',
  count: number,
  language: string,
  difficulty: string,
  previousQuestions: string[] = []
): Promise<AIOutput> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_BATCH_ATTEMPTS; attempt++) {
    try {
      return await requestAI(
        client, documentText, mode, count, language, difficulty, previousQuestions
      );
    } catch (error) {
      lastError = error;
      console.error(
        `Groq request failed (${attempt}/${MAX_BATCH_ATTEMPTS})`,
        error instanceof Error ? error.message : 'Unknown error'
      );
      if (error instanceof OpenAI.APIError) {
        if ([401, 403, 404].includes(error.status ?? 0)) throw error;
        if (error.status === 400 && !/failed to validate json/i.test(error.message)) {
          throw error;
        }
      }
      if (attempt < MAX_BATCH_ATTEMPTS) {
        const retryDelay = groqRetryDelay(error, attempt);
        await sleep(retryDelay ?? 1000 * attempt);
      }
    }
  }
  throw new Error(groqPublicError(lastError));
}

export async function runAI(
  text: string,
  mode: 'generate' | 'import',
  count = 20,
  language = 'Русский',
  difficulty = 'Сбалансированная'
) {
  if (!text.trim()) throw new Error('Документ не содержит текста для анализа');
  const client = createGroqClient();

  // Импорт сохраняет исходное расположение вариантов ответа.
  if (mode === 'import') {
    const imported = await requestWithRetry(
      client, text, 'import', count, language, difficulty
    );
    const questions: Question[] = imported.questions
      .slice(0, MAX_QUESTIONS)
      .filter((q) => q.text.trim() && q.options.every((option) => option.trim()))
      .map((q) => convertQuestion(q));
    if (!questions.length) throw new Error('В документе не найдено подходящих вопросов');
    return {
      title: imported.title.trim() || 'Импортированный тест',
      questions,
    };
  }

  if (!Number.isInteger(count) || count < 1 || count > MAX_QUESTIONS) {
    throw new Error(`Количество вопросов должно быть от 1 до ${MAX_QUESTIONS}`);
  }

  const collectedQuestions: AIQuestion[] = [];
  const usedQuestions = new Set<string>();
  let quizTitle = '';
  const totalBatches = Math.ceil(count / BATCH_SIZE);
  const maxBatchRounds = totalBatches * 3;
  let round = 0;

  // Генерация по пять вопросов сохраняется без изменений логики.
  while (collectedQuestions.length < count && round < maxBatchRounds) {
    round++;
    const remaining = count - collectedQuestions.length;
    const currentBatchSize = Math.min(BATCH_SIZE, remaining);
    console.info(
      `QuizFlow: generation round ${round}/${maxBatchRounds}, collected ${collectedQuestions.length}/${count}`
    );
    const previousQuestions = collectedQuestions.map((question) => question.text);
    const documentExcerpt = selectDocumentExcerpt(text, round, totalBatches);
    const batch = await requestWithRetry(
      client, documentExcerpt, 'generate', currentBatchSize, language, difficulty, previousQuestions
    );
    if (!quizTitle && batch.title.trim()) quizTitle = batch.title.trim();

    for (const question of batch.questions) {
      if (collectedQuestions.length >= count) break;
      const normalized = normalizeText(question.text);
      if (!normalized || usedQuestions.has(normalized)) continue;
      if (!hasUniqueOptions(question) || question.correctIndex < 0) continue;
      usedQuestions.add(normalized);
      collectedQuestions.push(question);
    }
    console.info(`QuizFlow: ${collectedQuestions.length}/${count} questions ready`);
  }

  if (!collectedQuestions.length) {
    throw new Error('Не удалось создать вопросы по документу');
  }
  if (collectedQuestions.length < count) {
    throw new Error(
      `Удалось подготовить только ${collectedQuestions.length} уникальных вопросов из ${count}. ` +
      'Возможно, документ содержит недостаточно материала. Попробуйте уменьшить количество вопросов.'
    );
  }

  // РАВНОМЕРНАЯ РАНДОМИЗАЦИЯ: применяем только после объединения всех пакетов.
  // При 20 вопросах A/B/C/D встречаются по пять раз, но в случайном порядке.
  // Переставляем сами тексты вариантов и одновременно обновляем correctOptionId.
  const answerPositions = generateAnswerPositions(count);
  const questions: Question[] = collectedQuestions
    .slice(0, count)
    .map((question, index) => convertQuestion(question, answerPositions[index]));

  return {
    title: quizTitle || 'Новый тест',
    questions,
  };
}
