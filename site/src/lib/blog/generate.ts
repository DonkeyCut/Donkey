// One call fills the details of a post from its article: the search copy, the
// tags and keywords, the alt text, and a picture for the header and the
// thumbnail. The text model reads the article and answers with the copy and
// with a description of the picture; the image model paints that description.
// The copy comes back for the editor to look over; the picture is stored the
// way an upload is, so the boxes show it at once.
import { Modality, type GenerateContentParameters } from "@google/genai";
import { z } from "zod";

import {
  defaultGeminiClientFactory,
  geminiApiError,
  geminiCandidateParts,
  geminiCandidates,
  geminiClientConfig,
  stringValue,
} from "@/lib/inference/adapters/gemini-client";
import { geminiModelRoles } from "@/lib/inference/gemini-models";
import { isJsonObject, toJsonValue } from "@/lib/inference/json";
import { InferenceProviderError, type JsonValue } from "@/lib/inference/providers";
import { BLOG_DESCRIPTION_MAX, BLOG_DESCRIPTION_MIN, BLOG_SEO_TITLE_MAX } from "@/lib/blog/schema";

export const TEXT_MODEL = geminiModelRoles.chat;
export const IMAGE_MODEL = geminiModelRoles.imageGeneration;

const SITE_SUFFIX = " | Donkey Cut";

export const blogDetailsSchema = z
  .object({
    seoTitle: z.string().trim().max(200),
    excerpt: z.string().trim().max(400),
    summary: z.string().trim().max(400),
    tags: z.array(z.string().trim().min(1).max(80)).max(30),
    keywords: z.array(z.string().trim().min(1).max(80)).max(30),
    headerAlt: z.string().trim().max(400),
    imagePrompt: z.string().trim().min(1).max(4000),
  })
  .strict();

export type BlogDetails = z.infer<typeof blogDetailsSchema>;

const detailsPrompt = (title: string, article: string) =>
  [
    "You write the details of a post on the Donkey Cut blog. Donkey Cut is a video editor that runs in the browser; its readers edit video and want to do it well.",
    "Read the article and answer with JSON of this exact shape, nothing else:",
    JSON.stringify({
      seoTitle: "string",
      excerpt: "string",
      summary: "string",
      tags: ["string"],
      keywords: ["string"],
      headerAlt: "string",
      imagePrompt: "string",
    }),
    `seoTitle: the title as it appears in a search result, at most ${BLOG_SEO_TITLE_MAX - SITE_SUFFIX.length} characters, leading with the words a reader searches for. The site name is added after it.`,
    `excerpt: the meta description under the search result, ${BLOG_DESCRIPTION_MIN} to ${BLOG_DESCRIPTION_MAX} characters, one or two plain sentences saying what the reader gets.`,
    `summary: the answer-first line shown under the title on the page, ${BLOG_DESCRIPTION_MIN} to ${BLOG_DESCRIPTION_MAX} characters, stating the article's point outright.`,
    "tags: three to five lowercase topic words or short phrases the post files under.",
    "keywords: five to ten search phrases the article answers, most specific first.",
    "headerAlt: one sentence describing the header picture for a reader who cannot see it.",
    "imagePrompt: a description of one picture that stands for the article, for an image model: the subject, the scene, the framing. No text, letters, logos or user interface in the picture.",
    "Write plainly. No marketing words, no exclamation marks, no claims the article does not make.",
    `Title: ${title.trim() || "(untitled)"}`,
    "Article:",
    article,
  ].join("\n\n");

const IMAGE_STYLE =
  "Editorial illustration for a blog post, flat shapes, bold ink outlines, a warm cream background, two or three accent colours, generous negative space. No text, letters, logos or user interface.";

function readJson(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function client() {
  const config = geminiClientConfig(process.env);
  if (!config.configured) {
    throw new InferenceProviderError("Generation is not configured on this deployment.", { statusCode: 500 });
  }
  return defaultGeminiClientFactory(config.options);
}

export type Generated<T> = { value: T; usage: JsonValue };

// The copy and the picture description, read off the article.
export async function generateBlogDetails(title: string, article: string): Promise<Generated<BlogDetails>> {
  let raw: unknown;
  try {
    raw = await client().models.generateContent({
      model: TEXT_MODEL,
      contents: [{ role: "user", parts: [{ text: detailsPrompt(title, article) }] }],
      // JSON mode without a schema; constrained decoding degrades the copy.
      config: { responseMimeType: "application/json" },
    });
  } catch (error) {
    throw geminiApiError("The writing model is unavailable.", error);
  }
  const json = toJsonValue(raw);
  const text = geminiCandidateParts(geminiCandidates(json)[0])
    .map((part) => stringValue(part.text) ?? "")
    .join("");
  const parsed = blogDetailsSchema.safeParse(readJson(text));
  if (!parsed.success) {
    throw new InferenceProviderError("The writing model returned an unreadable answer.", { statusCode: 502 });
  }
  const usage = isJsonObject(json) ? (json.usageMetadata ?? null) : null;
  return { value: parsed.data, usage };
}

// One picture, wide enough for the header; the thumbnail is a crop of it.
export async function generateBlogPicture(imagePrompt: string): Promise<Generated<Buffer>> {
  const params: GenerateContentParameters = {
    model: IMAGE_MODEL,
    contents: [{ role: "user", parts: [{ text: `${imagePrompt}\n\n${IMAGE_STYLE}` }] }],
    config: {
      responseModalities: [Modality.IMAGE, Modality.TEXT],
      imageConfig: { aspectRatio: "16:9", imageSize: "2K" },
    },
  };
  let raw: unknown;
  try {
    raw = await client().models.generateContent(params);
  } catch (error) {
    throw geminiApiError("The image model is unavailable.", error);
  }
  const json = toJsonValue(raw);
  for (const candidate of geminiCandidates(json)) {
    for (const part of geminiCandidateParts(candidate)) {
      const inline = part.inlineData ?? part.inline_data;
      const data = isJsonObject(inline) ? stringValue(inline.data) : undefined;
      if (data) return { value: Buffer.from(data, "base64"), usage: { generationCount: 1 } };
    }
  }
  throw new InferenceProviderError("The image model returned no picture.", { statusCode: 502 });
}
