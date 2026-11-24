/**
 * The one task dialog that is open, if any (see store/task-view-store.ts). Rendered once by the
 * board, so it survives the task moving between columns.
 */

import { DeleteTaskModal } from '@/components/tasks/delete-task-modal';
import { HumanReviewModal } from '@/components/tasks/human-review-modal';
import { PlanReviewModal } from '@/components/tasks/plan-review-modal';
import { QuestionsModal } from '@/components/tasks/questions-modal';
import { TaskDetailModal } from '@/components/tasks/task-detail-modal';
import { useTaskViewStore } from '@/store/task-view-store';

const DIALOGS = {
  details: TaskDetailModal,
  questions: QuestionsModal,
  plan: PlanReviewModal,
  review: HumanReviewModal,
  delete: DeleteTaskModal,
};

export function TaskDialogs() {
  const open = useTaskViewStore((s) => s.open);
  const close = useTaskViewStore((s) => s.close);
  if (!open) return null;
  const Dialog = DIALOGS[open.view];
  return (
    <Dialog
      key={`${open.taskId}-${open.view}`}
      taskId={open.taskId}
      open
      onOpenChange={(isOpen) => {
        if (!isOpen) close();
      }}
    />
  );
}
