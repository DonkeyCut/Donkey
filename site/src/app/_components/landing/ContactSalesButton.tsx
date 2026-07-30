"use client";

import type { ReactNode } from "react";

type Props = {
  children: ReactNode;
  className: string;
};

const contactEmail = "hello@donkeycut.com";
const contactSubject = "Donkey Vision API";

export function ContactSalesButton({ children, className }: Props) {
  const handleClick = () => {
    const gmailURL = new URL("https://mail.google.com/mail/");
    gmailURL.searchParams.set("view", "cm");
    gmailURL.searchParams.set("fs", "1");
    gmailURL.searchParams.set("to", contactEmail);
    gmailURL.searchParams.set("su", contactSubject);

    const opened = window.open(gmailURL.toString(), "_blank", "noopener,noreferrer");
    if (!opened) {
      window.location.href = `mailto:${contactEmail}?subject=${encodeURIComponent(contactSubject)}`;
    }
  };

  return (
    <button className={className} onClick={handleClick} type="button">
      {children}
    </button>
  );
}
