/**
 * Settings Page
 *
 * Tabs: Custom Prompts (MVP), future tabs for General, etc.
 */

import { useState, useEffect } from 'react';
import { useProjectStore } from '@/store/project-store';
import { apiFetch } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import {
  PLAN_GENERATION_DEFAULT_TEMPLATE,
  SUBTASK_GENERATION_DEFAULT_TEMPLATE,
} from '@/lib/prompts/defaults';

type TabId = 'custom-prompts';

interface PromptsResponse {
  planGeneration: { custom: boolean; template: string };
  subtaskGeneration: { custom: boolean; template: string };
}

const PLACEHOLDERS_PLAN = [
  '{{task.title}}',
  '{{task.description}}',
  '{{task.cliTool}}',
  '{{task.cliConfig}}',
  '{{user_answers}}',
];

const PLACEHOLDERS_SUBTASK = ['{{task.title}}', '{{task.description}}', '{{planContent}}'];

export default function SettingsPage() {
  const projectPath = useProjectStore((s) => s.projectPath);
  const [activeTab, setActiveTab] = useState<TabId>('custom-prompts');
  const [planTemplate, setPlanTemplate] = useState('');
  const [subtaskTemplate, setSubtaskTemplate] = useState('');
  const [planCustom, setPlanCustom] = useState(false);
  const [subtaskCustom, setSubtaskCustom] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSavingPlan, setIsSavingPlan] = useState(false);
  const [isSavingSubtask, setIsSavingSubtask] = useState(false);

  useEffect(() => {
    if (!projectPath) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/prompts');
        if (!res.ok) throw new Error('Failed to load prompts');
        const data = (await res.json()) as PromptsResponse;
        if (!cancelled) {
          setPlanTemplate(data.planGeneration.template);
          setSubtaskTemplate(data.subtaskGeneration.template);
          setPlanCustom(data.planGeneration.custom);
          setSubtaskCustom(data.subtaskGeneration.custom);
        }
      } catch (err) {
        if (!cancelled) {
          toast.error(err instanceof Error ? err.message : 'Failed to load prompts');
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  const handleResetPlan = () => {
    setPlanTemplate(PLAN_GENERATION_DEFAULT_TEMPLATE);
    setPlanCustom(false);
    toast.success('Plan template reset to default');
  };

  const handleResetSubtask = () => {
    setSubtaskTemplate(SUBTASK_GENERATION_DEFAULT_TEMPLATE);
    setSubtaskCustom(false);
    toast.success('Subtask template reset to default');
  };

  const handleSavePlan = async () => {
    if (!projectPath) return;
    setIsSavingPlan(true);
    try {
      const res = await apiFetch('/api/prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          planGeneration: { template: planTemplate },
        }),
      });
      if (!res.ok) throw new Error('Failed to save');
      setPlanCustom(planTemplate.trim().length > 0);
      toast.success('Plan template saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setIsSavingPlan(false);
    }
  };

  const handleSaveSubtask = async () => {
    if (!projectPath) return;
    setIsSavingSubtask(true);
    try {
      const res = await apiFetch('/api/prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subtaskGeneration: { template: subtaskTemplate },
        }),
      });
      if (!res.ok) throw new Error('Failed to save');
      setSubtaskCustom(subtaskTemplate.trim().length > 0);
      toast.success('Subtask template saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setIsSavingSubtask(false);
    }
  };

  if (!projectPath) {
    return (
      <div
        className="flex flex-col items-center justify-center min-h-[60vh] gap-3"
        style={{ color: 'var(--color-text-muted)' }}
      >
        <h2 className="text-xl font-semibold" style={{ color: 'var(--color-text-primary)' }}>
          Open a project
        </h2>
        <p className="text-sm">Open a project to customize prompts.</p>
      </div>
    );
  }

  return (
    <div
      className="h-screen flex flex-col overflow-hidden"
      style={{ background: 'var(--color-background)' }}
    >
      <div className="p-6 border-b" style={{ borderColor: 'var(--color-border)' }}>
        <h1 className="text-xl font-bold" style={{ color: 'var(--color-text-primary)' }}>
          Settings
        </h1>
        <div className="flex gap-2 mt-3">
          <button
            type="button"
            onClick={() => setActiveTab('custom-prompts')}
            className="px-3 py-1.5 rounded-md text-sm font-medium transition-colors"
            style={{
              background:
                activeTab === 'custom-prompts' ? 'var(--color-background)' : 'transparent',
              color:
                activeTab === 'custom-prompts'
                  ? 'var(--color-text-primary)'
                  : 'var(--color-text-muted)',
              border:
                activeTab === 'custom-prompts'
                  ? '1px solid var(--color-border)'
                  : '1px solid transparent',
            }}
          >
            Custom Prompts
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {activeTab === 'custom-prompts' && (
          <div className="max-w-3xl space-y-8">
            {isLoading ? (
              <p style={{ color: 'var(--color-text-muted)' }}>Loading prompts...</p>
            ) : (
              <>
                <section>
                  <h2
                    className="text-lg font-semibold mb-2"
                    style={{ color: 'var(--color-text-primary)' }}
                  >
                    Plan Generation
                  </h2>
                  <p className="text-sm mb-3" style={{ color: 'var(--color-text-muted)' }}>
                    Customize the instruction portion of the plan generation prompt. The system will
                    append JSON format requirements.
                  </p>
                  <p className="text-xs mb-2" style={{ color: 'var(--color-text-muted)' }}>
                    Placeholders: {PLACEHOLDERS_PLAN.join(', ')}
                  </p>
                  <Textarea
                    value={planTemplate}
                    onChange={(e) => setPlanTemplate(e.target.value)}
                    rows={14}
                    className="font-mono text-sm"
                  />
                  <div className="flex gap-2 mt-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleResetPlan}
                      style={{
                        borderColor: 'var(--color-border)',
                        background: 'var(--color-surface)',
                        color: 'var(--color-text-primary)',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'var(--color-surface-hover)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'var(--color-surface)';
                      }}
                    >
                      Reset to Default
                    </Button>
                    <Button
                      size="sm"
                      onClick={handleSavePlan}
                      disabled={isSavingPlan}
                      style={{
                        background: 'var(--color-primary)',
                        color: 'var(--color-primary-text)',
                      }}
                      onMouseEnter={(e) => {
                        if (!isSavingPlan)
                          e.currentTarget.style.background = 'var(--color-primary-hover)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'var(--color-primary)';
                      }}
                    >
                      {isSavingPlan ? 'Saving...' : 'Save'}
                    </Button>
                    {planCustom && (
                      <span
                        className="text-xs self-center"
                        style={{ color: 'var(--color-text-muted)' }}
                      >
                        Using custom template
                      </span>
                    )}
                  </div>
                </section>

                <section>
                  <h2
                    className="text-lg font-semibold mb-2"
                    style={{ color: 'var(--color-text-primary)' }}
                  >
                    Subtask Generation
                  </h2>
                  <p className="text-sm mb-3" style={{ color: 'var(--color-text-muted)' }}>
                    Customize the instruction portion of the subtask generation prompt. The system
                    will append JSON format requirements.
                  </p>
                  <p className="text-xs mb-2" style={{ color: 'var(--color-text-muted)' }}>
                    Placeholders: {PLACEHOLDERS_SUBTASK.join(', ')}
                  </p>
                  <Textarea
                    value={subtaskTemplate}
                    onChange={(e) => setSubtaskTemplate(e.target.value)}
                    rows={14}
                    className="font-mono text-sm"
                  />
                  <div className="flex gap-2 mt-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleResetSubtask}
                      style={{
                        borderColor: 'var(--color-border)',
                        background: 'var(--color-surface)',
                        color: 'var(--color-text-primary)',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'var(--color-surface-hover)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'var(--color-surface)';
                      }}
                    >
                      Reset to Default
                    </Button>
                    <Button
                      size="sm"
                      onClick={handleSaveSubtask}
                      disabled={isSavingSubtask}
                      style={{
                        background: 'var(--color-primary)',
                        color: 'var(--color-primary-text)',
                      }}
                      onMouseEnter={(e) => {
                        if (!isSavingSubtask)
                          e.currentTarget.style.background = 'var(--color-primary-hover)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'var(--color-primary)';
                      }}
                    >
                      {isSavingSubtask ? 'Saving...' : 'Save'}
                    </Button>
                    {subtaskCustom && (
                      <span
                        className="text-xs self-center"
                        style={{ color: 'var(--color-text-muted)' }}
                      >
                        Using custom template
                      </span>
                    )}
                  </div>
                </section>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
