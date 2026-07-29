import Link from "next/link";

import { ContactSalesButton } from "@/app/_components/landing/ContactSalesButton";

const planFeatures = [
  "5,000 API calls per month",
  "3 requests per second",
  "Detect UI elements, boxes, center points, and labels",
  "Prompt-to-click targeting for actions like “click the play button”",
];

export function PricingSection() {
  return (
    <section className="bg-[#0F0E0D] text-white" id="contact">
      <div className="mx-auto grid w-full max-w-[1400px] gap-8 px-6 py-20 md:grid-cols-[1fr_auto] md:px-12">
        <div>
          <h2 className="text-4xl font-semibold leading-none md:text-6xl">
            Get Donkey Vision API access.
          </h2>
          <p className="mt-4 text-xl font-semibold text-[#EC7868] md:text-2xl">
            Starts at $50/month
          </p>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-white/75">
            Start detecting clickable elements from screenshots in minutes.
            Donkey Vision returns UI boxes, center points, labels, and
            prompt-matched click targets for computer-use agents.
          </p>
          <ul className="mt-8 grid max-w-2xl gap-2 text-base text-white/85 sm:grid-cols-2">
            {planFeatures.map((feature) => (
              <li key={feature} className="flex gap-2">
                <span aria-hidden="true" className="leading-6 text-[#EC7868]">
                  ●
                </span>
                {feature}
              </li>
            ))}
          </ul>
          <p className="mt-24 text-sm leading-6 text-white/55">
            Need higher call volume or rate limits?{" "}
            <ContactSalesButton className="font-semibold text-white/80 underline underline-offset-2 transition hover:text-white">
              Contact us 
            </ContactSalesButton>{" "}
            for increased limits.
          </p>
        </div>
        <div className="flex flex-col justify-center md:w-60">
          <Link
            href="/donkeyvision/settings"
            className="flex min-h-14 w-full items-center justify-center gap-2 rounded-full bg-[#EC7868] px-7 text-base font-semibold text-[#0F0E0D] transition hover:-translate-y-0.5"
          >
            Start building
          </Link>
        </div>
      </div>
    </section>
  );
}
