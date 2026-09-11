// The FAQ structured data comes from the article itself: a "## FAQs" section
// whose "###" headings are the questions and the prose under each is the
// answer. Nothing else about the body is parsed here.

export type BlogFaqItem = { question: string; answer: string };

export const mdxToText = (value: string) =>
  value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/<\/?[^>]+>/g, " ")
    .replace(/^>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/[*_~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export function extractFaqItems(source: string): BlogFaqItem[] {
  const items: BlogFaqItem[] = [];
  let inFaq = false;
  let question: string | null = null;
  let answerLines: string[] = [];

  const flush = () => {
    if (!question) return;
    const answer = mdxToText(answerLines.join("\n"));
    if (answer.length > 0) items.push({ question, answer });
    question = null;
    answerLines = [];
  };

  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!inFaq) {
      if (/^##\s+FAQs?\b/i.test(line)) inFaq = true;
      continue;
    }
    if (/^##\s+/.test(line)) {
      flush();
      break;
    }
    const heading = line.match(/^###\s+(.+)/);
    if (heading) {
      flush();
      question = mdxToText(heading[1] ?? "");
      continue;
    }
    if (question) answerLines.push(raw);
  }
  flush();
  return items;
}
