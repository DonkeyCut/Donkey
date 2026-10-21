/** What one call of each measuring tool reads at most, shared by the tool
 * schemas (AiPanel.tools.ts) and their handlers so the two never disagree.
 * Each bound keeps a call inside the tool bridge's deadline and its result
 * small enough for a model to read whole. */

/** detect_cuts: seconds scanned per call; a longer span resumes from coveredTo. */
export const DETECT_CUTS_SPAN_MAX = 120;
/** detect_cuts: cuts reported per call. */
export const DETECT_CUTS_MAX = 80;
/** detect_cuts: changes inside shots reported per call. */
export const DETECT_CHANGES_MAX = 120;
/** sample_color: regions read per call. */
export const SAMPLE_COLOR_MAX = 24;
/** sample_color: dominant colours per region. */
export const SAMPLE_COLORS_K_MAX = 6;
/** track_element: frames read per call — six seconds of a 60 fps source. */
export const TRACK_FRAMES_MAX = 360;
/** track_element: per-channel distance from the colour that still counts as it. */
export const TRACK_TOLERANCE_DEFAULT = 40;
/** track_element: the element as one connected piece, or every pixel of it. */
export const TRACK_MATCHES = ["shape", "ink"] as const;
/** track_element: path entries listed per call; a longer path is thinned. */
export const TRACK_PATH_MAX = 60;
