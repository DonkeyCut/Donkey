import { DONKEYCUT_CANONICAL } from "@/cut/lib/hosts";

export const GITHUB_REPO_URL = "https://github.com/DonkeyUseCorp/Donkey";
// The install page lives on donkeycut.com only, so landing CTAs link absolute.
export const DONKEY_INSTALL_URL = `${DONKEYCUT_CANONICAL}/install`;
export const DONKEY_LATEST_VERSION = "0.1.143";
export const DONKEY_LATEST_RELEASE_TAG = `v${DONKEY_LATEST_VERSION}`;
export const DONKEY_DOWNLOAD_URL = `${GITHUB_REPO_URL}/releases/download/${DONKEY_LATEST_RELEASE_TAG}/Donkey.dmg`;
