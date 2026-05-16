import type { Poll, PollOption, PollVote } from "../schema";

export function serializePoll(
  poll: Pick<Poll, "id" | "expires" | "multiple" | "votersCount"> & {
    options: Pick<PollOption, "index" | "title" | "votesCount">[];
    votes: Pick<PollVote, "accountId" | "optionIndex">[];
  },
  currentAccountOwner: { id: string } | undefined | null,
  // oxlint-disable-next-line typescript/no-explicit-any
): Record<string, any> {
  return {
    id: poll.id,
    expires_at: poll.expires.toISOString(),
    expired: poll.expires <= new Date(),
    multiple: poll.multiple,
    votes_count: poll.options.reduce(
      (acc, option) => acc + option.votesCount,
      0,
    ),
    voters_count: poll.multiple ? poll.votersCount : null,
    voted:
      currentAccountOwner != null &&
      poll.votes.some((v) => v.accountId === currentAccountOwner.id),
    own_votes:
      currentAccountOwner == null
        ? []
        : poll.votes
            .filter((v) => v.accountId === currentAccountOwner.id)
            .map((v) => v.optionIndex),
    options: poll.options
      .toSorted((a, b) => (a.index < b.index ? -1 : 1))
      .map(serializePollOption),
    emojis: [], // TODO
  };
}

// oxlint-disable-next-line typescript/no-explicit-any
export function serializePollOption(
  option: Pick<PollOption, "title" | "votesCount">,
): Record<string, any> {
  return {
    title: option.title,
    votes_count: option.votesCount,
  };
}
