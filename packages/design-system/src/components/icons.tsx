// The handful of glyphs the components need. 16px grid, 1.5 stroke, currentColor.
import type { SVGProps } from 'react';

const base = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;
export const CloseIcon = (p: SVGProps<SVGSVGElement>) => <svg {...base} {...p}><path d="M4 4l8 8M12 4l-8 8" /></svg>;
export const SearchIcon = (p: SVGProps<SVGSVGElement>) => <svg {...base} {...p}><circle cx="7" cy="7" r="4.25" /><path d="M10.25 10.25L13 13" /></svg>;
export const CheckIcon = (p: SVGProps<SVGSVGElement>) => <svg {...base} {...p}><path d="M3.5 8.5l3 3 6-7" /></svg>;
export const ArrowUpRightIcon = (p: SVGProps<SVGSVGElement>) => <svg {...base} {...p}><path d="M5 11l6-6M6 5h5v5" /></svg>;
export const BranchIcon = (p: SVGProps<SVGSVGElement>) => <svg {...base} {...p}><circle cx="5" cy="4" r="1.5" /><circle cx="5" cy="12" r="1.5" /><circle cx="11" cy="6" r="1.5" /><path d="M5 5.5v5M11 7.5c0 2-2 2.5-6 3" /></svg>;
