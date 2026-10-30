/**
 * How a /visualize form sits on the canvas while someone handles it: turned, moved and zoomed
 * by hand, then gliding back to its anchor with the slow spin easing back in. Pure, with no
 * rendering, so the return and the resume are tested directly. Zoom stays where it was put.
 */
export type FormPose = { yaw: number; pitch: number; panX: number; panY: number; zoom: number; zoomTarget: number; spin: number };

/** The resting spin, radians a second. */
export const FORM_SPIN = 0.32;
const MAX_PITCH = 1.3;
const MAX_FLICK = 4;
const MAX_PAN = 2.5;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3.5;

export function initialFormPose(): FormPose {
  return { yaw: 0, pitch: 0, panX: 0, panY: 0, zoom: 1, zoomTarget: 1, spin: FORM_SPIN };
}

/** A drag turns the form; the speed of the drag carries over as a flick when it is let go. */
export function rotateForm(pose: FormPose, deltaX: number, deltaY: number, seconds: number) {
  const turn = deltaX * 0.008;
  pose.yaw += turn;
  pose.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pose.pitch + deltaY * 0.008));
  if (seconds > 0) pose.spin = Math.max(-MAX_FLICK, Math.min(MAX_FLICK, turn / seconds));
}

export function moveForm(pose: FormPose, worldX: number, worldY: number) {
  pose.panX = Math.max(-MAX_PAN, Math.min(MAX_PAN, pose.panX + worldX));
  pose.panY = Math.max(-MAX_PAN, Math.min(MAX_PAN, pose.panY + worldY));
}

export function zoomForm(pose: FormPose, factor: number) {
  pose.zoomTarget = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, pose.zoomTarget * factor));
}

/**
 * One frame. While held, the form stays exactly where the hand has it. Once let go, it returns
 * to its anchor and upright, and any flick decays into the normal slow spin.
 */
export function stepFormPose(pose: FormPose, seconds: number, held: boolean) {
  pose.zoom += (pose.zoomTarget - pose.zoom) * (1 - Math.exp(-seconds * 9));
  if (held) return;
  const settle = Math.exp(-seconds * 3);
  pose.panX *= settle;
  pose.panY *= settle;
  pose.pitch *= Math.exp(-seconds * 1.8);
  pose.spin += (FORM_SPIN - pose.spin) * (1 - Math.exp(-seconds * 1.2));
  pose.yaw += pose.spin * seconds;
}
