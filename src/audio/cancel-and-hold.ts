/**
 * Cancel a gain's pending automation while pinning the value the curve has at
 * `when`, so a following release ramp starts from the audible level.
 *
 * Anchoring with `setValueAtTime(param.value, when)` instead snaps a mid-fade
 * voice back up to its sustain or attack value — an audible pop on seeks,
 * voice steals, and pedal changes during a release. The native
 * AudioParam.cancelAndHoldAtTime pins the curve value exactly; engines
 * without it (Firefox) fall back to the current computed value, which is
 * exact whenever `when` is at or near "now" and never jumps above what the
 * listener is currently hearing.
 */
export function cancelAndHoldAutomation(param: AudioParam, when: number, floor: number): void {
  const holdable = param as AudioParam & { cancelAndHoldAtTime?: (time: number) => AudioParam };
  if (typeof holdable.cancelAndHoldAtTime === 'function') {
    holdable.cancelAndHoldAtTime(when);
    return;
  }
  const pinned = Math.max(floor, param.value);
  param.cancelScheduledValues(when);
  param.setValueAtTime(pinned, when);
}
