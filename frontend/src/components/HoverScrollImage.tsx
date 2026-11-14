"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A tall picture of a whole page, showing its top. While the pointer is over it the picture
 * scrolls down to the end and back, so the card shows the full page without opening it.
 * The children get the frame's width in pixels.
 */
function HoverScroll({ seconds = 10, children }: { seconds?: number; children: (width: number) => ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState(false);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const box = frame.current;
    if (!box) return;
    setWidth(box.clientWidth);
    const observer = new ResizeObserver(() => setWidth(box.clientWidth));
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const picture = content.current;
    const box = frame.current;
    if (!picture || !box) return;
    if (!hover) {
      picture.style.transition = "transform 0.55s ease";
      picture.style.transform = "translate3d(0, 0, 0)";
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    // Carry on from where the picture is now, in case it was still sliding back.
    picture.style.transition = "none";
    let y = Math.max(0, -new DOMMatrixReadOnly(getComputedStyle(picture).transform).m42);
    let direction = 1;
    let last = 0;
    let frameId = 0;
    const tick = (now: number) => {
      if (!last) last = now;
      const dt = Math.min(0.032, (now - last) / 1000);
      last = now;
      const maxScroll = Math.max(0, picture.offsetHeight - box.clientHeight);
      if (maxScroll > 0) {
        y += (direction * maxScroll * dt) / seconds;
        if (y >= maxScroll) {
          y = maxScroll;
          direction = -1;
        } else if (y <= 0) {
          y = 0;
          direction = 1;
        }
        picture.style.transform = `translate3d(0, ${-y}px, 0)`;
      }
      frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [hover, seconds]);

  return (
    <div ref={frame} className="hs-frame" onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}>
      <div ref={content} className="hs-content">
        {children(width)}
      </div>
    </div>
  );
}

/** A saved screenshot of the page. */
export function HoverScrollImage({ src, alt, seconds }: { src: string; alt: string; seconds?: number }) {
  return (
    <HoverScroll seconds={seconds}>
      {() => (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="hs-image" src={src} alt={alt} loading="lazy" draggable={false} />
      )}
    </HoverScroll>
  );
}
