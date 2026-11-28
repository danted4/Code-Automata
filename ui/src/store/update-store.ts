/**
 * The app's latest update event (desktop app only), from the channel `UpdateProgress` registers:
 * the progress panel and Settings' update section both read it.
 */

import { create } from 'zustand';
import type { UpdateEvent } from '@/lib/native';

interface UpdateState {
  event: UpdateEvent | null;
  set: (event: UpdateEvent) => void;
}

export const useUpdateStore = create<UpdateState>((set) => ({
  event: null,
  set: (event) => set({ event }),
}));
