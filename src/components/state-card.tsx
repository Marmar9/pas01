import type { ReactNode } from "react";

type StateCardProps = {
  title: string;
  description: string;
  action?: ReactNode;
  icon?: "search" | "warning" | "spinner";
};

const icons = {
  search: <path d="M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3" />,
  warning: (
    <path d="M12 9v4M12 17h.01M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z" />
  ),
  spinner: <path d="M21 12a9 9 0 11-6.2-8.6" />,
};

export function StateCard({
  title,
  description,
  action,
  icon = "search",
}: StateCardProps) {
  return (
    <div className="mx-auto max-w-xl">
      <div className="surface-card px-8 py-12 text-center">
        <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-white/5 text-secondary">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className={`size-6 ${icon === "spinner" ? "animate-spin-slow" : ""}`}
          >
            {icons[icon]}
          </svg>
        </span>
        <h2 className="mt-6 text-2xl font-black text-white">{title}</h2>
        <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-zinc-400">
          {description}
        </p>
        {action ? (
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            {action}
          </div>
        ) : null}
      </div>
    </div>
  );
}
