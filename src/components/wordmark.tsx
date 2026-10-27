import Link from "next/link";

type WordmarkProps = {
  className?: string;
  asLink?: boolean;
};

function Mark() {
  return (
    <span
      aria-hidden="true"
      className="grid size-9 shrink-0 place-items-center rounded-xl shadow-lg shadow-secondary/25 brand-gradient"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="size-5 text-white"
      >
        <title>Technikino</title>
        <rect x="3" y="4" width="18" height="16" rx="3" />
        <path d="M7 4v16M17 4v16M3 9h4M17 9h4M3 15h4M17 15h4" />
      </svg>
    </span>
  );
}

export function Wordmark({ className, asLink = true }: WordmarkProps) {
  const content = (
    <>
      <Mark />
      <span className="text-base font-black uppercase tracking-[0.22em] text-white sm:text-lg">
        Techni<span className="text-gradient">kino</span>
      </span>
    </>
  );

  const classes = ["group inline-flex items-center gap-2.5", className]
    .filter(Boolean)
    .join(" ");

  if (!asLink) {
    return <span className={classes}>{content}</span>;
  }

  return (
    <Link href="/" aria-label="Technikino — strona główna" className={classes}>
      {content}
    </Link>
  );
}
