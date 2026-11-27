/**
 * Human Review Modal: what was built, the automated checks and the QA verdicts, then the human's
 * call: open a pull request, send the task back for rework, or mark it done. In the desktop app it
 * also opens the worktree in an editor or the file manager.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Code2,
  Copy,
  ExternalLink,
  Folder,
  GitBranch,
  GitPullRequest,
  Loader2,
  RotateCcw,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { api, errorMessage } from '@/lib/api';
import { native, type AvailableEditor, type EditorId, type NativeApi } from '@/lib/native';
import type { PrReport } from '@/lib/api/types/PrReport';
import type { RepoChanges } from '@/lib/api/types/RepoChanges';
import {
  isWorkspaceTask,
  prReportToast,
  pullRequestAction,
  pushedNow,
  repoPrButton,
  repoPrRowText,
  repoPrViews,
  reviewSummary,
  type RepoPrView,
  taskBranch,
  worktreePath,
} from '@/lib/review-summary';
import { PHASE_LABELS } from '@/lib/task-view';
import { useProjectStore } from '@/store/project-store';
import { act, useTask, useTaskStore } from '@/store/task-store';
import type { TaskModalProps } from './modal-props';

type Busy = 'pr' | 'rework' | 'done' | null;

const sectionTitle = 'font-medium text-sm flex items-center gap-2';
const itemBox = 'text-xs py-1.5 px-2 rounded';

export function HumanReviewModal({ taskId, open, onOpenChange }: TaskModalProps) {
  const task = useTask(taskId);
  const [busy, setBusy] = useState<Busy>(null);
  const [feedback, setFeedback] = useState('');
  /** What "Create pull requests" last did here: links before the reload, failures, no remote. */
  const [report, setReport] = useState<PrReport | null>(null);
  const summary = useMemo(() => (task ? reviewSummary(task) : null), [task]);
  /** A workspace task's changes per repository: which repositories have no remote. */
  const [changes, setChanges] = useState<RepoChanges[] | null>(null);
  const workspace = !!task && isWorkspaceTask(task);
  useEffect(() => {
    if (!open || !workspace) return;
    let live = true;
    api.tasks
      .changes(taskId)
      .then((c) => live && setChanges(c))
      .catch(() => live && setChanges(null));
    return () => {
      live = false;
    };
  }, [open, workspace, taskId, task?.updatedAt]);
  if (!task || !summary) return null;

  const branch = taskBranch(task.id);
  const inReview = task.phase === 'human_review';
  const onlyRow = report?.rows[0];
  const prAction = pullRequestAction(task, pushedNow(onlyRow));
  const prUrl = prAction.url;
  const noRemote = onlyRow?.result.result === 'no_remote' ? onlyRow.result.branch : null;
  const repoViews = workspace ? repoPrViews(task, report, changes) : [];
  const repoButton = workspace ? repoPrButton(repoViews) : null;

  const setOpen = (next: boolean) => {
    if (!next) setFeedback('');
    onOpenChange(next);
  };

  const copyBranch = async () => {
    try {
      await navigator.clipboard.writeText(branch);
      toast.success('Branch name copied');
    } catch {
      toast.error('Could not copy to the clipboard');
    }
  };

  const createPullRequest = async () => {
    setBusy('pr');
    try {
      const result = await api.tasks.pullRequests(task.id);
      setReport(result);
      const t = prReportToast(task, result);
      (t.warn ? toast.warning : toast.success)(t.title, { description: t.description });
      try {
        useTaskStore.getState().upsert(await api.tasks.get(task.id));
      } catch {
        // The event stream brings the task up to date as well.
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const sendRework = async () => {
    const text = feedback.trim();
    if (!text) return;
    setBusy('rework');
    const done = await act(() => api.tasks.rework(task.id, text), 'Sent back for rework');
    setBusy(null);
    if (done) setOpen(false);
  };

  const markDone = async () => {
    setBusy('done');
    const done = await act(() => api.tasks.move(task.id, 'done'), 'Task done');
    setBusy(null);
    if (done) setOpen(false);
  };

  // A pull request may take a while; closing the dialog does not stop it.
  const blockClose = busy === 'rework' || busy === 'done';

  return (
    <Dialog open={open} onOpenChange={blockClose ? undefined : setOpen}>
      <DialogContent className="sm:max-w-[700px]" data-testid="human-review-modal">
        <DialogHeader>
          <DialogTitle>Human Review</DialogTitle>
          <DialogDescription>{task.title}</DialogDescription>
          <div className="flex items-center gap-2 pt-2">
            <div
              className="flex items-center gap-1.5 px-2 py-1 rounded"
              style={{ background: 'var(--color-surface-hover)' }}
            >
              <GitBranch className="w-3.5 h-3.5" style={{ color: 'var(--color-info)' }} />
              <span
                className="text-xs font-mono"
                style={{ color: 'var(--color-text-primary)' }}
                data-testid="review-branch"
              >
                {branch}
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={copyBranch}
              title="Copy branch name"
              data-testid="review-copy-branch"
            >
              <Copy className="w-3.5 h-3.5" />
            </Button>
          </div>
        </DialogHeader>

        {!inReview ? (
          <>
            <DialogBody>
              <p
                className="text-sm"
                style={{ color: 'var(--color-text-secondary)' }}
                data-testid="review-not-in-review"
              >
                This task is in {PHASE_LABELS[task.phase]}, not Human Review.
              </p>
            </DialogBody>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                Close
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogBody className="space-y-6 py-4">
              <Attention lines={summary.attention} />

              {summary.unresolved && (
                <div
                  className="p-3 rounded border space-y-2"
                  style={{ borderColor: 'var(--color-warning)' }}
                  data-testid="review-feedback"
                >
                  <h3 className={sectionTitle} style={{ color: 'var(--color-warning)' }}>
                    <AlertTriangle className="w-4 h-4" />
                    {summary.unresolved.heading}
                  </h3>
                  <p
                    className="text-xs whitespace-pre-wrap"
                    style={{ color: 'var(--color-text-primary)' }}
                  >
                    {summary.unresolved.feedback}
                  </p>
                </div>
              )}

              {/* What was built */}
              <section className="space-y-2" data-testid="review-built">
                <h3 className={sectionTitle} style={{ color: 'var(--color-text-primary)' }}>
                  <span
                    className="w-3 h-3 rounded-full"
                    style={{ background: 'var(--color-success)' }}
                  />
                  What was built ({summary.built.length})
                </h3>
                <div className="pl-5 space-y-2">
                  {summary.built.length === 0 && (
                    <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                      No development subtask finished.
                    </p>
                  )}
                  {summary.built.map((s) => (
                    <div
                      key={s.id}
                      className={itemBox}
                      style={{ background: 'var(--color-surface-hover)' }}
                      data-testid={`review-built-${s.id}`}
                    >
                      <p style={{ color: 'var(--color-text-primary)' }}>
                        {s.title}
                        {s.reworkRound ? (
                          <span style={{ color: 'var(--color-text-muted)' }}>
                            {' '}
                            (rework round {s.reworkRound})
                          </span>
                        ) : null}
                      </p>
                      {s.handoff && (
                        <p
                          className="mt-1 whitespace-pre-wrap"
                          style={{ color: 'var(--color-text-secondary)' }}
                        >
                          {s.handoff}
                        </p>
                      )}
                    </div>
                  ))}
                  {summary.skipped.map((s) => (
                    <div
                      key={s.id}
                      className={itemBox}
                      style={{ background: 'var(--color-surface-hover)' }}
                      data-testid={`review-skipped-${s.id}`}
                    >
                      <p style={{ color: 'var(--color-text-secondary)' }}>
                        <span className="line-through">{s.title}</span>{' '}
                        <span style={{ color: 'var(--color-warning)' }}>skipped</span>
                      </p>
                      <p className="mt-1" style={{ color: 'var(--color-text-muted)' }}>
                        {s.skippedReason || 'Skipped by you'}
                      </p>
                    </div>
                  ))}
                </div>
              </section>

              {/* Automated checks */}
              <section className="space-y-2" data-testid="review-checks">
                <h3 className={sectionTitle} style={{ color: 'var(--color-text-primary)' }}>
                  <span
                    className="w-3 h-3 rounded-full"
                    style={{ background: 'var(--color-info)' }}
                  />
                  Automated checks
                </h3>
                <div className="pl-5">
                  {summary.checks ? (
                    <div
                      className={`${itemBox} space-y-1`}
                      style={{ background: 'var(--color-surface-hover)' }}
                    >
                      <Verdict passed={summary.checks.passed} />
                      <p style={{ color: 'var(--color-text-primary)' }}>{summary.checks.summary}</p>
                      {summary.checksStale && (
                        <p style={{ color: 'var(--color-warning)' }}>
                          These ran against an older commit than the last checkpoint.
                        </p>
                      )}
                      {summary.checks.details && (
                        <details>
                          <summary
                            className="cursor-pointer"
                            style={{ color: 'var(--color-text-secondary)' }}
                          >
                            Details
                          </summary>
                          <pre
                            className="mt-1 p-2 rounded overflow-auto max-h-64 text-[11px] whitespace-pre-wrap"
                            style={{
                              background: 'var(--color-terminal-background)',
                              color: 'var(--color-terminal-text)',
                            }}
                          >
                            {summary.checks.details}
                          </pre>
                        </details>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                      The checks did not run.
                    </p>
                  )}
                </div>
              </section>

              {/* QA */}
              <section className="space-y-2">
                <h3 className={sectionTitle} style={{ color: 'var(--color-text-primary)' }}>
                  <span className="w-3 h-3 rounded-full" style={{ background: '#a78bfa' }} />
                  QA ({summary.qa.length})
                </h3>
                <div className="pl-5 space-y-2">
                  {summary.qa.map(({ subtask, verdict }) => (
                    <div
                      key={subtask.id}
                      className={`${itemBox} space-y-1`}
                      style={{ background: 'var(--color-surface-hover)' }}
                      data-testid={`review-qa-${subtask.id}`}
                    >
                      <p style={{ color: 'var(--color-text-primary)' }}>{subtask.title}</p>
                      {verdict ? (
                        <>
                          <Verdict passed={verdict.passed} />
                          <p
                            className="whitespace-pre-wrap"
                            style={{ color: 'var(--color-text-secondary)' }}
                          >
                            {verdict.summary}
                          </p>
                          {verdict.findings && verdict.findings.length > 0 && (
                            <ul
                              className="list-disc pl-4 space-y-0.5"
                              style={{ color: 'var(--color-text-secondary)' }}
                            >
                              {verdict.findings.map((f, i) => (
                                <li key={i} className="whitespace-pre-wrap">
                                  {f}
                                </li>
                              ))}
                            </ul>
                          )}
                        </>
                      ) : (
                        <p style={{ color: 'var(--color-text-muted)' }}>
                          {subtask.status === 'skipped'
                            ? subtask.skippedReason || 'Skipped by you'
                            : 'Did not run'}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </section>

              {/* Pull request */}
              <section
                className="space-y-3 pt-4 border-t"
                style={{ borderColor: 'var(--color-border)' }}
              >
                <h3 className={sectionTitle} style={{ color: 'var(--color-text-primary)' }}>
                  <GitPullRequest className="w-4 h-4" />
                  Pull request
                </h3>
                {workspace ? (
                  <Card
                    className="p-4 space-y-3"
                    style={{
                      background: 'var(--color-surface)',
                      borderColor: 'var(--color-border)',
                    }}
                  >
                    <ul className="space-y-2" data-testid="review-pr-rows">
                      {repoViews.map((view) => (
                        <RepoPrRow key={view.repo} view={view} taskId={task.id} />
                      ))}
                    </ul>
                    {repoButton && (
                      <Button
                        onClick={createPullRequest}
                        disabled={busy !== null}
                        size="sm"
                        variant={repoButton.kind === 'create' ? 'default' : 'outline'}
                        className="w-full text-xs"
                        style={
                          repoButton.kind === 'create'
                            ? {
                                background: 'var(--color-primary)',
                                color: 'var(--color-primary-text)',
                              }
                            : undefined
                        }
                        data-testid="review-create-prs"
                      >
                        {busy === 'pr' ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            {repoButton.busyLabel}
                          </>
                        ) : (
                          repoButton.label
                        )}
                      </Button>
                    )}
                    {busy === 'pr' && (
                      <p
                        className="text-xs"
                        style={{ color: 'var(--color-text-muted)' }}
                        data-testid="review-pr-progress"
                      >
                        Squashing and pushing each repository in turn. This can take a minute.
                      </p>
                    )}
                  </Card>
                ) : (
                  <Card
                    className="p-4 space-y-3"
                    style={{
                      background: 'var(--color-surface)',
                      borderColor: 'var(--color-border)',
                    }}
                  >
                    {prUrl && (
                      <a
                        href={prUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1.5 text-sm underline"
                        style={{ color: 'var(--color-primary)' }}
                        data-testid="review-pr-link"
                      >
                        <ExternalLink className="w-4 h-4" />
                        {prAction.linkLabel}
                      </a>
                    )}
                    {noRemote && (
                      <p
                        className="text-sm"
                        style={{ color: 'var(--color-warning)' }}
                        data-testid="review-pr-no-remote"
                      >
                        The repository has no remote, so nothing was pushed. The work is on{' '}
                        {noRemote}.
                      </p>
                    )}
                    {prAction.pushedNote && (
                      <p
                        className="text-sm"
                        style={{ color: 'var(--color-text-primary)' }}
                        data-testid="review-pr-pushed-note"
                      >
                        {prAction.pushedNote}
                      </p>
                    )}
                    <p
                      className="text-xs"
                      style={{ color: 'var(--color-text-secondary)' }}
                      data-testid="review-pr-status"
                    >
                      {prAction.kind === 'current' && (
                        <CheckCircle2
                          className="inline w-3.5 h-3.5 mr-1 -mt-0.5"
                          style={{ color: 'var(--color-success)' }}
                        />
                      )}
                      {prAction.help}
                    </p>
                    {prAction.kind !== 'current' && (
                      <Button
                        onClick={createPullRequest}
                        disabled={busy !== null}
                        size="sm"
                        variant={prAction.kind === 'update' ? 'outline' : 'default'}
                        className="w-full text-xs"
                        style={
                          prAction.kind === 'create'
                            ? {
                                background: 'var(--color-primary)',
                                color: 'var(--color-primary-text)',
                              }
                            : undefined
                        }
                        data-testid={
                          prAction.kind === 'create' ? 'review-create-pr' : 'review-update-pr'
                        }
                      >
                        {busy === 'pr' ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            {prAction.busyLabel}
                          </>
                        ) : (
                          prAction.label
                        )}
                      </Button>
                    )}
                    {busy === 'pr' && (
                      <p
                        className="text-xs"
                        style={{ color: 'var(--color-text-muted)' }}
                        data-testid="review-pr-progress"
                      >
                        {prAction.progress}
                      </p>
                    )}
                  </Card>
                )}
              </section>

              {native && <LocalReview nativeApi={native} taskId={task.id} />}

              {/* Rework */}
              <section
                className="space-y-2 pt-4 border-t"
                style={{ borderColor: 'var(--color-border)' }}
              >
                <h3 className={sectionTitle} style={{ color: 'var(--color-text-primary)' }}>
                  <RotateCcw className="w-4 h-4" />
                  Request rework
                </h3>
                <p className="text-xs" style={{ color: 'var(--color-text-secondary)' }}>
                  The task goes back to In Progress with a rework subtask for your feedback.
                </p>
                <Textarea
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  placeholder="What needs to change?"
                  rows={4}
                  disabled={busy !== null}
                  data-testid="review-rework-feedback"
                />
                <div className="flex justify-end">
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-xs"
                    onClick={sendRework}
                    disabled={busy !== null || !feedback.trim()}
                    data-testid="review-rework-send"
                  >
                    {busy === 'rework' ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      'Send back for rework'
                    )}
                  </Button>
                </div>
              </section>
            </DialogBody>

            <DialogFooter className="gap-2">
              <Button
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={blockClose}
                className="text-xs"
              >
                Close
              </Button>
              <Button
                className="text-xs"
                style={{ background: 'var(--color-success)', color: '#ffffff' }}
                onClick={markDone}
                disabled={busy !== null}
                data-testid="review-mark-done"
              >
                {busy === 'done' ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Mark done'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Verdict({ passed }: { passed: boolean }) {
  const color = passed ? 'var(--color-success)' : 'var(--color-error)';
  const Icon = passed ? CheckCircle2 : XCircle;
  return (
    <span className="inline-flex items-center gap-1 font-medium" style={{ color }}>
      <Icon className="w-3.5 h-3.5" />
      {passed ? 'Passed' : 'Failed'}
    </span>
  );
}

function Attention({ lines }: { lines: string[] }) {
  if (lines.length === 0) {
    return (
      <p
        className="flex items-center gap-2 text-sm"
        style={{ color: 'var(--color-success)' }}
        data-testid="review-attention"
      >
        <CheckCircle2 className="w-4 h-4" />
        The checks and every QA review passed.
      </p>
    );
  }
  return (
    <div className="space-y-1" data-testid="review-attention">
      <p className="text-sm font-medium" style={{ color: 'var(--color-text-primary)' }}>
        Look at these first
      </p>
      <ul className="list-disc pl-5 text-xs space-y-0.5" style={{ color: 'var(--color-warning)' }}>
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </div>
  );
}

/** One repository's line in a workspace task's pull request section. */
function RepoPrRow({ view, taskId }: { view: RepoPrView; taskId: string }) {
  const projectPath = useProjectStore((s) => s.projectPath);
  const path = worktreePath(projectPath, taskId, view.repo);
  const words = repoPrRowText(view);
  const tone = {
    muted: 'var(--color-text-muted)',
    warning: 'var(--color-warning)',
    error: 'var(--color-error)',
  }[words.tone];
  const action = view.state === 'action' ? view.action : null;
  const note = view.state === 'action' ? (view.note ?? action?.pushedNote ?? null) : null;
  const detail = (
    <span className="flex flex-wrap items-center gap-2">
      {action?.url && (
        <a
          href={action.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 underline"
          style={{ color: 'var(--color-primary)' }}
        >
          <ExternalLink className="w-3.5 h-3.5" />
          {action.linkLabel}
        </a>
      )}
      <span style={{ color: tone }}>{words.text}</span>
      {note && (
        <span className="basis-full" style={{ color: 'var(--color-text-secondary)' }}>
          {note}
        </span>
      )}
    </span>
  );
  return (
    <li
      className="flex flex-wrap items-center gap-2 text-xs"
      data-testid={`review-pr-row-${view.repo}`}
      data-state={view.state === 'action' ? view.action.kind : view.state}
    >
      <span className="font-mono font-medium" style={{ color: 'var(--color-text-primary)' }}>
        {view.repo}/
      </span>
      {detail}
      {native && path && view.state !== 'no_changes' && (
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto h-6 px-2 text-xs"
          onClick={async () => {
            const editors = await native!.getAvailableEditors().catch(() => []);
            const editor = availableEditorsSorted(editors)[0];
            const result = editor
              ? await native!.openEditorAtPath(path, editor.id, projectPath)
              : await native!.openFolder(path);
            if (!result.success) toast.error(result.error ?? 'Could not open it');
          }}
        >
          Open
        </Button>
      )}
    </li>
  );
}

/** Editors that are installed, Cursor first. */
function availableEditorsSorted(editors: AvailableEditor[]): AvailableEditor[] {
  const available = editors.filter((e) => e.available !== false);
  return [...available].sort((a, b) => (a.id === 'cursor' ? -1 : b.id === 'cursor' ? 1 : 0));
}

/** Desktop app only: open the worktree in an editor or the file manager. */
function LocalReview({ nativeApi, taskId }: { nativeApi: NativeApi; taskId: string }) {
  const projectPath = useProjectStore((s) => s.projectPath);
  const path = worktreePath(projectPath, taskId);
  const [editors, setEditors] = useState<AvailableEditor[] | null>(null);
  const [editorId, setEditorId] = useState<EditorId | null>(null);
  const [opening, setOpening] = useState<'editor' | 'folder' | null>(null);

  useEffect(() => {
    let live = true;
    nativeApi
      .getAvailableEditors()
      .then((raw) => {
        if (!live) return;
        const sorted = availableEditorsSorted(raw);
        setEditors(sorted);
        setEditorId(sorted[0]?.id ?? null);
      })
      .catch(() => {
        if (live) setEditors([]);
      });
    return () => {
      live = false;
    };
  }, [nativeApi]);

  const editor = editors?.find((e) => e.id === editorId) ?? null;

  const openIn = async (target: 'editor' | 'folder') => {
    if (!path) return;
    setOpening(target);
    try {
      if (!(await nativeApi.pathExists(path))) {
        toast.error(`Worktree not found at ${path}`);
        return;
      }
      const result =
        target === 'editor' && editorId
          ? await nativeApi.openEditorAtPath(path, editorId, projectPath)
          : await nativeApi.openFolder(path);
      if (result.success) {
        toast.success(target === 'editor' ? `Opened in ${editor?.label}` : 'Opened the folder', {
          description: path,
        });
      } else {
        toast.error(result.error ?? 'Could not open the worktree');
      }
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setOpening(null);
    }
  };

  return (
    <section
      className="space-y-3 pt-4 border-t"
      style={{ borderColor: 'var(--color-border)' }}
      data-testid="review-local"
    >
      <h3 className={sectionTitle} style={{ color: 'var(--color-text-primary)' }}>
        <Folder className="w-4 h-4" />
        Review locally
      </h3>
      {!path && (
        <p className="text-xs" style={{ color: 'var(--color-warning)' }}>
          No project is open.
        </p>
      )}
      <Card
        className="p-4 space-y-3"
        style={{ background: 'var(--color-surface)', borderColor: 'var(--color-border)' }}
      >
        <div>
          <h4
            className="text-sm font-medium flex items-center gap-2"
            style={{ color: 'var(--color-text-primary)' }}
          >
            <Code2 className="w-4 h-4" />
            Open the worktree
          </h4>
          {path && (
            <p
              className="text-xs mt-1 font-mono break-all"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              {path}
            </p>
          )}
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
          {editors === null ? (
            <span
              className="flex items-center gap-2 text-xs"
              style={{ color: 'var(--color-text-secondary)' }}
            >
              <Loader2 className="w-4 h-4 animate-spin" />
              Detecting editors…
            </span>
          ) : editors.length === 0 ? (
            <span className="text-xs self-center" style={{ color: 'var(--color-text-secondary)' }}>
              No editor found.
            </span>
          ) : (
            <>
              {editors.length > 1 && (
                <Select
                  value={editorId ?? ''}
                  onValueChange={(v) => setEditorId(v === 'cursor' || v === 'vscode' ? v : null)}
                >
                  <SelectTrigger className="w-full sm:w-[180px] h-9 text-xs">
                    <SelectValue placeholder="Choose editor" />
                  </SelectTrigger>
                  <SelectContent>
                    {editors.map((e) => (
                      <SelectItem key={e.id} value={e.id} className="text-xs">
                        {e.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Button
                size="sm"
                className="text-xs"
                onClick={() => openIn('editor')}
                disabled={!path || !editorId || opening !== null}
                style={{ background: 'var(--color-primary)', color: 'var(--color-primary-text)' }}
                data-testid="review-open-editor"
              >
                {opening === 'editor' ? 'Opening…' : `Open in ${editor?.label ?? 'editor'}`}
              </Button>
            </>
          )}
          <Button
            size="sm"
            variant="outline"
            className="text-xs"
            onClick={() => openIn('folder')}
            disabled={!path || opening !== null}
            data-testid="review-open-folder"
          >
            {opening === 'folder' ? 'Opening…' : 'Show in file manager'}
          </Button>
        </div>
      </Card>
    </section>
  );
}
