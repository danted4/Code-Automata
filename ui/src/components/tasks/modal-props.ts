/** Props every task modal takes. The modal reads the task from the store (`useTask`), so it stays
 * current while open, and closes itself if the task is deleted. */
export type TaskModalProps = {
  taskId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};
