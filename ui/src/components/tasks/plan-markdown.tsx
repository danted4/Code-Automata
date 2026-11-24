/**
 * Plan Markdown: a read-only rendering of a task's plan (GitHub-flavoured markdown), styled with
 * the theme's colour variables.
 */

import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

const primary = { color: 'var(--color-text-primary)' };
const secondary = { color: 'var(--color-text-secondary)' };
const border = { borderColor: 'var(--color-border)' };

const components: Components = {
  h1: ({ node: _node, ...props }) => (
    <h1 className="mt-5 mb-2 text-xl font-bold first:mt-0" style={primary} {...props} />
  ),
  h2: ({ node: _node, ...props }) => (
    <h2
      className="mt-5 mb-2 border-b pb-1 text-lg font-semibold first:mt-0"
      style={{ ...primary, ...border }}
      {...props}
    />
  ),
  h3: ({ node: _node, ...props }) => (
    <h3 className="mt-4 mb-2 text-base font-semibold first:mt-0" style={primary} {...props} />
  ),
  h4: ({ node: _node, ...props }) => (
    <h4 className="mt-3 mb-1 text-sm font-semibold first:mt-0" style={primary} {...props} />
  ),
  p: ({ node: _node, ...props }) => (
    <p className="mb-3 leading-relaxed" style={secondary} {...props} />
  ),
  ul: ({ node: _node, ...props }) => (
    <ul className="mb-3 ml-6 list-disc space-y-1" style={secondary} {...props} />
  ),
  ol: ({ node: _node, ...props }) => (
    <ol className="mb-3 ml-6 list-decimal space-y-1" style={secondary} {...props} />
  ),
  li: ({ node: _node, ...props }) => <li className="leading-relaxed" {...props} />,
  a: ({ node: _node, ...props }) => (
    <a
      className="underline underline-offset-2"
      style={{ color: 'var(--color-info)' }}
      target="_blank"
      rel="noreferrer"
      {...props}
    />
  ),
  strong: ({ node: _node, ...props }) => (
    <strong className="font-semibold" style={primary} {...props} />
  ),
  blockquote: ({ node: _node, ...props }) => (
    <blockquote
      className="mb-3 border-l-4 pl-4 italic"
      style={{ borderColor: 'var(--color-info)', color: 'var(--color-text-muted)' }}
      {...props}
    />
  ),
  hr: ({ node: _node, ...props }) => <hr className="my-4" style={border} {...props} />,
  // Code inside a block takes the block's look; the inline style is cleared there.
  pre: ({ node: _node, ...props }) => (
    <pre
      className="mb-3 overflow-x-auto rounded-md p-3 font-mono text-xs [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-inherit"
      style={{ background: 'var(--color-background)', color: 'var(--color-text-secondary)' }}
      {...props}
    />
  ),
  code: ({ node: _node, className, ...props }) => (
    <code
      className={cn(
        'rounded bg-[var(--color-background)] px-1.5 py-0.5 font-mono text-[0.9em] text-[color:var(--color-info)]',
        className
      )}
      {...props}
    />
  ),
  table: ({ node: _node, ...props }) => (
    <div className="mb-3 overflow-x-auto">
      <table className="w-full border-collapse text-sm" style={secondary} {...props} />
    </div>
  ),
  th: ({ node: _node, ...props }) => (
    <th
      className="border px-2 py-1 text-left font-semibold"
      style={{ ...primary, ...border }}
      {...props}
    />
  ),
  td: ({ node: _node, ...props }) => <td className="border px-2 py-1" style={border} {...props} />,
};

export function PlanMarkdown({ markdown, className }: { markdown: string; className?: string }) {
  return (
    <div className={cn('text-sm break-words', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
