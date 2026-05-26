'use client';

/**
 * Hover-revealed `#` anchor link for card headings. Copies the deep-link
 * (origin + pathname + #id) to the clipboard on click.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

interface AnchorLinkProps {
  targetId: string;
  className?: string;
}

export function AnchorLink({ targetId, className = '' }: AnchorLinkProps): JSX.Element {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const onClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      e.preventDefault();
      if (typeof window === 'undefined') return;
      const url = `${window.location.origin}${window.location.pathname}#${targetId}`;
      // Update the URL fragment without jumping (jump handled by browser if user prefers).
      window.history.replaceState(null, '', `#${targetId}`);
      if (navigator.clipboard) {
        void navigator.clipboard.writeText(url).then(() => {
          setCopied(true);
          if (timeoutRef.current) clearTimeout(timeoutRef.current);
          timeoutRef.current = setTimeout(() => setCopied(false), 1500);
        });
      }
    },
    [targetId],
  );

  return (
    <a
      href={`#${targetId}`}
      onClick={onClick}
      aria-label={copied ? 'Link copied' : 'Copy link to this section'}
      className={`opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity inline-flex items-center justify-center h-6 w-6 rounded text-slate-400 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 ${className}`}
    >
      {copied ? (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
          className="h-3.5 w-3.5"
        >
          <path
            fillRule="evenodd"
            d="M16.704 5.29a1 1 0 010 1.415l-7.5 7.5a1 1 0 01-1.414 0l-3.5-3.5a1 1 0 111.414-1.415L8.5 12.085l6.79-6.795a1 1 0 011.414 0z"
            clipRule="evenodd"
          />
        </svg>
      ) : (
        <span aria-hidden="true" className="font-mono text-sm leading-none">
          #
        </span>
      )}
    </a>
  );
}
