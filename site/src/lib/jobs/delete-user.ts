import Stripe from "stripe";
import { z } from "zod";

import { deleteLibraryAssetCascade } from "@/cut/server/cloud/library";
import { deleteProjectCascade } from "@/cut/server/cloud/projects";
import { deletePrefix, INFERENCE_PREFIX, R2NotConfiguredError } from "@/cut/server/cloud/r2";
import { getStripe, StripeNotConfiguredError } from "@/lib/billing/stripe";
import { getResend, isResendConfigured } from "@/lib/email/resend";
import { defineJob, JobFailure } from "@/lib/jobs/registry";
import { prisma } from "@/lib/prisma";

// Deletes an account and everything it owns. Order matters: the Stripe
// customer goes first (deleting it cancels any live subscription, so a crash
// mid-job can never leave a paying customer with no account), then the Resend
// contact, then the Cut cloud content — per-project and per-asset cascades,
// which also clear R2 objects and HLS ladder records — then the user-keyed
// rows that carry no foreign key, an R2 sweep of anything left under the
// user's prefixes, and finally the user row, whose FK cascades take sessions,
// accounts, credits, billing, onboarding, and email settings. Every step is
// idempotent, so a queue redelivery resumes where the last attempt stopped.
export const deleteUserJob = defineJob(
  z.object({ email: z.string().trim().email() }),
  async ({ email }) => {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) throw new JobFailure("No user with that email.");
    if (user.superUser) throw new JobFailure("Refusing to delete a super user.");

    if (user.stripeCustomerId) {
      try {
        await getStripe().customers.del(user.stripeCustomerId);
      } catch (e) {
        const alreadyGone =
          e instanceof Stripe.errors.StripeError && e.code === "resource_missing";
        if (!alreadyGone && !(e instanceof StripeNotConfiguredError)) throw e;
      }
    }

    if (isResendConfigured()) {
      const removed = await getResend().contacts.remove({ email: user.email });
      if (removed.error && removed.error.name !== "not_found") {
        throw new Error(
          `Resend contact remove failed: ${removed.error.name}: ${removed.error.message}`,
        );
      }
    }

    const projects = await prisma.cutProject.findMany({
      where: { userId: user.id },
      select: { id: true },
    });
    for (const project of projects) {
      await deleteProjectCascade(user.id, project.id);
    }
    const assets = await prisma.cutLibraryAsset.findMany({
      where: { userId: user.id },
      select: { id: true },
    });
    for (const asset of assets) {
      await deleteLibraryAssetCascade(user.id, asset.id);
    }

    // What the cascades don't reach: renders and copies, media rows orphaned
    // from any project, shares of already-gone projects, templates, folders,
    // feature flags, the storage counter, and any waitlist entry under the
    // same address.
    await prisma.$transaction([
      prisma.cutRenderJob.deleteMany({ where: { userId: user.id } }),
      prisma.cutCopyJob.deleteMany({ where: { userId: user.id } }),
      prisma.cutChatThread.deleteMany({ where: { userId: user.id } }),
      prisma.cutMediaObject.deleteMany({ where: { userId: user.id } }),
      prisma.cutProjectShare.deleteMany({ where: { userId: user.id } }),
      prisma.cutLibraryAsset.deleteMany({ where: { userId: user.id } }),
      prisma.cutTemplate.deleteMany({ where: { userId: user.id } }),
      prisma.cutFolder.deleteMany({ where: { userId: user.id } }),
      prisma.cutStorageUsage.deleteMany({ where: { userId: user.id } }),
      prisma.userFeatureFlag.deleteMany({ where: { userId: user.id } }),
      prisma.waitlistEntry.deleteMany({ where: { email: user.email } }),
    ]);

    // Sweep whatever object the row-driven deletes missed — exports, previews,
    // cards, and the inference scratch that lives outside the user prefix.
    let r2Objects = 0;
    try {
      r2Objects += await deletePrefix(`cut/${user.id}/`);
      r2Objects += await deletePrefix(`${INFERENCE_PREFIX}${user.id}/`);
    } catch (e) {
      if (!(e instanceof R2NotConfiguredError)) throw e;
    }

    await prisma.user.delete({ where: { id: user.id } });

    return {
      email: user.email,
      userId: user.id,
      projects: projects.length,
      libraryAssets: assets.length,
      r2Objects,
    };
  },
);
