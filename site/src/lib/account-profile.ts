import { prisma } from "@/lib/prisma";

// The account as the product shows it, shared by every route that hands the
// profile back so the name and picture can't drift between them.
//
// `name` stays whatever the identity provider gave us at sign-in; `displayName`
// is the one the user chose. The picture is the uploaded one when there is one,
// addressed by a URL stamped with its `updatedAt` so a new upload busts the
// browser's cache, and the provider's hotlinked image otherwise.
export async function accountProfile(userId: string) {
  const [user, avatar] = await Promise.all([
    prisma.user.findUnique({
      select: { displayName: true, email: true, image: true, name: true },
      where: { id: userId },
    }),
    prisma.userAvatar.findUnique({
      select: { updatedAt: true },
      where: { userId },
    }),
  ]);
  if (!user) return null;

  return {
    displayName: user.displayName,
    email: user.email,
    image: avatar ? `/api/account/avatar?v=${avatar.updatedAt.getTime()}` : user.image,
    name: user.name,
  };
}
