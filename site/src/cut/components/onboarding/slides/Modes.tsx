"use client";

import { Cloud, Laptop } from "lucide-react";

export function ModesSlide() {
  return (
    <div className="mx-auto w-full max-w-[880px]">
      <h2 className="text-center text-[clamp(26px,3.4vw,36px)] leading-[1.1] font-semibold tracking-[-0.02em]">
        Two places to work
      </h2>
      <p className="mx-auto mt-3 max-w-[560px] text-center text-[16px] leading-[1.5] text-[#454545]">
        Donkey Cut edits in the cloud or on your own machine, and the editor is
        the same either way.
      </p>

      <div className="mt-9 grid gap-4 md:grid-cols-2">
        <Mode
          icon={<Cloud className="size-5" />}
          title="In the cloud"
          points={[
            "Any browser, any OS, nothing to install",
            "Projects and media stored for you",
            "Exports rendered by our workers",
          ]}
        />
        <Mode
          icon={<Laptop className="size-5" />}
          title="On your Mac"
          points={[
            "The Donkey app, macOS only",
            "Footage stays in your own file system",
            "Free on-device speech-to-text, and exports on your hardware",
          ]}
        />
      </div>

      <p className="mx-auto mt-7 max-w-[560px] text-center text-[15px] leading-[1.5] text-[#454545]">
        Nothing to choose now. Donkey Cut works locally whenever the Mac app is
        running and in the cloud when it isn&apos;t — each project remembers
        where it lives, and you can move between them any time.
      </p>
    </div>
  );
}

function Mode({
  icon,
  title,
  points,
}: {
  icon: React.ReactNode;
  title: string;
  points: string[];
}) {
  return (
    <div className="rounded-2xl border border-ink/10 bg-white p-6">
      <div className="flex items-center gap-2.5">
        <span className="grid size-9 place-items-center rounded-lg bg-ink/5">
          {icon}
        </span>
        <h3 className="text-[17px] font-semibold">{title}</h3>
      </div>
      <ul className="mt-4 flex flex-col gap-2.5">
        {points.map((point) => (
          <li
            key={point}
            className="flex gap-2.5 text-[14.5px] leading-[1.45] text-[#454545]"
          >
            <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-coral" />
            {point}
          </li>
        ))}
      </ul>
    </div>
  );
}
