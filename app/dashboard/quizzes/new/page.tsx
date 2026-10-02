'use client';

import { useState } from 'react';
import { Upload, Sparkles, FileText, BookOpen } from 'lucide-react';
import { toast } from 'sonner';
import { Editor } from '@/components/editor';
import type { QuizData } from '@/lib/types';

export default function NewQuiz() {
  const [mode, setMode] = useState<'import' | 'generate'>('import');
  const [file, setFile] = useState<File | null>(null);
  const [referenceFile, setReferenceFile] = useState<File | null>(null);
  const [autoAnswers, setAutoAnswers] = useState(true);
  const [count, setCount] = useState(20);
  const [language, setLanguage] = useState('Русский');
  const [difficulty, setDifficulty] = useState('Сбалансированная');
  const [busy, setBusy] = useState(false);
  const [quiz, setQuiz] = useState<QuizData | null>(null);

  async function process() {
    if (!file) return toast.error('Выберите документ');
    setBusy(true);
    try {
      const form = new FormData();
      form.set('file', file);
      form.set('mode', mode);
      form.set('count', String(count));
      form.set('language', language);
      form.set('difficulty', difficulty);
      if (mode === 'import') {
        form.set('autoAnswers', String(autoAnswers));
        if (autoAnswers && referenceFile) form.set('referenceFile', referenceFile);
      }
      const response = await fetch('/api/admin/process', { method: 'POST', body: form });
      const json = await response.json();
      if (!response.ok) throw Error(json.error || 'Ошибка обработки');
      setQuiz({
        title: json.title,
        instructions: 'В каждом вопросе выберите один правильный ответ.',
        revealAnswers: false,
        questions: json.questions,
      });
      if (mode === 'import' && autoAnswers) {
        toast.success(`Импортировано: ${json.questions.length}. Определено AI: ${json.proposedAnswers}. Требуют выбора: ${json.unresolvedAnswers}.`);
      } else {
        toast.success(`Подготовлено вопросов: ${json.questions.length}`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка обработки');
    } finally {
      setBusy(false);
    }
  }

  if (quiz) return <>
    <div className="mb-6">
      <h1 className="page-title">Редактор теста</h1>
      <p className="muted mt-2">Правильные ответы, определённые AI, уже выбраны. Просмотрите их перед публикацией; вручную выбрать ответ нужно только для неразрешённых вопросов.</p>
    </div>
    <Editor initial={quiz} />
    <button className="text-primary mt-4" onClick={() => setQuiz(null)}>← Вернуться к загрузке</button>
  </>;

  return <>
    <h1 className="page-title">Создать новый тест</h1>
    <p className="muted mt-2 mb-7">Импортируйте готовые вопросы или создайте тест из учебного материала с помощью AI.</p>
    <div className="grid md:grid-cols-2 gap-4 mb-6">
      {([
        ['import', 'Импортировать готовый тест', 'Загрузите обычный тест: QuizFlow найдёт вопросы и предложит недостающие правильные ответы.', Upload],
        ['generate', 'Создать тест с AI', 'Загрузите учебный материал — AI подготовит новые вопросы.', Sparkles],
      ] as const).map(([value, title, description, Icon]) =>
        <button key={value} disabled={busy} className={`card text-left flex gap-4 ${mode === value ? '!border-primary !bg-[#EEEDFF]' : ''}`} onClick={() => setMode(value)}>
          <Icon size={25} className="text-primary shrink-0" />
          <span><strong className="block mb-2">{title}</strong><span className="muted text-sm">{description}</span></span>
        </button>
      )}
    </div>
    <section className="card space-y-5">
      <label className="block border-2 border-dashed border-[#d9d8e7] rounded-xl p-10 text-center cursor-pointer hover:bg-[#f8f7ff]">
        <FileText className="text-primary mx-auto mb-3" size={30} />
        <span className="block font-semibold">{file ? file.name : 'Выберите DOCX или PDF с устройства'}</span>
        <span className="block muted text-sm mt-2">DOCX, PDF · Максимум 10 МБ</span>
        <input type="file" accept=".docx,.pdf" className="hidden" disabled={busy} onChange={e => setFile(e.target.files?.[0] || null)} />
      </label>
      {mode === 'import' && <div className="space-y-4 rounded-xl border border-[#e5e7eb] p-4">
        <label className="flex items-start gap-3 cursor-pointer">
          <input className="mt-1" type="checkbox" checked={autoAnswers} disabled={busy} onChange={e => setAutoAnswers(e.target.checked)} />
          <span><strong className="block text-sm">Автоматически определить отсутствующие ответы с AI</strong>
            <span className="muted text-sm">Уже указанные в документе ответы сохраняются. AI автоматически выбирает вариант, когда может его определить; неоднозначные вопросы остаются без ответа.</span>
          </span>
        </label>
        {autoAnswers && <label className="block rounded-lg border border-dashed border-[#d9d8e7] p-4 cursor-pointer hover:bg-[#f8f7ff]">
          <span className="flex items-center gap-2 font-medium text-sm"><BookOpen size={18} className="text-primary" /> Учебный материал для проверки (необязательно)</span>
          <span className="block muted text-sm mt-2">{referenceFile ? referenceFile.name : 'Прикрепить отдельный DOCX или текстовый PDF до 10 МБ'}</span>
          <input className="hidden" type="file" accept=".docx,.pdf" disabled={busy} onChange={e => setReferenceFile(e.target.files?.[0] || null)} />
        </label>}
        {referenceFile && autoAnswers && <button type="button" disabled={busy} className="muted text-sm underline" onClick={() => setReferenceFile(null)}>Убрать учебный материал</button>}
      </div>}
      {mode === 'generate' && <div className="grid sm:grid-cols-3 gap-4">
        <label><span className="label">Количество вопросов</span><input className="field" type="number" min={1} max={100} value={count} onChange={e => setCount(Number(e.target.value))} /></label>
        <label><span className="label">Язык</span><select className="field" value={language} onChange={e => setLanguage(e.target.value)}><option>Русский</option><option>Азербайджанский</option><option>Английский</option></select></label>
        <label><span className="label">Сложность</span><select className="field" value={difficulty} onChange={e => setDifficulty(e.target.value)}><option>Сбалансированная</option><option>Лёгкая</option><option>Средняя</option><option>Сложная</option></select></label>
      </div>}
      <button disabled={busy || !file} className="btn btn-primary w-full" onClick={process}>
        <Sparkles size={17} />{busy ? mode === 'import' ? 'Импортируем и проверяем ответы...' : 'Формируем вопросы...' : mode === 'import' ? 'Импортировать вопросы' : 'Сгенерировать тест'}
      </button>
      <p className="text-xs muted text-center">AI может допускать ошибки. Перед публикацией проверьте правильность ответов.</p>
    </section>
  </>;
}
