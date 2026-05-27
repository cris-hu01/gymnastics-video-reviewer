import React from 'react';

import type {ClipStatus} from '../types';
import {clipBadgeClass, statusLabel} from '../lib/format';

export type StatusBadgeProps = {
  status: ClipStatus;
  size?: 'sm' | 'lg';
};

function StatusBadgeComponent({status, size = 'sm'}: StatusBadgeProps) {
  const sizeClass =
    size === 'lg' ? 'text-sm px-3 py-1.5 min-w-[5rem]' : 'text-[11px] px-2.5 py-1 min-w-[3.5rem]';
  return (
    <span
      data-testid="clip-status-badge"
      data-clip-status={status}
      className={`inline-flex items-center justify-center whitespace-nowrap leading-none rounded-full border font-medium shrink-0 ${sizeClass} ${clipBadgeClass(status)}`}
    >
      {statusLabel(status)}
    </span>
  );
}

export const StatusBadge = React.memo(StatusBadgeComponent);
