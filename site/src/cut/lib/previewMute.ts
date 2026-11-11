// The preview's master mute: the whole mix plays silent while the picture
// keeps playing. Only a template's page offers it, and leaving the page lifts
// it, so the editor always plays with sound.

import { create } from "zustand";

export const usePreviewMute = create<{ muted: boolean }>(() => ({ muted: false }));

export const setPreviewMuted = (muted: boolean) => usePreviewMute.setState({ muted });
