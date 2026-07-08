'use client';

import { useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import type { SxProps, Theme } from '@mui/material/styles';

/**
 * Scroll-reveal wrapper. Fades + rises its children into view once, the first time
 * they enter the viewport. Deliberately dependency-free (one IntersectionObserver) —
 * no motion library — and fully disabled under prefers-reduced-motion, where children
 * render visible immediately with no transform.
 */
interface RevealProps {
  children: React.ReactNode;
  /** Stagger, in ms, so a heading can lead its media. */
  delay?: number;
  /** Vertical travel distance in px. Editorial variant passes a larger value. */
  distance?: number;
  sx?: SxProps<Theme>;
  component?: React.ElementType;
}

export default function Reveal({
  children,
  delay = 0,
  distance = 16,
  sx,
  component = 'div',
}: RevealProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    // Reduced-motion is handled entirely by the CSS media query below (renders visible
    // with no transition), so the observer is the only JS path — which also avoids a
    // synchronous setState in the effect body.
    const node = ref.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setShown(true);
          observer.disconnect();
        }
      },
      { threshold: 0.15, rootMargin: '0px 0px -10% 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <Box
      ref={ref}
      component={component}
      sx={{
        opacity: shown ? 1 : 0,
        transform: shown ? 'none' : `translateY(${distance}px)`,
        transition:
          'opacity 0.6s cubic-bezier(0.22, 1, 0.36, 1), transform 0.6s cubic-bezier(0.22, 1, 0.36, 1)',
        transitionDelay: `${delay}ms`,
        '@media (prefers-reduced-motion: reduce)': {
          opacity: 1,
          transform: 'none',
          transition: 'none',
        },
        ...sx,
      }}
    >
      {children}
    </Box>
  );
}
