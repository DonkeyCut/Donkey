import { PillButton } from "@/app/_components/landing/LandingPrimitives";

// The call to action an article can drop in with <BlogCTA /> or <InlineCTA />.
// Copy and target default to the product; a post can override any of them.
export type BlogCtaProps = {
  variant?: "inline" | "banner";
  title?: string;
  description?: string;
  buttonText?: string;
  buttonHref?: string;
};

export const CTA_DEFAULTS = {
  title: "Edit your next video with Donkey Cut",
  description:
    "A free, open source video editor. Edit with chat, generate video, images, voiceovers and music, and keep your projects on your own machine.",
  buttonText: "Open Donkey Cut",
  buttonHref: "/app",
};

export function BlogCTA({
  variant = "inline",
  title = CTA_DEFAULTS.title,
  description = CTA_DEFAULTS.description,
  buttonText = CTA_DEFAULTS.buttonText,
  buttonHref = CTA_DEFAULTS.buttonHref,
}: BlogCtaProps) {
  if (variant === "banner") {
    return (
      <div className="not-prose my-10 rounded-2xl border-2 border-ink bg-cream p-8 text-center md:p-10">
        <h2 className="mb-3 text-2xl font-semibold text-ink md:text-3xl">{title}</h2>
        <p className="mx-auto mb-6 max-w-2xl text-base leading-relaxed text-[#454545] md:text-lg">{description}</p>
        <PillButton href={buttonHref} size="lg">
          {buttonText}
        </PillButton>
      </div>
    );
  }
  return (
    <div className="not-prose my-8 rounded-2xl border-2 border-ink bg-cream p-6 md:p-8">
      <h3 className="mb-2 text-lg font-semibold text-ink">{title}</h3>
      <p className="mb-4 text-base leading-relaxed text-[#454545]">{description}</p>
      <PillButton href={buttonHref}>{buttonText}</PillButton>
    </div>
  );
}

export function InlineCTA() {
  return <BlogCTA variant="inline" />;
}
