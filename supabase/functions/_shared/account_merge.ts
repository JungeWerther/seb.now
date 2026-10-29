// Which two sessions a merge folds together (account-merge,
// 20261029120000_accounts.sql): the caller's own, a real account, and the
// anonymous one the same browser held before signing in, whose token proves
// the caller owns it. Pure, so the rules are tested without a database.

export type SessionUser = { id: string; is_anonymous?: boolean | null };

export type MergePlan = { from: string; into: string };

// Why a pair can't merge, with the HTTP status it answers; null when it can.
export type MergeRefusal = { status: number; error: string };

const refusals: ReadonlyArray<[(anon: SessionUser, account: SessionUser) => boolean, MergeRefusal]> = [
  [(_, account) => account.is_anonymous !== false, { status: 403, error: "sign in before merging" }],
  [(anon) => anon.is_anonymous !== true, { status: 409, error: "only an anonymous session can be merged" }],
  [(anon, account) => anon.id === account.id, { status: 409, error: "that session is already this account" }],
];

export function mergeRefusal(anon: SessionUser, account: SessionUser): MergeRefusal | null {
  return refusals.find(([refuses]) => refuses(anon, account))?.[1] ?? null;
}

export const mergePlan = (anon: SessionUser, account: SessionUser): MergePlan => ({ from: anon.id, into: account.id });

// The bearer token of an Authorization header, or null.
export function bearer(header: string | null): string | null {
  return /^Bearer\s+(\S+)$/i.exec(header ?? "")?.[1] ?? null;
}
