export function Seal({ size = 64, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" role="img" aria-label="Sandbox 印" className={className}>
      <rect x="4" y="4" width="92" height="92" rx="2" fill="var(--color-accent-strong)" />
      <text x="50" y="62" textAnchor="middle" fontSize="52" fontWeight="700" fill="var(--color-accent-ink)" fontFamily="var(--font-serif), serif">场</text>
    </svg>
  );
}
