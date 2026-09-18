import { NextResponse } from "next/server";
import { z } from "zod";

import { noRollupResponse, readRollup, storageProblemResponse } from "@/lib/analytics/read";
import {
  rankUsers,
  USER_SORTS,
  USERS_PAGE_SIZE,
  type AnalyticsUsersPage,
  type UserSort,
} from "@/lib/analytics/rank";
import { withSuperUser } from "@/lib/donkey-api-auth";

// One page of accounts out of the nightly rollup, ranked by the sort the
// caller asked for. The ranking runs here, over the whole window, so a page is
// the top of a real order rather than a slice of an arbitrary one, and the
// dashboard holds the rows it shows instead of every account there is.
//
// `cursor` is the rank offset of the next page. Ranks are only stable within
// one rollup, so the answer carries `generatedAt` and a caller keys its pages
// on it: a new rollup starts a new list.
const sortIds = USER_SORTS.map((sort) => sort.id) as [UserSort, ...UserSort[]];

const querySchema = z.object({
  sort: z.enum(sortIds).default("active"),
  cursor: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(USERS_PAGE_SIZE),
  // A specific account, for a panel that needs one person's row.
  id: z.string().min(1).optional(),
});

export const GET = withSuperUser(async (request) => {
  const params = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!params.success) {
    return NextResponse.json({ error: "Bad query." }, { status: 400 });
  }
  const { cursor, id, limit, sort } = params.data;

  let rollup;
  try {
    rollup = await readRollup();
  } catch (e) {
    return storageProblemResponse(e);
  }
  if (!rollup) return noRollupResponse();

  const ranked = rankUsers(rollup, sort);
  const page = id
    ? ranked.filter((user) => user.id === id)
    : ranked.slice(cursor, cursor + limit);
  const end = cursor + limit;

  const body: AnalyticsUsersPage = {
    generatedAt: rollup.generatedAt,
    nextCursor: id || end >= ranked.length ? null : end,
    pageSize: limit,
    sorts: USER_SORTS,
    total: ranked.length,
    users: page,
  };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
});
