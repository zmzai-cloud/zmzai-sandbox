import Link from "next/link";

/**
 * zmzai.cloud wordmark — mono, uppercase, tracked. No graphic logo.
 * `zmzai` is the ownable handle; `cloud` is the lighter carrier suffix.
 * See BRAND.md §4.4.
 */
export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span
      className={`font-mono font-bold tracking-[0.08em] uppercase ${className}`}
    >
      <span className="text-ink">zmzai</span>
      <span className="text-muted font-normal">.cloud</span>
    </span>
  );
}

export function WordmarkLink({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="focus-ring inline-flex items-baseline">
      <Wordmark />
    </Link>
  );
}
