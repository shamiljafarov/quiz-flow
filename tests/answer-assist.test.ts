import { describe, expect, it } from 'vitest';
import { applyAnswerSuggestions } from '../lib/answer-assist';
import type { Question } from '../lib/types';
import { validatePublish } from '../lib/types';
const question = (correctOptionId: string | null = null): Question => ({
  id: 'q1', text: 'Вопрос?',
  options: ['A','B','C','D'].map(id => ({ id, text: `Ответ ${id}` })),
  correctOptionId, points: 1, source: 'Вопрос 1', needsReview: !correctOptionId,
});
describe('AI answer suggestion safety', () => {
  it('automatically accepts a suggested answer without modifying the original question or its options', () => {
    const original = question();
    const [updated] = applyAnswerSuggestions([original], [{index:0,answer:'C',explanation:'Из материала'}]);
    expect(updated.correctOptionId).toBe('C');
    expect(updated.needsReview).toBe(false);
    expect(updated.options).toEqual(original.options);
    expect(updated.text).toBe(original.text);
    expect(original.correctOptionId).toBe(null);
  });
  it('never overrides a correct answer explicitly provided in the original document', () => {
    const original = question('B');
    const [updated] = applyAnswerSuggestions([original], [{index:0,answer:'D',explanation:'Ошибка AI'}]);
    expect(updated).toBe(original);
    expect(updated.correctOptionId).toBe('B');
  });
  it('keeps uncertain or invalid suggestions unresolved', () => {
    const unresolved = applyAnswerSuggestions([question()], [{index:0,answer:null,explanation:'Неясно'}])[0];
    expect(unresolved.correctOptionId).toBe(null);
    expect(unresolved.needsReview).toBe(true);
    expect(applyAnswerSuggestions([question()], [{index:3,answer:'A',explanation:'Другой вопрос'}])[0].correctOptionId).toBe(null);
  });
  it('allows publication without a separate confirmation for AI-selected answers', () => {
    const [accepted] = applyAnswerSuggestions([question()], [{index:0,answer:'D',explanation:'Обоснованный ответ'}]);
    expect(validatePublish({title:'Тест',instructions:'',revealAnswers:false,questions:[accepted]})).toEqual([]);
  });
  it('blocks publication if an answer is still unresolved', () => {
    const [pending] = applyAnswerSuggestions([question()], [{index:0,answer:null,explanation:'Неоднозначно'}]);
    expect(validatePublish({title:'Тест',instructions:'',revealAnswers:false,questions:[pending]})).toHaveLength(1);
  });
});
