import { KanbanBoard } from '@/components/kanban/board';

export default function Home() {
  return (
    <main className="min-h-screen">
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <h1 className="text-2xl font-bold text-gray-900">Code-Auto</h1>
        <p className="text-sm text-gray-600">Autonomous AI agents for developers</p>
      </div>
      <KanbanBoard />
    </main>
  );
}
