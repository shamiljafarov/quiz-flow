export default function QuizzesLoading() {
  return <div role="status" aria-label="Загружаем тесты" className="animate-pulse space-y-6">
    <div className="h-8 w-44 rounded bg-gray-200"/>
    <div className="rounded-2xl border border-gray-100 bg-white p-6 space-y-5">
      {Array.from({length: 5}, (_, i) => <div key={i} className="h-12 rounded bg-gray-100"/>)}
    </div>
    <span className="sr-only">Загрузка тестов...</span>
  </div>;
}
