import { KanbanBoard } from '@/components/kanban/board';

export default function Home() {
  return (
    <div className="h-screen flex flex-col" style={{ background: 'var(--color-background)' }}>
      <KanbanBoard />
    </div>
  );
}
