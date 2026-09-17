import { prisma } from "@/lib/prisma";

/** Whether the account is a super user. On its own so the worker bundle, which
 * needs this for quota checks, never pulls the auth module in with it. */
export async function isDonkeySuperUser(userId: string) {
  const user = await prisma.user.findUnique({ select: { superUser: true }, where: { id: userId } });
  return user?.superUser === true;
}
