import OpenAI from 'openai';
import { z } from 'zod';
import type { Question } from './types';
import { estimateTokens, waitForGroqBudget, groqRetryDelay, sleep } from './groq-limits';

/** AI suggests answer IDs; the existing question text and option order are immutable. */
const suggestionSchema = z.object({
  answers: z.array(z.object({
    index: z.number().int().min(0).max(99),
    answer: z.enum(['A', 'B', 'C', 'D']).nullable(),
    explanation: z.string(),
  })),
});
export type AnswerSuggestion = z.infer<typeof suggestionSchema>['answers'][number];

/** Pure mapping: AI must not edit imported questions, choices or an explicit answer key. */
export function applyAnswerSuggestions(questions: Question[], suggestions: AnswerSuggestion[]): Question[] {
  const byIndex = new Map<number, AnswerSuggestion>();
  for (const suggestion of suggestions) {
    if (!byIndex.has(suggestion.index)) byIndex.set(suggestion.index, suggestion);
  }
  return questions.map((q, index) => {
    // An explicit answer in the source always takes precedence.
    if (q.correctOptionId) return q;
    const suggestion = byIndex.get(index);
    if (!suggestion?.answer || !q.options.some(o => o.id === suggestion.answer)) return q;
    return {
      ...q,
      correctOptionId: suggestion.answer,
      needsReview: false, // Automatically accept a specific AI suggestion; unresolved answers remain blocked
      source: `${q.source || `Вопрос ${index + 1}`} · AI предложил ${suggestion.answer}: ${suggestion.explanation.slice(0, 180)}`,
    };
  });
}

export async function suggestMissingAnswers(
  questions: Question[],
  referenceText?: string
): Promise<Question[]> {
  const pending = questions.map((q, index) => ({ q, index })).filter(({ q }) => !q.correctOptionId);
  if (!pending.length) return questions;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('Для автоматического определения ответов требуется API-ключ Groq');

  const client = new OpenAI({
    apiKey,
    baseURL: 'https://api.groq.com/openai/v1',
    timeout: 55000,
    maxRetries: 0,
  });
  let result = [...questions];
  // Small sequential batches avoid Groq's occasional JSON validation failures on large responses.
  for (let offset = 0; offset < pending.length; offset += 5) {
    const batch = pending.slice(offset, offset + 5);
    const payload = batch.map(({ q, index }) => ({
      index,
      question: q.text,
      options: q.options.map(o => ({ id: o.id, text: o.text })),
    }));
    const referenceExcerpt = referenceText && referenceText.length > 7000
      ? referenceText.slice(Math.floor((offset / Math.max(1, pending.length - 5)) * (referenceText.length - 7000)),
          Math.floor((offset / Math.max(1, pending.length - 5)) * (referenceText.length - 7000)) + 7000)
      : referenceText;
    const userContent = JSON.stringify({
      questions: payload,
      ...(referenceExcerpt ? { referenceMaterial: referenceExcerpt } : {}),
    });
    let suggestions: AnswerSuggestion[] | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await waitForGroqBudget(estimateTokens(userContent, 1300));
        const response = await client.chat.completions.create({
          model: process.env.OPENAI_MODEL || 'openai/gpt-oss-20b',
          temperature: 0.1,
          response_format: { type: 'json_object' },
          max_completion_tokens: 2200,
          messages: [
            {
              role: 'system',
              content: `Ты помощник преподавателя, проверяющий существующие тесты. Верни ТОЛЬКО JSON объект формата {"answers":[{"index":0,"answer":"A","explanation":"обоснование"}]}. Для каждого полученного индекса верни ровно один элемент. answer может быть A, B, C, D или null. Не меняй текст вопросов и вариантов. Если есть учебный материал, опирайся СТРОГО на него; когда материала недостаточно, ответь null. Если учебного материала нет, допускается ответ на основании общеизвестных предметных знаний, но при неопределённости, спорном вопросе или недостатке контекста отвечай null. Не угадывай. Explanation — кратко по-русски, укажи основание или сомнение. Если можно уверенно выбрать только один вариант, верни его. Если нет — null; не угадывай. Преподаватель сможет проверить ответы в редакторе.`,
            },
            {
              role: 'user',
              content: userContent,
            },
          ],
        });
        const choice = response.choices[0];
        if (!choice || choice.finish_reason === 'length' || !choice.message.content) throw new Error('Неполный ответ AI');
        const parsed = suggestionSchema.parse(JSON.parse(choice.message.content));
        const allowed = new Set(batch.map(item => item.index));
        suggestions = parsed.answers.filter(item => allowed.has(item.index));
        break;
      } catch (err) {
        if (err instanceof OpenAI.APIError && [401, 403, 404].includes(err.status)) throw err;
        if (err instanceof OpenAI.APIError && err.status === 400 && !/failed to validate json/i.test(err.message)) throw err;
        if (attempt === 3) {
          console.error('Groq answer suggestions unavailable for batch', offset / 5 + 1, err instanceof Error ? err.message : 'Unknown error');
          // Keep remaining questions unresolved rather than silently guessing answers.
        } else {
          await sleep(groqRetryDelay(err, attempt) ?? 1000 * attempt);
        }
      }
    }
    if (suggestions) result = applyAnswerSuggestions(result, suggestions);
  }
  return result;
}
