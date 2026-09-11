import { Suspense } from "react";

import { PostEditorPage } from "@/app/su/blog/[id]/PostEditorPage";
import { SuStandIn } from "@/app/su/SuStandIn";

// The post id is in the URL, so it is request data: it resolves inside this
// boundary and the editor mounts with it. The section shell (rail, header)
// reads the URL too, so this segment is allowed to block on the server.
export const instant = false;

export default function SuBlogPostPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<SuStandIn />}>
      {params.then(({ id }) => (
        <PostEditorPage id={id} />
      ))}
    </Suspense>
  );
}
