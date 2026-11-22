// Components are unstyled without the stylesheet: import '@software-factory/design-system/styles.css' once at the app root.
export * as tokens from './tokens.ts';
export type { Tone, Theme, ColorToken } from './tokens.ts';

export { Button, IconButton, type ButtonProps, type IconButtonProps } from './components/Button.tsx';
export { Input, Select, type InputProps, type SelectProps } from './components/Input.tsx';
export { Checkbox, type CheckboxProps } from './components/Checkbox.tsx';
export { Badge, type BadgeProps } from './components/Badge.tsx';
export { Dot } from './components/Dot.tsx';
export { Kbd } from './components/Kbd.tsx';
export { Tooltip, type TooltipProps } from './components/Tooltip.tsx';
export { Dialog, Sheet, type DialogProps } from './components/Dialog.tsx';
export { Tabs, type TabItem, type TabsProps } from './components/Tabs.tsx';
export { Table } from './components/Table.tsx';
export { Card, type CardProps } from './components/Card.tsx';
export { EmptyState, type EmptyStateProps } from './components/EmptyState.tsx';
export { Skeleton } from './components/Skeleton.tsx';
export { ToastProvider, useToast, type ToastOptions } from './components/Toast.tsx';
export * from './components/icons.tsx';

export * from './factory/model.ts';
export { StageTrack } from './factory/StageTrack.tsx';
export { RunCard, type RunCardProps } from './factory/RunCard.tsx';
export { ReviewMatrix } from './factory/ReviewMatrix.tsx';
export { MetricStat, MetricStrip, type MetricStatProps } from './factory/MetricStat.tsx';
export { SourceChip, SOURCE_LABEL, sourceLabel } from './factory/SourceChip.tsx';
export { OutcomePill } from './factory/OutcomePill.tsx';
export { Timeline } from './factory/Timeline.tsx';
export { CommandMenu, filterCommands, type Command, type CommandMenuProps } from './factory/CommandMenu.tsx';

export { ProjectPicker, type ProjectPickerProps } from './onboarding/ProjectPicker.tsx';
export { IngestProgress, type IngestItem, type IngestStatus } from './onboarding/IngestProgress.tsx';
