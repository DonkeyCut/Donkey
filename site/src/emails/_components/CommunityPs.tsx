import { Link, Text } from "react-email";

export const DISCORD_URL = "https://discord.gg/Xv6qGax7sT";
export const GITHUB_URL = "https://github.com/DonkeyUseCorp/Donkey";

// The community links as a P.S. under the sign-off of a personal note.
export function CommunityPs() {
  return (
    <Text className="text-[15px] leading-relaxed">
      P.S.
      <br />
      Discord —{" "}
      <Link href={DISCORD_URL} className="text-[#0F0E0D] underline">
        {DISCORD_URL}
      </Link>
      <br />
      GitHub —{" "}
      <Link href={GITHUB_URL} className="text-[#0F0E0D] underline">
        {GITHUB_URL}
      </Link>
    </Text>
  );
}
