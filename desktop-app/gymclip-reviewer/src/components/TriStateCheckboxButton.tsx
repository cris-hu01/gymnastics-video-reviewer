import React from 'react';
import {Check, Minus} from 'lucide-react';

export type TriStateCheckboxButtonProps = {
  state: 'checked' | 'indeterminate' | 'unchecked';
  disabled?: boolean;
  onClick: () => void;
  title: string;
};

function TriStateCheckboxButtonComponent({
  state,
  disabled = false,
  onClick,
  title,
}: TriStateCheckboxButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex h-4 w-4 items-center justify-center rounded border transition-colors ${
        disabled
          ? 'cursor-not-allowed border-gray-200 bg-gray-100 text-gray-300'
          : state === 'unchecked'
            ? 'border-gray-300 bg-white text-gray-500 hover:border-gray-400'
            : 'border-red-200 bg-red-50 text-red-600 hover:border-red-300'
      }`}
    >
      {state === 'checked' && <Check size={11} strokeWidth={3} />}
      {state === 'indeterminate' && <Minus size={11} strokeWidth={3} />}
    </button>
  );
}

export const TriStateCheckboxButton = React.memo(TriStateCheckboxButtonComponent);
