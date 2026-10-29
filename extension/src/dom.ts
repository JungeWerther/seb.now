// The element `id`, checked to be a `type`.
export function byId<T extends HTMLElement>(id: string, type: new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`#${id} is not a ${type.name}`);
  return element;
}
