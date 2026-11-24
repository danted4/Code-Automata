/**
 * Coming Soon placeholder for features under development.
 */

export function ComingSoon() {
  return (
    <div
      className="flex flex-col items-center justify-center min-h-[60vh] gap-3"
      style={{
        color: 'var(--color-text-muted)',
      }}
    >
      <h2 className="text-2xl font-semibold" style={{ color: 'var(--color-text-primary)' }}>
        Coming Soon
      </h2>
      <p className="text-sm">This feature is under development.</p>
    </div>
  );
}
