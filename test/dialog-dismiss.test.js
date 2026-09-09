const { test } = require("node:test");
const assert = require("node:assert");

// KAN-74. This repo has no component-render tests (see the "kill switch"
// comment in solana-network.test.js) — modal dismiss behavior is verified at
// the shared logic it's built from (lib/dialogDismiss.ts), used by
// PostMemeModal, InvestModal, TipModal, EmailAuthModal, ShareBar, and the
// leaderboard memes modal via lib/useDialogDismiss.ts.

test("isBackdropClick: true only when the click target is the backdrop itself", async () => {
  const { isBackdropClick } = await import("../lib/dialogDismiss.ts");
  const backdrop = {};
  const innerButton = {};
  assert.strictEqual(isBackdropClick(backdrop, backdrop), true);
  assert.strictEqual(isBackdropClick(innerButton, backdrop), false);
});

test("createRefocusGuard: swallows one backdrop click after a window blur, then behaves normally", async () => {
  const { createRefocusGuard } = await import("../lib/dialogDismiss.ts");
  const guard = createRefocusGuard();

  // No blur yet: a click is never swallowed.
  assert.strictEqual(guard.consume(), false);

  // Blur (window loses focus), then focus is restored, then the user clicks
  // anywhere (KAN-74 repro) — that first click must be ignored.
  guard.onBlur();
  assert.strictEqual(guard.consume(), true);

  // The guard disarms after firing once — a second click is a real click.
  assert.strictEqual(guard.consume(), false);
});

test("createRefocusGuard: a deliberate backdrop click with no prior blur is never swallowed", async () => {
  const { createRefocusGuard } = await import("../lib/dialogDismiss.ts");
  const guard = createRefocusGuard();
  assert.strictEqual(guard.consume(), false);
  assert.strictEqual(guard.consume(), false);
});
