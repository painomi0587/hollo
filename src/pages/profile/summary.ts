import type { Post } from "../../schema.ts";

const SUMMARY_MAX_LENGTH = 30;

export function summarizePostForTitle(
  post: Pick<Post, "summary" | "content">,
): string {
  if (post.summary) return post.summary;
  const content = post.content ?? "";
  if (content.length > SUMMARY_MAX_LENGTH) {
    return `${content.substring(0, SUMMARY_MAX_LENGTH)}…`;
  }
  return content;
}
