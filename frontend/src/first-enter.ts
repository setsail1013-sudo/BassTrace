import { useState } from 'react';

const seen = new Set<string>();

/** True only for the first mount of this id in the page session. */
export function useFirstEnter(id: string) {
  const [enter] = useState(() => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return enter;
}
