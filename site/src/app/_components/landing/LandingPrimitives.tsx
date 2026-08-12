import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

import { BLACK, CARD, CORAL, type CardColor } from "@/app/_components/landing/theme";

// Internal routes use next/link for client-side navigation; anything else
// (http(s), mailto, etc.) falls back to a plain anchor.
function isInternalHref(href: string) {
  return href.startsWith("/") && !href.startsWith("//");
}

// The auth pages (/sign-in, /sign-up) are proxy passthrough routes that live
// outside the "/" → "/cut" rewrite the proxy uses to serve the landing on
// donkeycut.com. App Router soft-navigation can't cross that rewrite boundary —
// a next/link click flips the URL but never renders the auth screen — so links
// to these routes must be plain anchors that trigger a full-page navigation.
function isAuthPassthroughHref(href: string) {
  return href.startsWith("/sign-in") || href.startsWith("/sign-up");
}

type ButtonVariant = "primary" | "dark" | "secondary";
type ButtonSize = "sm" | "md" | "lg";

type TapedCardProps = {
  children: ReactNode;
  color?: CardColor;
  fill?: boolean;
  shadowColor?: CardColor;
  style?: CSSProperties;
  tapeColor?: CardColor;
  tapePosition?: "left" | "right" | "center";
  // Opt-in hook for animating the tape. The tape's resting tilt and centering
  // live in the individual `rotate` / `translate` properties rather than one
  // `transform`, so a class can animate the tilt alone and leave the rest.
  tapeClassName?: string;
};

export function TapedCard({
  children,
  color = "blue",
  fill = false,
  shadowColor,
  style,
  tapeColor,
  tapeClassName,
  tapePosition = "left",
}: TapedCardProps) {
  const tapeSide =
    tapePosition === "left"
      ? { left: 32 }
      : tapePosition === "right"
        ? { right: 32 }
        : { left: "50%" };
  const tapeTranslate = tapePosition === "center" ? "-50% 0" : undefined;

  return (
    <div
      style={{
        boxSizing: "border-box",
        minWidth: 0,
        position: "relative",
        ...(fill ? { height: "100%" } : null),
        ...style,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          transform: "translate(6px, 6px)",
          borderRadius: 16,
          background: shadowColor ? CARD[shadowColor] : BLACK,
        }}
      />
      <div
        style={{
          position: "relative",
          boxSizing: "border-box",
          borderRadius: 16,
          border: `2px solid ${BLACK}`,
          background: CARD[color],
          ...(fill ? { height: "100%" } : null),
        }}
      >
        {tapeColor ? (
          <div
            className={tapeClassName}
            style={{
              position: "absolute",
              top: -10,
              width: 60,
              height: 18,
              borderRadius: 3,
              border: `2px solid ${BLACK}`,
              background: CARD[tapeColor],
              boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
              rotate: "-2deg",
              translate: tapeTranslate,
              ...tapeSide,
            }}
          />
        ) : null}
        {children}
      </div>
    </div>
  );
}

type PillButtonProps = {
  ariaLabel?: string;
  children: ReactNode;
  disabled?: boolean;
  href?: string;
  onClick?: () => void | Promise<void>;
  size?: ButtonSize;
  variant?: ButtonVariant;
};

export function PillButton({
  ariaLabel,
  children,
  disabled = false,
  href,
  onClick,
  size = "md",
  variant = "primary",
}: PillButtonProps) {
  const sizes: Record<ButtonSize, CSSProperties> = {
    sm: { padding: "8px 16px", fontSize: 14 },
    md: { padding: "12px 20px", fontSize: 15 },
    lg: { padding: "16px 28px", fontSize: 16 },
  };
  const variants: Record<ButtonVariant, CSSProperties> = {
    primary: {
      background: CORAL,
      color: BLACK,
      border: `2px solid ${BLACK}`,
    },
    dark: { background: BLACK, color: "#fff", border: `2px solid ${BLACK}` },
    secondary: {
      background: "#fff",
      color: BLACK,
      border: `2px solid ${BLACK}`,
    },
  };
  const sharedStyle: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 999,
    fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer",
    minHeight: size === "lg" ? 56 : 40,
    opacity: disabled ? 0.65 : 1,
    textDecoration: "none",
    whiteSpace: "nowrap",
    transition: "transform 0.15s ease, opacity 0.15s ease",
    ...sizes[size],
    ...variants[variant],
  };

  if (href && !disabled) {
    if (isInternalHref(href) && !isAuthPassthroughHref(href)) {
      return (
        <Link aria-label={ariaLabel} href={href} onClick={onClick} style={sharedStyle}>
          {children}
        </Link>
      );
    }

    return (
      <a aria-label={ariaLabel} href={href} onClick={onClick} style={sharedStyle}>
        {children}
      </a>
    );
  }

  return (
    <button
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      style={sharedStyle}
      type="button"
    >
      {children}
    </button>
  );
}

type SectionLabelProps = {
  children: ReactNode;
  number: number;
};

export function SectionLabel({ children, number }: SectionLabelProps) {
  const display = String(number);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: 13,
        fontWeight: 600,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        marginBottom: 24,
      }}
    >
      <span style={{ fontSize: 18, lineHeight: 1 }}>{display}.</span>
      <span>{children}</span>
    </div>
  );
}

type NumberBadgeProps = {
  color: CardColor;
  n: number;
};

export function NumberBadge({ color, n }: NumberBadgeProps) {
  return (
    <div
      style={{
        width: 56,
        height: 56,
        borderRadius: 12,
        border: `2px solid ${BLACK}`,
        background: CARD[color],
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 600,
        fontSize: 22,
        flexShrink: 0,
      }}
    >
      {String(n).padStart(2, "0")}
    </div>
  );
}

type HeadlineProps = {
  children: ReactNode;
  size?: "xl" | "lg";
};

export function Headline({ children, size = "xl" }: HeadlineProps) {
  const sizes: Record<NonNullable<HeadlineProps["size"]>, string> = {
    xl: "clamp(44px, 7vw, 80px)",
    lg: "clamp(36px, 5.5vw, 64px)",
  };

  return (
    <h2
      style={{
        fontWeight: 600,
        lineHeight: 0.95,
        fontSize: sizes[size],
        margin: 0,
      }}
    >
      {children}
    </h2>
  );
}
