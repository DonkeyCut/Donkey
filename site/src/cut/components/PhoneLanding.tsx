"use client";

import { usePhoneLanding } from "@/cut/hooks/usePhoneDrops";

/** App-wide: files sent from a phone to the Library land on whatever page is open. */
export function PhoneLanding() {
  usePhoneLanding();
  return null;
}
