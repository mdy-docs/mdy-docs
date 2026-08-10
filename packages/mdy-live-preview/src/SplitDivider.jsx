import { useEffect, useState } from 'react';

/**
 * The draggable divider between the panes.
 *
 * `ratio` is a fraction of the container, which is the one simplification the
 * port takes for free: the old version stored pixel widths and therefore
 * needed a `window.resize` handler to recompute both panes from a remembered
 * ratio. Storing the ratio and letting CSS do the arithmetic deletes that
 * handler.
 */
export function SplitDivider({ onRatio }) {
  const [dragging, setDragging] = useState(false);
  const [hover, setHover] = useState(false);

  useEffect(() => {
    if (!dragging) return;

    const container = document.getElementById('container');
    const move = (event) => {
      const bounds = container.getBoundingClientRect();
      const minWidth = 100;
      const offset = Math.max(minWidth, Math.min(event.clientX - bounds.left, bounds.width - minWidth));
      onRatio(offset / bounds.width);
    };
    const up = () => setDragging(false);

    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [dragging, onRatio]);

  const classes = ['split-divider', dragging && 'active', (hover || dragging) && 'hover']
    .filter(Boolean)
    .join(' ');

  return (
    <div
      id="split-divider"
      className={classes}
      onMouseDown={() => setDragging(true)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onDoubleClick={() => onRatio(0.5)}
    />
  );
}
