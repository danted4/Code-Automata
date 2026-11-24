/**
 * Open Project Gate
 *
 * Shows Open Project modal on app load when no project is selected.
 * Once per session: if user cancels, we don't show again until next session.
 * User can still open project via sidebar button.
 */

import { useEffect, useState } from 'react';
import { useProjectStore } from '@/store/project-store';
import { OpenProjectModal } from './open-project-modal';

const SESSION_DISMISSED_KEY = 'code-automata-open-project-dismissed';

export function OpenProjectGate({ children }: { children: React.ReactNode }) {
  const projectPath = useProjectStore((s) => s.projectPath);
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (projectPath !== null) {
      setShowModal(false);
      return;
    }
    const dismissed = sessionStorage.getItem(SESSION_DISMISSED_KEY);
    if (dismissed === 'true') {
      setShowModal(false);
      return;
    }
    setShowModal(true);
  }, [projectPath]);

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      sessionStorage.setItem(SESSION_DISMISSED_KEY, 'true');
    }
    setShowModal(open);
  };

  return (
    <>
      {children}
      <OpenProjectModal open={showModal} onOpenChange={handleOpenChange} />
    </>
  );
}
