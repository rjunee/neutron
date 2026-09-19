## 2026-09-19 — Make adoption shutdown test ordering deterministic

The shutdown-during-baseline test could lose its intended race: while it polled for an attached child, the 10 ms baseline timer could fire first. That exercised ordinary unobservable-pane cleanup, which correctly closed the pane, instead of shutdown's release-without-close path.

The test now captures only the baseline timer callback, waits until that timer and the child are present, invokes shutdown, then releases the callback. The production timeout and ownership logic are unchanged. Both readable and blank-screen shutdown cases still assert no publication and no pane close. The other cases retain real timers, including the unobservable-pane close and readable-baseline publication checks.
