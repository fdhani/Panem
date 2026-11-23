import { type ReactNode, useEffect, useId, useRef } from "react";

/**
 * Modal dialog on the native <dialog> element (showModal): the browser keeps focus inside,
 * makes the page behind inert, closes on Esc, and returns focus to whatever opened it.
 * A bottom sheet on phones, centred on wider screens; a tap on the backdrop closes it.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Wider on larger screens (e.g. a terminal). */
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      // Remembered here: the browser only restores focus on close(), not when the dialog is
      // removed from the page (a dialog rendered only while open).
      const opener = document.activeElement as HTMLElement | null;
      d.showModal();
      const overflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = overflow;
        if (opener?.isConnected) opener.focus();
      };
    }
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      // Esc: let React state close it, so open/close stay in one place.
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      // Clicks on the dialog element itself (not its content) are on the backdrop.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      className={`mt-auto mb-0 w-full max-w-full rounded-t-2xl border border-border bg-surface p-0 text-text shadow-xl backdrop:bg-black/50 sm:m-auto sm:rounded-2xl ${wide ? "sm:max-w-3xl" : "sm:max-w-md"}`}
    >
      <div className="p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] sm:pb-5">
        <h2 id={titleId} className="pr-2 text-base font-semibold break-words">
          {title}
        </h2>
        <div className="mt-2">{children}</div>
      </div>
    </dialog>
  );
}
