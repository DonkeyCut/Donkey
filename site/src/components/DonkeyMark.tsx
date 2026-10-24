import "./donkey-mark.css";

type Props = {
  alt?: string;
  context?: "navigation" | "toolbar";
};

const LIGHTS = ["a-wide", "b-wide", "c-wide", "a", "b", "c"];

/** The original mark in light mode, with the guide's backlight in dark mode. */
export function DonkeyMark({ alt = "", context = "navigation" }: Props) {
  return (
    <span className={`donkey-mark ${context === "toolbar" ? "donkey-mark--toolbar" : ""}`}>
      <span aria-hidden className="donkey-mark__stage hidden dark:block" />
      {LIGHTS.map((light) => (
        <span key={light} aria-hidden className={`donkey-mark__glow donkey-mark__glow--${light} hidden dark:block`} />
      ))}
      <span aria-hidden className="donkey-mark__vignette hidden dark:block" />
      <img src="/donkey-logo.svg" alt={alt} width={264} height={318} className="relative block h-full w-full object-contain dark:hidden" />
      <img src="/donkey-icon.svg" alt={alt} width={264} height={318} className="relative hidden h-full w-full object-contain dark:block" />
    </span>
  );
}
