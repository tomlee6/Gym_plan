import { useEffect } from 'react';

export function useTitle(title) {
  useEffect(() => {
    if (title) document.title = `${title} · Flex Gym Scan`;
  }, [title]);
}
