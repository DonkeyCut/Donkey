// The shutter a newly switched-on motion blur starts at, as a share of a 30fps
// frame: 0.5 is the half-open shutter of most filmed footage. The value is
// written onto the item when the blur is switched on, so every renderer draws
// from the item alone.
export const CUT_MOTION = { motionBlur: 0.5 };
