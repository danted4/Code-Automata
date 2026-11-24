/**
 * Which task dialog is open. Kept outside the cards: a card is recreated when its task changes
 * column, and a dialog held in the card's state would close mid-run.
 */

import { create } from 'zustand';

export type TaskView = 'details' | 'questions' | 'plan' | 'review' | 'delete';

interface TaskViewState {
  open: { taskId: string; view: TaskView } | null;
  show: (taskId: string, view: TaskView) => void;
  close: () => void;
}

export const useTaskViewStore = create<TaskViewState>((set) => ({
  open: null,
  show: (taskId, view) => set({ open: { taskId, view } }),
  close: () => set({ open: null }),
}));
