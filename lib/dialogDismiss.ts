// Shared logic for dashboard modal dismissal (KAN-74). Pure and DOM-free so it
// can be unit tested without a browser/jsdom, which this repo doesn't have.

// A backdrop click only counts as "outside" when the native event target is
// the backdrop element itself, not a descendant that bubbled up to it.
export function isBackdropClick(
  target: EventTarget | null,
  currentTarget: EventTarget | null
): boolean {
  return target === currentTarget;
}

// Guards against the click that restores window focus (or the one right after
// it) being misread as a deliberate "click outside to close." Losing focus
// arms the guard; the next backdrop click after that is swallowed once, then
// backdrop clicks behave normally again.
export function createRefocusGuard() {
  let armed = false;
  return {
    onBlur() {
      armed = true;
    },
    // Returns true (and disarms) if this click should be ignored because the
    // window blurred and hasn't seen a click since.
    consume(): boolean {
      if (!armed) return false;
      armed = false;
      return true;
    },
  };
}
