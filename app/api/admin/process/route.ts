import { NextRequest, NextResponse } from 'next/server';
import { requireTeacher } from '@/lib/supabase';
import { readDocument, parseExistingQuestions } from '@/lib/parser';
import { runAI } from '@/lib/ai';
import { suggestMissingAnswers } from '@/lib/answer-assist';
import { fail } from '@/lib/http';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    await requireTeacher();
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) throw new Error('Выберите документ');
    const mode = form.get('mode') === 'generate' ? 'generate' : 'import';
    const text = await readDocument(file);

    if (mode === 'import') {
      const local = parseExistingQuestions(text);
      const imported = local.length
        ? { title: file.name.replace(/\.[^.]+$/, ''), questions: local }
        : await runAI(text, 'import');

      const automatic = form.get('autoAnswers') !== 'false';
      const referenceFile = form.get('referenceFile');
      let referenceText: string | undefined;
      if (automatic && referenceFile instanceof File && referenceFile.size > 0) {
        referenceText = await readDocument(referenceFile);
      }
      const questions = automatic
        ? await suggestMissingAnswers(imported.questions, referenceText)
        : imported.questions;
      return NextResponse.json({
        ...imported,
        questions,
        proposedAnswers: questions.filter((q, index) => !imported.questions[index]?.correctOptionId && !!q.correctOptionId).length,
        unresolvedAnswers: questions.filter(q => !q.correctOptionId || q.needsReview).length,
      });
    }

    const count = Math.min(100, Math.max(1, Number(form.get('count')) || 20));
    const result = await runAI(
      text, 'generate', count,
      String(form.get('language') || 'Русский'),
      String(form.get('difficulty') || 'Сбалансированная')
    );
    return NextResponse.json(result);
  } catch (error) {
    return fail(error);
  }
}
