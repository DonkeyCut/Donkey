/** Whether a video element has found it cannot show the file's picture: its
 * metadata loaded with no picture size (Chrome plays a ProRes file's sound
 * and drops the picture), or it refused the source outright (a ProRes file
 * with no sound). A network failure is neither. */
export function showsNoPicture(el: HTMLVideoElement): boolean {
  if (el.error) return el.error.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED;
  return el.readyState >= HTMLMediaElement.HAVE_METADATA && !el.videoWidth;
}
