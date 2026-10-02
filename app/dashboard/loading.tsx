export default function DashboardLoading() {
  return (
    <div role="status" aria-label="Загружаем кабинет" className="animate-pulse space-y-8">
      <div className="space-y-3"><div className="h-8 w-48 rounded bg-gray-200"/><div className="h-4 w-80 max-w-full rounded bg-gray-100"/></div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {Array.from({length: 4}, (_, i) => <div key={i} className="h-36 rounded-2xl border border-gray-100 bg-white p-5"><div className="h-4 w-24 rounded bg-gray-100"/><div className="mt-9 h-8 w-14 rounded bg-gray-200"/></div>)}
      </div>
      <div className="h-72 rounded-2xl border border-gray-100 bg-white p-6 space-y-5">
        {Array.from({length: 4}, (_, i) => <div key={i} className="h-9 rounded bg-gray-100"/>)}
      </div>
      <span className="sr-only">Загрузка...</span>
    </div>
  );
}
