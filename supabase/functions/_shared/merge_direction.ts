// Which way two entities found to be one Wikidata item merge: the merge keeps
// the one named by the item's label, so "Perzische Golf" folds into "Persian
// Gulf" whichever of the two was linked first; otherwise the holder of the item.

export interface Named {
  id: string;
  name: string;
}

export interface Direction<T extends Named> {
  from: T;
  into: T;
}

const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

export const namedBy = (label: string | null) => (entity: Named) => label !== null && fold(entity.name) === fold(label);

export function mergeDirection<T extends Named>(place: T, holder: T, label: string | null): Direction<T> {
  const isLabel = namedBy(label);
  return isLabel(place) && !isLabel(holder) ? { from: holder, into: place } : { from: place, into: holder };
}
