type Props = {
  checked: boolean;
  onChange: (next: boolean) => void;
  'aria-label'?: string;
  disabled?: boolean;
};

/** 类 iOS 开关：绿/灰 + 圆形滑块 */
export function IosSwitch({ checked, onChange, 'aria-label': ariaLabel, disabled }: Props) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onChange(!checked);
      }}
      className={[
        'relative inline-flex h-7 w-[46px] shrink-0 cursor-pointer items-center rounded-full p-0.5',
        'border border-black/5 transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-1 dark:focus-visible:ring-offset-slate-900',
        checked ? 'bg-primary-500' : 'bg-stone-300 dark:bg-slate-600',
        disabled ? 'cursor-not-allowed opacity-50' : '',
      ].join(' ')}
    >
      <span
        className={[
          'pointer-events-none block h-6 w-6 rounded-full bg-white shadow-md ring-1 ring-black/5 transition-transform duration-200 ease-out',
          checked ? 'translate-x-[18px]' : 'translate-x-0',
        ].join(' ')}
      />
    </button>
  );
}
