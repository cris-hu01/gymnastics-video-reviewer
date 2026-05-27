import React from 'react';
import {ChevronDown} from 'lucide-react';

export type ScoreFilterMenu = 'apparatus' | 'sex' | 'country';

export type ScoreFilterOption = {
  value: string;
  label: string;
};

export type ScoreFilterDropdownProps = {
  id: ScoreFilterMenu;
  placeholder: string;
  allLabel: string;
  value: string;
  options: ScoreFilterOption[];
  openFilter: ScoreFilterMenu | null;
  onToggle: (next: ScoreFilterMenu | null) => void;
  onChange: (nextValue: string) => void;
};

function ScoreFilterDropdownComponent({
  id,
  placeholder,
  allLabel,
  value,
  options,
  openFilter,
  onToggle,
  onChange,
}: ScoreFilterDropdownProps) {
  const isOpen = openFilter === id;
  const selectedLabel =
    value === 'all'
      ? placeholder
      : options.find((option) => option.value === value)?.label ?? placeholder;

  return (
    <div data-score-filter-root className="relative">
      <button
        type="button"
        onClick={() => onToggle(isOpen ? null : id)}
        className="flex w-full min-w-[5.8rem] items-center justify-between gap-2 whitespace-nowrap rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 shadow-sm transition-colors hover:border-gray-300"
      >
        <span className="truncate">{selectedLabel}</span>
        <ChevronDown
          size={14}
          className={`shrink-0 text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`}
        />
      </button>
      {isOpen && (
        <div className="absolute left-0 right-0 top-full z-20 mt-2 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl">
          <div className="max-h-64 overflow-y-auto py-1">
            <button
              type="button"
              onClick={() => {
                onChange('all');
                onToggle(null);
              }}
              className={`flex w-full items-center px-3 py-2 text-left text-sm transition-colors ${
                value === 'all' ? 'bg-red-50 text-red-600' : 'text-gray-700 hover:bg-gray-50'
              }`}
            >
              {allLabel}
            </button>
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onChange(option.value);
                  onToggle(null);
                }}
                className={`flex w-full items-center px-3 py-2 text-left text-sm transition-colors ${
                  value === option.value ? 'bg-red-50 text-red-600' : 'text-gray-700 hover:bg-gray-50'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export const ScoreFilterDropdown = React.memo(ScoreFilterDropdownComponent);
