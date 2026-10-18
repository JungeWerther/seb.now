// The entity-index snapshot's format, version 1 (built by index-snapshot,
// decoded by the page script's `decodeIndexSnapshot`; keep the two in sync).
//
//   v        1
//   gen      index_state.gen it was built at
//   wm       {l, e, p, c}: the highest links / entities / link_entities seq it
//            covers, and the highest index_changes seq (snapshots built before
//            20261018000300_index_changes.sql have no `c`)
//   kinds    [[kind_path, kind], ...]: an entity's kind is its position here
//   entities {seq, name, kind}: parallel arrays, by seq; `seq` delta-encoded
//            (the first value as is, then each the difference from the one before)
//   links    {seq, minute, entities}: parallel arrays, by seq, only links some
//            entity is mentioned in; `seq` delta-encoded, `minute` the link's
//            created_at in whole minutes since the epoch, `entities` each link's
//            entity seqs, ascending and delta-encoded the same way
//
// Deltas turn the long, mostly increasing id lists into small numbers, which is
// most of what gzip saves here.

export interface RawSnapshot {
  v: number;
  gen: number;
  wm: { l: number; e: number; p: number; c?: number };
  kinds: [string, string][];
  entities: { seq: number[]; name: string[]; kind: number[] };
  links: { seq: number[]; minute: number[]; entities: number[][] };
}

export type Snapshot = RawSnapshot;

export function deltas(values: number[]): number[] {
  return values.map((v, i) => (i === 0 ? v : v - values[i - 1]));
}

export function undeltas(values: number[]): number[] {
  const out: number[] = [];
  for (const v of values) out.push(out.length ? out[out.length - 1] + v : v);
  return out;
}

// The function's RPC result (absolute seqs) as the stored format.
export function encodeSnapshot(raw: RawSnapshot): Snapshot {
  return {
    ...raw,
    entities: { ...raw.entities, seq: deltas(raw.entities.seq) },
    links: {
      seq: deltas(raw.links.seq),
      minute: raw.links.minute,
      entities: raw.links.entities.map((seqs) => deltas([...seqs].sort((a, b) => a - b))),
    },
  };
}

export function decodeSnapshot(snapshot: Snapshot): RawSnapshot {
  return {
    ...snapshot,
    entities: { ...snapshot.entities, seq: undeltas(snapshot.entities.seq) },
    links: {
      seq: undeltas(snapshot.links.seq),
      minute: snapshot.links.minute,
      entities: snapshot.links.entities.map(undeltas),
    },
  };
}
