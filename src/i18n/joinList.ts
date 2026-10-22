/** "1, 2, 5" with the locale's last separator from the dictionary (French: "1, 2 et 5"). */
export function joinList(items: readonly (string | number)[], sep: string, last: string): string {
  if (items.length < 2) return items.join(sep);
  return items.slice(0, -1).join(sep) + last + String(items[items.length - 1]);
}
