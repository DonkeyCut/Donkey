// Dates on the blog read as "March 29, 2026" in the reader's language, in UTC
// so the server shell and the browser agree.
export const formatBlogDate = (iso: string, locale: string) =>
  new Date(iso).toLocaleDateString(locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });

export const titleCaseTag = (tag: string) => tag.charAt(0).toUpperCase() + tag.slice(1);
